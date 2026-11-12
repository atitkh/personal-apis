// The dashboard's deadlines API: an admin session sees every field, the private reference included.
// Every deadline, reference and amount in this file is invented.
const KEY = 'd'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const domains = require('../services/domains');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const REF = 'LIC-55-8812-ZQ';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
afterEach(() => domains.setEnabled(db.get(), 'deadlines', true, 'test'));

const item = (extra = {}) => ({ title: 'Driving licence', kind: 'license', due_date: '2099-08-15', reference: REF, ...extra });

describe('admin deadlines: access', () => {
    test('needs a session for reads and the X-Requested-With header for changes', async () => {
        await request(app).get('/admin/api/deadlines').expect(401);
        await request(app).get('/admin/api/deadlines/upcoming').expect(401);
        await request(app).get('/admin/api/deadlines/1').expect(401);
        await request(app).post('/admin/api/deadlines').set(H).send(item()).expect(401);
        await agent.post('/admin/api/deadlines').send(item()).expect(403);
        await agent.post('/admin/api/deadlines/1/done').send({}).expect(403);
        await agent.patch('/admin/api/deadlines/1').send({ title: 'x' }).expect(403);
        expect((await agent.get('/admin/api/deadlines').expect(200)).body.total).toBe(0);
    });
});

describe('admin deadlines: CRUD', () => {
    test('create, list and get carry the reference; patch and history work', async () => {
        const made = (await agent.post('/admin/api/deadlines').set(H).send(item()).expect(201)).body;
        expect(made).toEqual({ status: 'created', id: 1, title: 'Driving licence', rev: 1 });
        const list = (await agent.get('/admin/api/deadlines').expect(200)).body;
        expect(list.deadlines[0]).toMatchObject({ id: 1, reference: REF, kind: 'license', status: 'active' });
        const one = (await agent.get('/admin/api/deadlines/1').expect(200)).body;
        expect(one).toMatchObject({ reference: REF, revisions: 1 });
        expect(one.history).toEqual([expect.objectContaining({ rev: 1, source: 'create', current: true })]);
        const patched = (await agent.patch('/admin/api/deadlines/1').set(H).send({ title: 'Licence (new card)', lead_days: 90, urgent_days: 14 }).expect(200)).body;
        expect(patched).toMatchObject({ status: 'updated', rev: 2, fields: ['title', 'lead_days', 'urgent_days'] });
        expect((await agent.get('/admin/api/deadlines/1?rev=1').expect(200)).body).toMatchObject({ title: 'Driving licence', rev: 1, reference: REF });
    });

    test('upcoming is a fixed word, filters work, and reference shows', async () => {
        await agent.post('/admin/api/deadlines').set(H).send(item({ title: 'Old', due_date: '2001-01-01' })).expect(201);
        const up = (await agent.get('/admin/api/deadlines/upcoming?days=10').expect(200)).body.deadlines;
        expect(up.map((d) => d.title)).toEqual(['Old']);
        expect(up[0]).toMatchObject({ reference: REF, overdue: true });
        const q = (await agent.get('/admin/api/deadlines?overdue=true&kind=license&q=old').expect(200)).body;
        expect(q.deadlines.map((d) => d.title)).toEqual(['Old']);
        await agent.get('/admin/api/deadlines?kind=pet').expect(400);
    });

    test('done, end, restore; bad input and missing ids are clean errors', async () => {
        const id = (await agent.post('/admin/api/deadlines').set(H).send(item({ title: 'Plan', kind: 'subscription', repeat_kind: 'yearly', due_date: '2099-03-31', amount_cents: 12000, currency: 'USD', cycle: 'yearly' })).expect(201)).body.id;
        expect((await agent.post(`/admin/api/deadlines/${id}/done`).set(H).send({}).expect(200)).body).toMatchObject({ status: 'rolled', next_due: '2100-03-31' });
        expect((await agent.post(`/admin/api/deadlines/${id}/end`).set(H).send({}).expect(200)).body.status).toBe('ended');
        expect((await agent.post(`/admin/api/deadlines/${id}/done`).set(H).send({}).expect(409)).body.code).toBe('not_active');
        expect((await agent.post(`/admin/api/deadlines/${id}/restore`).set(H).send({ rev: 1 }).expect(200)).body.status).toBe('updated');
        expect((await agent.get(`/admin/api/deadlines/${id}`).expect(200)).body).toMatchObject({ status: 'active', due_date: '2099-03-31' });
        await agent.post(`/admin/api/deadlines/${id}/restore`).set(H).send({ rev: 99 }).expect(404);
        const bad = await agent.post('/admin/api/deadlines').set(H).send(item({ kind: 'task', amount_cents: 1, currency: 'USD' })).expect(400);
        expect(bad.body.code).toBe('money_not_allowed');
        expect(bad.body.error).toMatch(/only for subscription, membership and bill/);
        await agent.get('/admin/api/deadlines/9999').expect(404);
        await agent.patch('/admin/api/deadlines/9999').set(H).send({ title: 'x' }).expect(404);
    });

    test('changes are audited as admin with field names only, and the Deadlines activity filter finds them', async () => {
        const rows = audit.recent(db.get(), 300).filter((r) => r.action.startsWith('deadline_'));
        expect(rows.length).toBeGreaterThan(5);
        expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['admin']));
        expect(JSON.stringify(rows)).not.toContain(REF);
        const filtered = (await agent.get('/admin/api/activity?type=deadlines').expect(200)).body;
        const list = filtered.events || filtered.items || filtered.activity || [];
        expect(list.length).toBeGreaterThan(0);
        expect(list.every((e) => e.action.startsWith('deadline_'))).toBe(true);
    });

    test('works while the domain is switched off', async () => {
        domains.setEnabled(db.get(), 'deadlines', false, 'test');
        expect((await agent.get('/admin/api/deadlines').expect(200)).body.total).toBeGreaterThan(0);
        await agent.post('/admin/api/deadlines').set(H).send(item({ title: 'While off' })).expect(201);
    });
});
