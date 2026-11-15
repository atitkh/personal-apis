// Links between records of any two domains: validation, duplicates in either direction, visibility per key, cleanup when a
// record is deleted for good, REST scopes (no DELETE under /hub), the agent tool, the admin API and the audit rows.
const KEY = 'l'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const deadlines = require('../services/deadlines');
const preferences = require('../services/preferences');
const trips = require('../services/trips');
const flights = require('../services/flights');
const lifelog = require('../services/lifelog');
const links = require('../services/links');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const conn = () => db.get();
const keys = {};
let tripId; let dlId; let prefId; let epId;

afterAll(() => db.close());

beforeAll(() => {
    const make = (name, scopes) => { keys[name] = apiKeys.create(conn(), { name, scopes }).key; };
    make('linker', 'links:read, links:agent-write, links:api-write, trips:read, deadlines:read, preferences:read');
    make('reader', 'links:read, trips:read');
    make('none', 'trips:read');
    tripId = trips.create(conn(), { title: 'Winter trip', destination: 'Hong Kong' }, 't').id;
    dlId = deadlines.create(conn(), { title: 'Hong Kong visa', kind: 'document', due_date: '2026-12-01' }, 't').id;
    prefId = preferences.set(conn(), { area: 'travel', key: 'airline_seat', value: 'aisle' }, 't').id;
    epId = lifelog.createEpisode(conn(), { kind: 'eat', title: 'Dim sum lunch', start_at: '2026-11-13T18:00:00Z' }, 't').id;
});

const rec = (domain, id) => ({ domain, id });

describe('links service', () => {
    test('add, list from both ends, duplicates in either direction, and validation', () => {
        const a = links.add(conn(), { from: rec('deadlines', dlId), to: rec('trips', tripId), rel: 'for', note: 'before departure' }, 'admin');
        expect(a).toMatchObject({ status: 'created', rel: 'for' });
        expect(links.add(conn(), { from: rec('trips', tripId), to: rec('deadlines', dlId), rel: 'for' }, 'admin').status).toBe('exists');
        expect(links.add(conn(), { from: rec('preferences', prefId), to: rec('trips', tripId) }, 'admin').status).toBe('created');
        const fromTrip = links.listFor(conn(), 'trips', tripId);
        expect(fromTrip.links.map((l) => l.other.domain).sort()).toEqual(['deadlines', 'preferences']);
        expect(fromTrip.links.find((l) => l.other.domain === 'deadlines')).toMatchObject({ rel: 'for', note: 'before departure', direction: 'in', other: { title: 'Hong Kong visa', date: '2026-12-01' } });
        expect(links.listFor(conn(), 'deadlines', dlId).links[0]).toMatchObject({ direction: 'out', other: { domain: 'trips', title: 'Winter trip' } });
        expect(() => links.add(conn(), { from: rec('trips', tripId), to: rec('trips', tripId) }, 'a')).toThrow(/itself/);
        expect(() => links.add(conn(), { from: rec('trips', 9999), to: rec('trips', tripId) }, 'a')).toThrow(/no trips record/);
        expect(() => links.add(conn(), { from: rec('nope', 1), to: rec('trips', tripId) }, 'a')).toThrow(/domain must be one of/);
        expect(() => links.add(conn(), { from: rec('trips', tripId), to: rec('deadlines', dlId), rel: 'Bad Word' }, 'a')).toThrow(/short lowercase/);
    });

    test('a digest is linked by kind/period, a lifelog record by episode id', () => {
        require('../services/digests').put(conn(), 'daily', '2026-11-12', { body: 'Day.', source: 'generated', actor: 't' });
        expect(links.add(conn(), { from: rec('digests', 'daily/2026-11-12'), to: rec('lifelog', epId), rel: 'during' }, 'a').status).toBe('created');
        expect(() => links.add(conn(), { from: rec('digests', 'daily/1999-01-01'), to: rec('trips', tripId) }, 'a')).toThrow(/no digests record/);
    });

    test('visibility: links to unreadable domains are counted, not shown, and cannot be made', () => {
        const seen = links.listFor(conn(), 'trips', tripId, { visible: ['trips', 'deadlines'] });
        expect(seen.links.map((l) => l.other.domain)).toEqual(['deadlines']);
        expect(seen.hidden).toBe(1);
        expect(() => links.add(conn(), { from: rec('trips', tripId), to: rec('preferences', prefId), rel: 'about' }, 'a', { visible: ['trips'] })).toThrow(/cannot read preferences/);
    });

    test('deleting a record for good removes its links', () => {
        const id = deadlines.create(conn(), { title: 'Temp', kind: 'task', due_date: '2026-12-02' }, 't').id;
        links.add(conn(), { from: rec('deadlines', id), to: rec('trips', tripId), rel: 'for' }, 'a');
        const before = conn().prepare('SELECT COUNT(*) AS n FROM links').get().n;
        deadlines.remove(conn(), id, { confirm: true });
        expect(conn().prepare('SELECT COUNT(*) AS n FROM links').get().n).toBe(before - 1);
    });
});

const rpc = (key, method, params = {}) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').set('Authorization', `Bearer ${key}`)
    .send({ jsonrpc: '2.0', id: 1, method, params });
const call = async (name, args) => (await rpc(keys[name], 'tools/call', { name: 'links', arguments: args }).expect(200)).body.result;
const body = (r) => JSON.parse(r.content[0].text.replace(/^[^{]*/, ''));

describe('REST /hub/links', () => {
    const bearer = (k) => ({ Authorization: `Bearer ${keys[k]}` });
    test('scopes: read lists, api-write creates and removes (by POST), others are refused', async () => {
        await request(app).get(`/hub/links?domain=trips&id=${tripId}`).expect(401);
        await request(app).get(`/hub/links?domain=trips&id=${tripId}`).set(bearer('none')).expect(403);
        const ok = (await request(app).get(`/hub/links?domain=trips&id=${tripId}`).set(bearer('reader')).expect(200)).body;
        expect(ok.links.every((l) => l.other.domain === 'trips')).toBe(true);
        await request(app).post('/hub/links').set(bearer('reader')).send({ from: rec('trips', tripId), to: rec('deadlines', dlId) }).expect(403);
        const made = (await request(app).post('/hub/links').set(bearer('linker')).send({ from: rec('trips', tripId), to: rec('lifelog', epId), rel: 'during' }).expect(403)).body;
        expect(made.error).toBeDefined(); // lifelog is not readable by this key
        const created = (await request(app).post('/hub/links').set(bearer('linker')).send({ from: rec('trips', tripId), to: rec('deadlines', dlId), rel: 'about' }).expect(201)).body;
        await request(app).post(`/hub/links/${created.id}/remove`).set(bearer('reader')).expect(403);
        await request(app).post(`/hub/links/${created.id}/remove`).set(bearer('linker')).expect(200);
        await request(app).delete(`/hub/links/${created.id}`).set(bearer('linker')).expect(404);
    });
});

describe('agent tool', () => {
    test('related and link/unlink follow the key\'s domains and the tool mode', async () => {
        const names = (await rpc(keys.linker, 'tools/list').expect(200)).body.result.tools.map((t) => t.name);
        expect(names).toContain('links');
        const r = body(await call('linker', { action: 'related', domain: 'trips', id: tripId }));
        expect(r.record).toMatchObject({ domain: 'trips', title: 'Winter trip' });
        expect(r.links.length).toBeGreaterThan(0);
        const bad = await call('linker', { action: 'link', domain: 'trips', id: tripId, to_domain: 'lifelog', to_id: epId });
        expect(bad.isError).toBe(true);
        const mode = require('../services/domains');
        mode.setMcpMode(conn(), 'links', 'write', 't');
        const added = body(await call('linker', { action: 'link', domain: 'trips', id: tripId, to_domain: 'preferences', to_id: prefId }));
        expect(added.status).toBe('exists');
        const fresh = body(await call('linker', { action: 'link', domain: 'deadlines', id: dlId, to_domain: 'preferences', to_id: prefId, rel: 'about' }));
        expect(fresh.status).toBe('created');
        expect(body(await call('linker', { action: 'unlink', link_id: fresh.id })).status).toBe('removed');
        expect((await rpc(keys.reader, 'tools/list').expect(200)).body.result.tools.find((t) => t.name === 'links')).toBeDefined();
        mode.setMcpMode(conn(), 'links', 'read', 't');
    });
});

describe('admin API', () => {
    test('session needed; add and remove are audited with the ends, never titles', async () => {
        await request(app).get(`/admin/api/links?domain=trips&id=${tripId}`).expect(401);
        const agent = request.agent(app);
        await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
        const made = (await agent.post('/admin/api/links').set(H).send({ from: rec('lifelog', epId), to: rec('trips', tripId), rel: 'during' }).expect(201)).body;
        const list = (await agent.get(`/admin/api/links?domain=lifelog&id=${epId}`).expect(200)).body;
        expect(list.links.map((l) => l.other.domain)).toContain('trips');
        await agent.delete(`/admin/api/links/${made.id}`).set(H).expect(200);
        await agent.delete(`/admin/api/links/${made.id}`).set(H).expect(404);
        const rows = conn().prepare("SELECT detail FROM audit_log WHERE action LIKE 'link_%'").all().map((r) => r.detail).join(' ');
        expect(rows).toContain('trips:');
        expect(rows).not.toContain('Winter trip');
        expect(rows).not.toContain('Dim sum');
    });
});
