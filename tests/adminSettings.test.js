// The settings API (time zone, backup schedule) and the backup endpoints: admin session only, validated, audited.
const KEY = 'e'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const apiKeys = require('../services/apiKeys');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const ENDPOINTS = [
    ['get', '/admin/api/settings'],
    ['put', '/admin/api/settings'],
    ['post', '/admin/api/settings/backup-dir/test'],
    ['get', '/admin/api/backups'],
    ['post', '/admin/api/backups'],
    ['post', '/admin/api/backups/verify'],
];

describe('settings API: access', () => {
    test('every endpoint needs an admin session (and the header for changes); a hub API key is no admin', async () => {
        const hubKey = apiKeys.create(db.get(), { name: 'ha', scopes: '*' }).key;
        for (const [m, url] of ENDPOINTS) {
            // no session: a change without the header is stopped at 403 before the session check, a read at 401
            await request(app)[m](url).send({}).expect(m === 'get' ? 401 : 403);
            await request(app)[m](url).set(H).send({}).expect(401);
            await request(app)[m](url).set('Authorization', `Bearer ${hubKey}`).set('X-API-Key', hubKey).set(H).send({}).expect(401);
            if (m !== 'get') await agent[m](url).send({}).expect(403); // session but no X-Requested-With
        }
    });
});

describe('settings API: read and write', () => {
    test('GET gives the defaults, the status and the schedule in words', async () => {
        const r = (await agent.get('/admin/api/settings').expect(200)).body;
        expect(r.settings).toEqual({ timezone: 'America/Chicago', backup: { enabled: true, dir: null, every_hours: 24, keep: 7, verify_after: true } });
        expect(r.status.schedule).toBe('every 24 h, keep 7');
        expect(r.custom).toEqual([]);
    });

    test('PUT is partial, saves valid fields, audits key and old/new values', async () => {
        const r = (await agent.put('/admin/api/settings').set(H).send({ timezone: 'Asia/Kathmandu', backup: { every_hours: 6, keep: 10 } }).expect(200)).body;
        expect(r.changed.sort()).toEqual(['backup.every_hours', 'backup.keep', 'timezone']);
        expect(r.settings.timezone).toBe('Asia/Kathmandu');
        expect(r.settings.backup).toMatchObject({ every_hours: 6, keep: 10, enabled: true });
        const rows = audit.recent(db.get(), 10, { actions: ['setting_changed'] });
        expect(rows.map((x) => x.detail).sort((a, b) => (a.key < b.key ? -1 : 1))).toEqual([
            { key: 'backup.every_hours', from: 24, to: 6 },
            { key: 'backup.keep', from: 7, to: 10 },
            { key: 'timezone', from: 'America/Chicago', to: 'Asia/Kathmandu' },
        ]);
        // saving the same values again changes nothing and writes no audit row
        await agent.put('/admin/api/settings').set(H).send({ timezone: 'Asia/Kathmandu' }).expect(200);
        expect(audit.recent(db.get(), 10, { actions: ['setting_changed'] })).toHaveLength(3);
        await agent.put('/admin/api/settings').set(H).send({ timezone: 'America/Chicago', backup: { every_hours: 24, keep: 7 } }).expect(200);
    });

    test('a bad field is a 400 with a plain message and saves nothing', async () => {
        const bad = [
            [{ timezone: 'Mars/Base' }, /time zone/, 'timezone'],
            [{ timezone: 42 }, /time zone/, 'timezone'],
            [{ backup: { every_hours: 0 } }, /1 to 168/, 'backup.every_hours'],
            [{ backup: { every_hours: 169 } }, /1 to 168/, 'backup.every_hours'],
            [{ backup: { keep: 0 } }, /1 to 90/, 'backup.keep'],
            [{ backup: { keep: 'many' } }, /1 to 90/, 'backup.keep'],
            [{ backup: { enabled: 'maybe' } }, /true or false/, 'backup.enabled'],
            [{ backup: { dir: 'relative/path' } }, /absolute/, undefined],
            [{ backup: { dir: '/proc/x' } }, /system folder/, undefined],
            [{ backup: { nope: 1 } }, /Unknown backup setting/, 'backup.nope'],
            [{ colour: 'red' }, /Unknown setting/, 'colour'],
            [{ last_backup_error: 'x' }, /Unknown setting/, 'last_backup_error'],
            [{}, /Nothing to change/, undefined],
        ];
        for (const [body, re, field] of bad) {
            const r = (await agent.put('/admin/api/settings').set(H).send(body).expect(400)).body;
            expect(r.error).toMatch(re);
            if (field) expect(r.field).toBe(field);
        }
        // one bad field among good ones: nothing is saved
        await agent.put('/admin/api/settings').set(H).send({ timezone: 'Asia/Tokyo', backup: { keep: 0 } }).expect(400);
        expect((await agent.get('/admin/api/settings')).body.settings.timezone).toBe('America/Chicago');
    });

    test('settings are never reachable over /hub or MCP', async () => {
        const hubKey = apiKeys.create(db.get(), { name: 'all', scopes: '*' }).key;
        for (const url of ['/hub/settings', '/hub/backups', '/hub/v1/settings']) {
            const r = await request(app).get(url).set('X-API-Key', hubKey);
            expect([401, 404]).toContain(r.status);
        }
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mcp', 'registry.js'), 'utf8');
        expect(src).not.toMatch(/settings/);
    });
});

describe('backup-dir test endpoint', () => {
    let tmp;
    beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dirtest-')); });
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const probe = (dir) => agent.post('/admin/api/settings/backup-dir/test').set(H).send({ dir });

    test('a writable folder (made if missing) answers ok with free space and the resolved path', async () => {
        const dir = path.join(tmp, 'a', 'b', '..', 'new');
        const r = (await probe(dir).expect(200)).body;
        expect(r).toMatchObject({ ok: true, writable: true, resolved: path.join(tmp, 'a', 'new'), created: true });
        expect(r.free_bytes).toBeGreaterThan(0);
        expect(fs.readdirSync(path.join(tmp, 'a', 'new'))).toEqual([]); // the probe file is gone
    });
    test('a folder that cannot be made answers ok false with the reason', async () => {
        const file = path.join(tmp, 'plain.txt');
        fs.writeFileSync(file, 'x');
        const r = (await probe(path.join(file, 'sub')).expect(200)).body;
        expect(r).toMatchObject({ ok: false, writable: false });
        expect(r.error).toMatch(/Could not write/);
        expect((await probe(file).expect(400)).body.error).toMatch(/not a folder/);
    });
    test('relative, empty, root and system paths are refused with a plain message', async () => {
        expect((await probe('backups').expect(400)).body.error).toMatch(/absolute/);
        expect((await probe('').expect(400)).body.error).toMatch(/folder path/);
        expect((await probe(undefined).expect(400)).body.error).toMatch(/folder path/);
        expect((await probe('/').expect(400)).body.error).toMatch(/root/);
        for (const p of ['/proc/self', '/sys/x', '/dev/shm/x', '/etc/hub', '/etc/../etc/x']) {
            expect((await probe(p).expect(400)).body.error).toMatch(/system folder/);
        }
        expect(fs.existsSync('/etc/hub')).toBe(false);
    });
    test('a link that leads into a system folder is refused too', async () => {
        const link = path.join(tmp, 'sneaky');
        fs.symlinkSync('/etc', link);
        expect((await probe(path.join(link, 'x')).expect(400)).body.error).toMatch(/system folder/);
    });
});
