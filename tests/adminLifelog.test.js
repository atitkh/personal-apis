// The dashboard's lifelog API: admin session, X-Requested-With for changes, forget with preview, confirm, backup and
// an audit row with counts only. Every observation and episode in this file is invented.
const KEY = 'l'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const lifelog = require('../services/lifelog');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const TEXT = 'private caption words';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const conn = () => db.get();
const lastAudit = (action) => audit.recent(conn(), 5, { actions: [action] })[0];
const seed = () => lifelog.push(conn(), { id: 1, name: 'cam-test', scopes: ['lifelog:push'] }, [
    { at: '2026-11-01T15:00:00Z', text: TEXT, kind: 'see' },
    { at: '2026-11-02T15:00:00Z', text: 'kept line', kind: 'see' },
]);

describe('admin lifelog', () => {
    test('needs a session for reads and the header for changes', async () => {
        await request(app).get('/admin/api/lifelog/stats').expect(401);
        await request(app).delete('/admin/api/lifelog/observations').set(H).send({ from: '2026-01-01', to: '2026-12-31', confirm: true }).expect(401);
        await agent.post('/admin/api/lifelog/observations').send({ at: '2026-11-01T12:00:00Z', text: 'x' }).expect(403);
    });

    test('a note, episodes with history and restore, links, sources, stats, day', async () => {
        seed();
        const note = (await agent.post('/admin/api/lifelog/observations').set(H).send({ at: '2026-11-01T16:00:00Z', text: 'a manual note', source: 'ignored' }).expect(201)).body;
        expect(note).toMatchObject({ status: 'created', source: 'dashboard' });
        expect(lastAudit('lifelog_observation_added').detail).toMatchObject({ id: note.id, source: 'dashboard' });
        const ep = (await agent.post('/admin/api/lifelog/episodes').set(H).send({ title: 'Walk', kind: 'walk', start_at: '2026-11-01T15:00:00Z' }).expect(201)).body;
        await agent.patch(`/admin/api/lifelog/episodes/${ep.id}`).set(H).send({ detail: 'by the river' }).expect(200);
        expect(lastAudit('lifelog_episode_updated').detail).toEqual({ id: ep.id, kind: 'walk', rev: 2, fields: ['detail'] });
        const got = (await agent.get(`/admin/api/lifelog/episodes/${ep.id}`).expect(200)).body;
        expect(got.history).toHaveLength(2);
        await agent.post(`/admin/api/lifelog/episodes/${ep.id}/restore`).set(H).send({ rev: 1 }).expect(200);
        await agent.post(`/admin/api/lifelog/episodes/${ep.id}/observations`).set(H).send({ observation_ids: [note.id] }).expect(200);
        await agent.post(`/admin/api/lifelog/episodes/${ep.id}/observations/unlink`).set(H).send({ observation_ids: [note.id] }).expect(200);
        expect((await agent.get('/admin/api/lifelog/sources').expect(200)).body.sources.map((s) => s.label).sort()).toEqual(['cam-test', 'dashboard']);
        expect((await agent.get('/admin/api/lifelog/stats').expect(200)).body).toMatchObject({ observations: 3, episodes: 1 });
        expect((await agent.get('/admin/api/lifelog/day/2026-11-01').expect(200)).body.observations.count).toBe(2);
        expect((await agent.get('/admin/api/lifelog/observations?q=manual').expect(200)).body.total).toBe(1);
        expect((await agent.get('/admin/api/lifelog/episodes').expect(200)).body.total).toBe(1);
    });

    test('forget: preview, confirm required, backup failure aborts, audit carries counts only', async () => {
        const qs = 'from=2026-11-01&to=2026-11-01';
        const pre = (await agent.get(`/admin/api/lifelog/forget-preview?${qs}`).expect(200)).body;
        expect(pre.counts).toMatchObject({ observations: 2, episodes: 1 });
        const del = (body) => agent.delete('/admin/api/lifelog/observations').set(H).send(body);
        expect((await del({ from: '2026-11-01', to: '2026-11-01' }).expect(400)).body.code).toBe('confirm_required');
        const backup = require('../services/backup');
        const spy = jest.spyOn(backup, 'snapshotBeforeDelete').mockRejectedValueOnce(new Error('disk full'));
        await del({ from: '2026-11-01', to: '2026-11-01', confirm: true, backup: true }).expect(500);
        expect(lifelog.stats(conn()).observations).toBe(3);
        spy.mockRestore();
        const r = (await del({ from: '2026-11-01', to: '2026-11-01', confirm: true }).expect(200)).body;
        expect(r).toMatchObject({ status: 'forgotten', counts: { observations: 2, episodes: 1 }, backup: null });
        const row = lastAudit('lifelog_forgotten');
        expect(row.detail).toMatchObject({ observations: 2, episodes: 1 });
        expect(JSON.stringify(audit.recent(conn(), 200))).not.toMatch(/private caption|manual note|river|Walk/);
        expect(lifelog.listObservations(conn()).observations.map((o) => o.text)).toEqual(['kept line']);
    });
});
