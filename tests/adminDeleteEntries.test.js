// Permanent delete for deadlines, preferences and digests (admin only). Every title, value and digest text is invented.
const KEY = 'a'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const deadlines = require('../services/deadlines');
const preferences = require('../services/preferences');
const digests = require('../services/digests');
const domains = require('../services/domains');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const conn = () => db.get();
const n = (sql, ...a) => conn().prepare(sql).get(...a).n;
const del = (path, body) => agent.delete(`/admin/api/${path}`).set(H).send(body);
const lastAudit = (action) => audit.recent(conn(), 5, { actions: [action] })[0];
const flat = (row) => JSON.stringify(row);

describe('delete deadlines', () => {
    test('the deadline and its revisions go; the audit row has title and count, never reference, notes or amounts', async () => {
        const d = deadlines.create(conn(), { title: 'Passport renewal', kind: 'document', due_date: '2099-01-10', reference: 'REF-SECRET-4411', notes: 'note-secret-xyz' }, 'tester');
        deadlines.update(conn(), d.id, { title: 'Passport renewal (new)' }, 'tester');
        deadlines.done(conn(), d.id, 'tester');
        const pre = (await agent.get(`/admin/api/deadlines/${d.id}/delete-preview`).expect(200)).body;
        expect(pre).toMatchObject({ label: 'Passport renewal (new)', counts: { revisions: 3 } });
        await del(`deadlines/${d.id}`, {}).expect(400);
        await del(`deadlines/${d.id}`).expect(400);
        expect((await del(`deadlines/${d.id}`, { confirm: true }).expect(200)).body).toMatchObject({ status: 'deleted', label: 'Passport renewal (new)', backup: null });
        expect(n('SELECT COUNT(*) AS n FROM deadlines WHERE id = ?', d.id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM deadline_revisions WHERE deadline_id = ?', d.id)).toBe(0);
        const row = lastAudit('deadline_deleted');
        expect(row.actor).toBe('admin');
        expect(row.detail).toEqual({ id: d.id, title: 'Passport renewal (new)', revisions: 3 });
        expect(flat(row)).not.toMatch(/SECRET|secret/);
    });

    test('works on done and ended ones, needs a session and the header, 404 when missing, and while switched off', async () => {
        const d = deadlines.create(conn(), { title: 'Gym', kind: 'subscription', due_date: '2099-01-10' }, 'tester');
        deadlines.end(conn(), d.id, 'tester');
        await request(app).delete(`/admin/api/deadlines/${d.id}`).set(H).send({ confirm: true }).expect(401);
        await agent.delete(`/admin/api/deadlines/${d.id}`).send({ confirm: true }).expect(403);
        await del('deadlines/99999', { confirm: true }).expect(404);
        domains.setEnabled(conn(), 'deadlines', false, 'test');
        try { await del(`deadlines/${d.id}`, { confirm: true }).expect(200); } finally { domains.setEnabled(conn(), 'deadlines', true, 'test'); }
        expect(n('SELECT COUNT(*) AS n FROM deadlines WHERE id = ?', d.id)).toBe(0);
    });
});

describe('delete preferences', () => {
    test('removed and live rows both delete with their revisions; the value never reaches the audit row', async () => {
        const live = preferences.create(conn(), { area: 'travel', key: 'airline seat', value: 'aisle-value-secret' }, 'tester');
        const gone = preferences.create(conn(), { area: 'food', key: 'spice level', value: 'mild-value-secret' }, 'tester');
        preferences.unset(conn(), gone.id, 'tester');
        const pre = (await agent.get(`/admin/api/preferences/${gone.id}/delete-preview`).expect(200)).body;
        expect(pre).toMatchObject({ area: 'food', key: 'spice_level', removed: true, counts: { revisions: 2 } });
        expect(flat(pre)).not.toContain('secret');
        await del(`preferences/${gone.id}`, {}).expect(400);
        await del(`preferences/${gone.id}`, { confirm: true }).expect(200);
        await del(`preferences/${live.id}`, { confirm: true }).expect(200);
        for (const id of [live.id, gone.id]) {
            expect(n('SELECT COUNT(*) AS n FROM preferences WHERE id = ?', id)).toBe(0);
            expect(n('SELECT COUNT(*) AS n FROM preference_revisions WHERE preference_id = ?', id)).toBe(0);
        }
        const rows = audit.recent(conn(), 5, { actions: ['preference_deleted'] });
        expect(rows[1].detail).toEqual({ id: gone.id, area: 'food', key: 'spice_level', revisions: 2 });
        expect(flat(rows)).not.toContain('secret');
        await del(`preferences/${live.id}`, { confirm: true }).expect(404);
    });

    test('access: session and header', async () => {
        const p = preferences.create(conn(), { area: 'work', key: 'standup time', value: '9' }, 'tester');
        await request(app).delete(`/admin/api/preferences/${p.id}`).set(H).send({ confirm: true }).expect(401);
        await agent.delete(`/admin/api/preferences/${p.id}`).send({ confirm: true }).expect(403);
        expect(n('SELECT COUNT(*) AS n FROM preferences WHERE id = ?', p.id)).toBe(1);
    });
});

describe('delete digests', () => {
    const put = (period, body) => digests.put(conn(), 'daily', period, { body, actor: 'digest-job' });

    test('the digest, its revisions and its search row go; the audit row has kind, period and count only', async () => {
        put('2026-03-01', 'A quiet day with zebrafish in it.');
        digests.edit(conn(), 'daily', '2026-03-01', { body: 'A quiet day with zebrafish and extra text.', actor: 'admin' });
        const id = conn().prepare("SELECT id FROM digests WHERE period = '2026-03-01'").get().id;
        expect(digests.search(conn(), 'zebrafish')).toHaveLength(1);
        const pre = (await agent.get('/admin/api/digests/daily/2026-03-01/delete-preview').expect(200)).body;
        expect(pre).toMatchObject({ kind: 'daily', period: '2026-03-01', counts: { revisions: 2 } });
        await del('digests/daily/2026-03-01', {}).expect(400);
        await del('digests/daily/2026-03-01', { confirm: true }).expect(200);
        expect(n('SELECT COUNT(*) AS n FROM digests WHERE id = ?', id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM digest_revisions WHERE digest_id = ?', id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM digest_search WHERE rowid = ?', id)).toBe(0);
        expect(digests.search(conn(), 'zebrafish')).toHaveLength(0);
        const row = lastAudit('digest_deleted');
        expect(row.detail).toEqual({ kind: 'daily', period: '2026-03-01', revisions: 2 });
        expect(flat(row)).not.toContain('zebrafish');
    });

    test('404, bad period, session and header; weekly works too', async () => {
        await del('digests/daily/2026-03-02', { confirm: true }).expect(404);
        await del('digests/daily/nope', { confirm: true }).expect(400);
        digests.put(conn(), 'weekly', '2026-W10', { body: 'Week text.', actor: 'job' });
        await request(app).delete('/admin/api/digests/weekly/2026-W10').set(H).send({ confirm: true }).expect(401);
        await agent.delete('/admin/api/digests/weekly/2026-W10').send({ confirm: true }).expect(403);
        await del('digests/weekly/2026-W10', { confirm: true }).expect(200);
    });
});

describe('activity for deletes', () => {
    test('each new action sits under its domain filter', async () => {
        const feed = async (type) => (await agent.get(`/admin/api/activity?type=${type}`).expect(200)).body.events.map((e) => e.action);
        expect(await feed('deadlines')).toContain('deadline_deleted');
        expect(await feed('preferences')).toContain('preference_deleted');
        expect(await feed('digests')).toContain('digest_deleted');
    });
});
