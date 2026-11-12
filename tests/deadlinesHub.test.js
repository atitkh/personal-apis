process.env.HUB_DB_FILE = ':memory:';

// Every deadline, reference, amount and note in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const audit = require('../services/audit');
const app = require('../app');

let reader;
let writer;
let writeOnly;
let other;

beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'deadlines-reader', scopes: 'deadlines:read' }).key;
    writer = apiKeys.create(conn, { name: 'deadlines-editor', scopes: 'deadlines:read, deadlines:write' }).key;
    writeOnly = apiKeys.create(conn, { name: 'deadlines-blind', scopes: 'deadlines:write' }).key;
    other = apiKeys.create(conn, { name: 'flights-only', scopes: 'flights:read, flights:write' }).key;
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const as = (key) => ({
    get: (url) => request(app).get(url).set(auth(key)),
    post: (url, body) => request(app).post(url).set(auth(key)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(key)).send(body),
});
const REF = 'QZ-4471-REFX';
const AMOUNT = 87654;
const NOTE = 'hide the secret note text';
const item = (extra = {}) => ({ title: 'Car insurance', kind: 'insurance', due_date: '2099-06-30', reference: REF, notes: NOTE, ...extra });

describe('access', () => {
    test('needs a key', async () => {
        await request(app).get('/hub/deadlines').expect(401);
        await request(app).post('/hub/deadlines').send(item()).expect(401);
    });

    test('a key for another domain gets 403 everywhere', async () => {
        await as(other).get('/hub/deadlines').expect(403);
        await as(other).get('/hub/deadlines/upcoming').expect(403);
        await as(other).get('/hub/deadlines/1').expect(403);
        await as(other).post('/hub/deadlines', item()).expect(403);
    });

    test('read cannot write; write alone cannot create (the answer needs read)', async () => {
        await as(reader).post('/hub/deadlines', item()).expect(403);
        await as(reader).patch('/hub/deadlines/1', { title: 'x' }).expect(403);
        await as(reader).post('/hub/deadlines/1/done').expect(403);
        await as(reader).post('/hub/deadlines/1/end').expect(403);
        await as(reader).post('/hub/deadlines/1/restore', { rev: 1 }).expect(403);
        await as(writeOnly).post('/hub/deadlines', item()).expect(403);
        await as(writeOnly).get('/hub/deadlines').expect(403);
    });
});

describe('REST', () => {
    test('create, list (no reference), get (reference), history, patch', async () => {
        const created = await as(writer).post('/hub/deadlines', item()).expect(201);
        expect(created.body).toEqual({ status: 'created', id: 1, title: 'Car insurance', rev: 1 });
        const list = (await as(reader).get('/hub/deadlines').expect(200)).body;
        expect(list.total).toBe(1);
        expect(list.deadlines[0]).toMatchObject({ id: 1, title: 'Car insurance', has_reference: true, status: 'active' });
        expect(JSON.stringify(list)).not.toContain(REF);
        const one = (await as(reader).get('/hub/deadlines/1').expect(200)).body;
        expect(one).toMatchObject({ reference: REF, notes: NOTE, revisions: 1 });
        expect(JSON.stringify((await as(reader).get('/hub/deadlines/1/history').expect(200)).body)).not.toContain(REF);
        const patched = await as(writer).patch('/hub/deadlines/1', { lead_days: 60, urgent_days: 10 }).expect(200);
        expect(patched.body).toMatchObject({ status: 'updated', rev: 2, fields: ['lead_days', 'urgent_days'] });
        expect((await as(reader).get('/hub/deadlines/1?rev=1').expect(200)).body).toMatchObject({ lead_days: 14, rev: 1, reference: REF });
        expect((await as(writer).patch('/hub/deadlines/1', { lead_days: 60 }).expect(200)).body.status).toBe('unchanged');
    });

    test('bad input is a clean 400 with a code', async () => {
        const r = await as(writer).post('/hub/deadlines', item({ kind: 'document', amount_cents: 5, currency: 'USD' })).expect(400);
        expect(r.body.error).toBe('money_not_allowed');
        expect(r.body.message).toMatch(/only for subscription, membership and bill/);
        expect((await as(writer).post('/hub/deadlines', item({ lead_days: 1, urgent_days: 5 })).expect(400)).body.error).toBe('bad_window');
        await as(reader).get('/hub/deadlines/999').expect(404);
        await as(writer).patch('/hub/deadlines/999', { title: 'x' }).expect(404);
        await as(writer).patch('/hub/deadlines/1', {}).expect(400);
        await as(reader).get('/hub/deadlines?kind=pet').expect(400);
    });

    test('done rolls a repeating item, then end, then restore', async () => {
        const id = (await as(writer).post('/hub/deadlines', item({ title: 'Rent', kind: 'bill', repeat_kind: 'monthly', due_date: '2099-01-31', amount_cents: AMOUNT, currency: 'USD', cycle: 'monthly' })).expect(201)).body.id;
        const done = (await as(writer).post(`/hub/deadlines/${id}/done`).expect(200)).body;
        expect(done).toMatchObject({ status: 'rolled', title: 'Rent', next_due: '2099-02-28', fields: ['due_date'] });
        expect((await as(reader).get(`/hub/deadlines/${id}`).expect(200)).body).toMatchObject({ due_date: '2099-02-28', status: 'active' });
        expect((await as(writer).post(`/hub/deadlines/${id}/end`).expect(200)).body).toMatchObject({ status: 'ended' });
        expect((await as(writer).post(`/hub/deadlines/${id}/end`).expect(200)).body.status).toBe('unchanged');
        expect((await as(writer).post(`/hub/deadlines/${id}/done`).expect(409)).body.error).toBe('not_active');
        const restored = (await as(writer).post(`/hub/deadlines/${id}/restore`, { rev: 1 }).expect(200)).body;
        expect(restored).toMatchObject({ status: 'updated' });
        expect((await as(reader).get(`/hub/deadlines/${id}`).expect(200)).body).toMatchObject({ status: 'active', due_date: '2099-01-31' });
        await as(writer).post(`/hub/deadlines/${id}/restore`, { rev: 99 }).expect(404);
    });

    test('list filters and upcoming (the fixed word is not read as an id)', async () => {
        const mk = (extra) => as(writer).post('/hub/deadlines', item(extra)).expect(201);
        await mk({ title: 'Overdue thing', due_date: '2000-01-01' });
        await mk({ title: 'Far thing', due_date: '2099-12-31' });
        const up = (await as(reader).get('/hub/deadlines/upcoming?days=30').expect(200)).body.deadlines;
        expect(up.map((d) => d.title)).toContain('Overdue thing');
        expect(up.map((d) => d.title)).not.toContain('Far thing');
        expect(up[0]).toMatchObject({ overdue: true, window: 'urgent' });
        expect(JSON.stringify(up)).not.toContain(REF);
        const over = (await as(reader).get('/hub/deadlines?overdue=true').expect(200)).body.deadlines;
        expect(over.map((d) => d.title)).toEqual(['Overdue thing']);
        const q = (await as(reader).get('/hub/deadlines?q=far&due_after=2099-01-01&limit=5').expect(200)).body;
        expect(q.deadlines.map((d) => d.title)).toEqual(['Far thing']);
    });
});

describe('audit', () => {
    test('rows carry id, title and field names, never reference, amount or notes', async () => {
        const id = (await as(writer).post('/hub/deadlines', item({ title: 'Gym', kind: 'membership', amount_cents: AMOUNT, currency: 'USD', cycle: 'monthly', repeat_kind: 'yearly' })).expect(201)).body.id;
        await as(writer).patch(`/hub/deadlines/${id}`, { reference: `${REF}-2`, notes: `${NOTE} again`, amount_cents: AMOUNT + 1 }).expect(200);
        await as(writer).post(`/hub/deadlines/${id}/done`).expect(200);
        await as(writer).post(`/hub/deadlines/${id}/end`).expect(200);
        await as(writer).post(`/hub/deadlines/${id}/restore`, { rev: 1 }).expect(200);
        const rows = audit.recent(db.get(), 300).filter((r) => r.action.startsWith('deadline_'));
        const mine = rows.filter((r) => r.detail.id === id);
        expect(mine.map((r) => r.action).sort()).toEqual(['deadline_created', 'deadline_done', 'deadline_ended', 'deadline_restored', 'deadline_updated']);
        const updated = mine.find((r) => r.action === 'deadline_updated');
        expect(updated.detail).toEqual({ id, title: 'Gym', rev: 2, fields: ['reference', 'amount_cents', 'notes'] });
        expect(mine.find((r) => r.action === 'deadline_done').detail).toMatchObject({ id, title: 'Gym', next_due: expect.any(String) });
        expect(updated.actor).toBe('deadlines-editor');
        const everything = JSON.stringify(rows);
        for (const secret of [REF, String(AMOUNT), NOTE]) expect(everything).not.toContain(secret);
        // Reads and unchanged writes leave no rows.
        const before = audit.recent(db.get(), 300).length;
        await as(reader).get(`/hub/deadlines/${id}`).expect(200);
        await as(writer).post(`/hub/deadlines/${id}/restore`, { rev: 1 }).expect(200);
        expect(audit.recent(db.get(), 300).length).toBe(before);
    });
});

describe('domain switch', () => {
    afterEach(() => domains.setEnabled(db.get(), 'deadlines', true, 'test'));

    test('a switched-off domain answers 503 to valid keys but keeps its data', async () => {
        const id = (await as(writer).post('/hub/deadlines', item({ title: 'Kept' })).expect(201)).body.id;
        domains.setEnabled(db.get(), 'deadlines', false, 'test');
        expect((await as(reader).get('/hub/deadlines').expect(503)).body.error).toBe('domain_disabled');
        await as(reader).get('/hub/deadlines/upcoming').expect(503);
        await as(reader).get(`/hub/deadlines/${id}`).expect(503);
        await as(writer).post('/hub/deadlines', item()).expect(503);
        await as(writer).post(`/hub/deadlines/${id}/done`).expect(503);
        domains.setEnabled(db.get(), 'deadlines', true, 'test');
        expect((await as(reader).get(`/hub/deadlines/${id}`).expect(200)).body.title).toBe('Kept');
    });
});
