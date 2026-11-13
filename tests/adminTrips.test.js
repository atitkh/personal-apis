// The dashboard's trips API: admin session, X-Requested-With for changes, audit rows without values, delete with confirm.
// Every trip, flight, booking reference and deadline in this file is invented.
const KEY = 't'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const domains = require('../services/domains');
const flights = require('../services/flights');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const REF = 'ADMREF42';
const NOTE = 'private note words';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
afterEach(() => domains.setEnabled(db.get(), 'trips', true, 'test'));

const conn = () => db.get();
const n = (sql, ...a) => conn().prepare(sql).get(...a).n;
const trip = (extra = {}) => ({ title: 'Lisbon', destination: 'Portugal', kind: 'conference', start_date: '2099-09-01', end_date: '2099-09-07', notes: NOTE, ...extra });
const flight = (num, extra = {}) => flights.create(conn(), {
    airline_iata: 'TP', flight_number: String(num), origin_iata: 'EWR', dest_iata: 'LIS', sched_dep: '2099-09-01T22:00:00Z', booking_ref: REF, ...extra,
}, 'test').id;
const lastAudit = (action) => audit.recent(conn(), 5, { actions: [action] })[0];
const create = async (extra) => (await agent.post('/admin/api/trips').set(H).send(trip(extra)).expect(201)).body.id;

describe('admin trips: access', () => {
    test('needs a session for reads and the X-Requested-With header for changes', async () => {
        await request(app).get('/admin/api/trips').expect(401);
        await request(app).get('/admin/api/trips/1').expect(401);
        await request(app).post('/admin/api/trips').set(H).send(trip()).expect(401);
        await request(app).delete('/admin/api/trips/1').set(H).send({ confirm: true }).expect(401);
        await agent.post('/admin/api/trips').send(trip()).expect(403);
        await agent.patch('/admin/api/trips/1').send({ title: 'x' }).expect(403);
        await agent.post('/admin/api/trips/1/flights').send({ flight_id: 1 }).expect(403);
        await agent.delete('/admin/api/trips/1').send({ confirm: true }).expect(403);
        expect((await agent.get('/admin/api/trips').expect(200)).body.total).toBe(0);
    });
});

describe('admin trips: CRUD', () => {
    test('create, list, get with history, patch, history, restore', async () => {
        const id = await create();
        const list = (await agent.get('/admin/api/trips').expect(200)).body;
        expect(list.trips[0]).toMatchObject({ id, title: 'Lisbon', kind: 'conference', phase: 'upcoming', notes: NOTE });
        expect((await agent.patch(`/admin/api/trips/${id}`).set(H).send({ status_override: 'cancelled' }).expect(200)).body).toMatchObject({ status: 'updated', rev: 2 });
        const one = (await agent.get(`/admin/api/trips/${id}`).expect(200)).body;
        expect(one).toMatchObject({ phase: 'cancelled', revisions: 2, flights: [], deadlines: [] });
        expect(one.history.map((h) => h.rev)).toEqual([2, 1]);
        expect((await agent.get(`/admin/api/trips/${id}/history`).expect(200)).body.revisions).toHaveLength(2);
        expect((await agent.post(`/admin/api/trips/${id}/restore`).set(H).send({ rev: 1 }).expect(200)).body.fields).toEqual(['status_override']);
        expect((await agent.get('/admin/api/trips?phase=cancelled').expect(200)).body.total).toBe(0);
        expect((await agent.post('/admin/api/trips').set(H).send({ title: '' }).expect(400)).body.code).toBe('bad_request');
        expect((await agent.patch(`/admin/api/trips/${id}`).set(H).send({ end_date: '2099-01-01' }).expect(400)).body.code).toBe('bad_date');
        await agent.get('/admin/api/trips/9999').expect(404);
    });

    test('link, move and unlink flights', async () => {
        const a = await create({ title: 'A' });
        const b = await create({ title: 'B' });
        const f = flight(800);
        expect((await agent.post(`/admin/api/trips/${a}/flights`).set(H).send({ flight_id: f }).expect(200)).body.status).toBe('linked');
        expect((await agent.post(`/admin/api/trips/${b}/flights`).set(H).send({ flight_id: f }).expect(200)).body.moved_from).toEqual({ id: a, title: 'A' });
        expect((await agent.delete(`/admin/api/trips/${a}/flights/${f}`).set(H).expect(409)).body.code).toBe('not_on_trip');
        expect((await agent.delete(`/admin/api/trips/${b}/flights/${f}`).set(H).expect(200)).body.status).toBe('unlinked');
        expect(lastAudit('trip_flight_linked').detail).toMatchObject({ id: b, title: 'B', flight_id: f, moved_from: a });
        expect(lastAudit('trip_flight_unlinked').detail).toMatchObject({ id: b, flight_id: f });
    });

    test('changes are audited as admin without notes or references; the Trips activity filter finds them', async () => {
        const rows = audit.recent(conn(), 300).filter((r) => r.action.startsWith('trip_'));
        expect(rows.length).toBeGreaterThan(5);
        expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['admin']));
        expect(JSON.stringify(rows)).not.toContain(NOTE);
        expect(JSON.stringify(rows)).not.toContain(REF);
        const filtered = (await agent.get('/admin/api/activity?type=trips').expect(200)).body;
        const list = filtered.events || filtered.items || filtered.activity || [];
        expect(list.length).toBeGreaterThan(0);
        expect(list.every((e) => e.action.startsWith('trip_'))).toBe(true);
    });

    test('works while the domain is switched off', async () => {
        domains.setEnabled(conn(), 'trips', false, 'test');
        expect((await agent.get('/admin/api/trips').expect(200)).body.total).toBeGreaterThan(0);
        await create({ title: 'While off' });
    });
});

describe('admin trips: delete', () => {
    test('preview, confirm required, trip_in_use unless unassign, then flights and deadlines stay without the link', async () => {
        const id = await create({ title: 'Doomed' });
        const f = flight(801, { trip_id: id });
        conn().prepare("INSERT INTO deadlines (title, kind, due_date, trip_id, created_at, updated_at, updated_by) VALUES ('Visa', 'document', '2099-08-01', ?, 'x', 'x', 'test')").run(id);
        conn().prepare("INSERT INTO trip_items (trip_id, title, created_at, updated_at, updated_by) VALUES (?, 'Hotel', 'x', 'x', 'test')").run(id);
        expect((await agent.get(`/admin/api/trips/${id}/delete-preview`).expect(200)).body).toEqual({ id, label: 'Doomed', counts: { flights: 1, deadlines: 1, items: 1 } });
        expect((await agent.delete(`/admin/api/trips/${id}`).set(H).send({}).expect(400)).body.code).toBe('confirm_required');
        await agent.delete(`/admin/api/trips/${id}`).set(H).send({ confirm: 'yes' }).expect(400);
        expect((await agent.delete(`/admin/api/trips/${id}`).set(H).send({ confirm: true }).expect(409)).body).toMatchObject({ code: 'trip_in_use', flights: 1 });
        expect(n('SELECT COUNT(*) AS n FROM trips WHERE id = ?', id)).toBe(1);
        const r = (await agent.delete(`/admin/api/trips/${id}`).set(H).send({ confirm: true, unassign: true }).expect(200)).body;
        expect(r).toMatchObject({ status: 'deleted', id, backup: null, unassigned: true });
        expect(n('SELECT COUNT(*) AS n FROM trips WHERE id = ?', id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM trip_items WHERE trip_id = ?', id)).toBe(0);
        expect(conn().prepare('SELECT trip_id FROM flights WHERE id = ?').get(f).trip_id).toBeNull();
        expect(n('SELECT COUNT(*) AS n FROM deadlines WHERE trip_id = ?', id)).toBe(0);
        const row = lastAudit('trip_deleted');
        expect(row).toMatchObject({ actor: 'admin', detail: { id, trip: 'Doomed', flights: 1, deadlines: 1, items: 1, unassigned: true } });
        expect(JSON.stringify(row)).not.toContain(NOTE);
        await agent.delete(`/admin/api/trips/${id}`).set(H).send({ confirm: true }).expect(404);
        await agent.get(`/admin/api/trips/${id}/delete-preview`).expect(404);
    });

    test('the old flights trip routes still list and delete', async () => {
        const id = await create({ title: 'Old route' });
        expect((await agent.get('/admin/api/flights/trips').expect(200)).body.trips.find((t) => t.id === id)).toMatchObject({ title: 'Old route', flights: 0 });
        await agent.delete(`/admin/api/flights/trips/${id}`).set(H).send({ confirm: true }).expect(200);
        expect(n('SELECT COUNT(*) AS n FROM trips WHERE id = ?', id)).toBe(0);
    });
});
