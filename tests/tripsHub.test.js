process.env.HUB_DB_FILE = ':memory:';

// /hub/trips. Every trip, flight, booking reference and deadline in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const audit = require('../services/audit');
const flights = require('../services/flights');
const deadlines = require('../services/deadlines');
const app = require('../app');

let reader;
let writer;
let writeOnly;
let other;

beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'trips-reader', scopes: 'trips:read' }).key;
    writer = apiKeys.create(conn, { name: 'trips-editor', scopes: 'trips:read, trips:api-write' }).key;
    writeOnly = apiKeys.create(conn, { name: 'trips-blind', scopes: 'trips:api-write' }).key;
    other = apiKeys.create(conn, { name: 'flights-only', scopes: 'flights:read, flights:api-write' }).key;
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const as = (key) => ({
    get: (url) => request(app).get(url).set(auth(key)),
    post: (url, body) => request(app).post(url).set(auth(key)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(key)).send(body),
    delete: (url, body) => request(app).delete(url).set(auth(key)).send(body),
});
const REF = 'HUBREF9Z';
const NOTE = 'hide the secret note text';
const trip = (extra = {}) => ({ title: 'Kathmandu', destination: 'Nepal', kind: 'family', start_date: '2099-06-01', end_date: '2099-06-20', notes: NOTE, ...extra });
const flight = (num, extra = {}) => flights.create(db.get(), {
    airline_iata: 'QR', flight_number: String(num), origin_iata: 'DFW', dest_iata: 'DOH', sched_dep: '2099-06-01T20:00:00Z', booking_ref: REF, ...extra,
}, 'test').id;

describe('access', () => {
    test('needs a key', async () => {
        await request(app).get('/hub/trips').expect(401);
        await request(app).post('/hub/trips').send(trip()).expect(401);
    });

    test('a key for another domain gets 403 everywhere', async () => {
        await as(other).get('/hub/trips').expect(403);
        await as(other).get('/hub/trips/1').expect(403);
        await as(other).get('/hub/trips/1/history').expect(403);
        await as(other).post('/hub/trips', trip()).expect(403);
        await as(other).patch('/hub/trips/1', { title: 'x' }).expect(403);
        await as(other).post('/hub/trips/1/flights', { flight_id: 1 }).expect(403);
        await as(other).post('/hub/trips/1/flights/1/unlink', {}).expect(403);
        await as(other).post('/hub/trips/1/restore', { rev: 1 }).expect(403);
    });

    test('read cannot write; write alone cannot create (the answer needs read)', async () => {
        await as(reader).post('/hub/trips', trip()).expect(403);
        await as(reader).patch('/hub/trips/1', { title: 'x' }).expect(403);
        await as(writeOnly).post('/hub/trips', trip()).expect(403);
        expect((await as(reader).get('/hub/trips').expect(200)).body.total).toBe(0);
    });

    test('there is no DELETE of a trip over /hub', async () => {
        const id = (await as(writer).post('/hub/trips', trip({ title: 'Undeletable' })).expect(201)).body.id;
        await as(writer).delete(`/hub/trips/${id}`, { confirm: true }).expect(404);
        await as(writer).delete(`/hub/trips/${id}/flights/1`, {}).expect(404);
        expect((await as(reader).get(`/hub/trips/${id}`).expect(200)).body.title).toBe('Undeletable');
    });
});

describe('reads and writes', () => {
    test('create, list, get, patch, history and restore', async () => {
        const r = (await as(writer).post('/hub/trips', trip()).expect(201)).body;
        expect(r).toMatchObject({ status: 'created', title: 'Kathmandu', rev: 1 });
        const list = (await as(reader).get('/hub/trips?phase=upcoming').expect(200)).body;
        expect(list.trips.find((t) => t.id === r.id)).toMatchObject({ phase: 'upcoming', nights: 19, kind: 'family' });
        expect((await as(reader).get('/hub/trips?year=2099').expect(200)).body.trips.map((t) => t.id)).toContain(r.id);
        expect((await as(reader).get('/hub/trips?phase=soon').expect(400)).body.error).toBe('bad_phase');
        const p = (await as(writer).patch(`/hub/trips/${r.id}`, { kind: 'leisure', note: 'Changed my mind' }).expect(200)).body;
        expect(p).toMatchObject({ status: 'updated', rev: 2, fields: ['kind'] });
        expect((await as(writer).patch(`/hub/trips/${r.id}`, { kind: 'leisure' }).expect(200)).body.status).toBe('unchanged');
        expect((await as(writer).patch(`/hub/trips/${r.id}`, { kind: 'nap' }).expect(400)).body.error).toBe('bad_kind');
        await as(writer).patch('/hub/trips/9999', { title: 'x' }).expect(404);
        const h = (await as(reader).get(`/hub/trips/${r.id}/history`).expect(200)).body.revisions;
        expect(h.map((x) => x.rev)).toEqual([2, 1]);
        expect((await as(reader).get(`/hub/trips/${r.id}?rev=1`).expect(200)).body).toMatchObject({ kind: 'family', rev: 1, revisions: 2 });
        expect((await as(writer).post(`/hub/trips/${r.id}/restore`, { rev: 1 }).expect(200)).body).toMatchObject({ status: 'updated', rev: 3 });
        await as(writer).post(`/hub/trips/${r.id}/restore`, { rev: 99 }).expect(404);
    });

    test('link and unlink a flight; the detail has no booking reference and no deadline reference or money', async () => {
        const a = (await as(writer).post('/hub/trips', trip({ title: 'Doha A' })).expect(201)).body.id;
        const b = (await as(writer).post('/hub/trips', trip({ title: 'Doha B' })).expect(201)).body.id;
        const f = flight(700);
        deadlines.create(db.get(), { title: 'Visa', kind: 'bill', due_date: '2099-05-01', reference: 'V-REF-1', amount_cents: 9900, currency: 'USD', trip_id: a }, 'test');
        expect((await as(writer).post(`/hub/trips/${a}/flights`, { flight_id: f }).expect(200)).body).toMatchObject({ status: 'linked', flight_id: f });
        const moved = (await as(writer).post(`/hub/trips/${b}/flights`, { flight_id: f }).expect(200)).body;
        expect(moved).toMatchObject({ status: 'moved', moved_from: { id: a, title: 'Doha A' } });
        expect((await as(writer).post(`/hub/trips/${b}/flights`, {}).expect(404)).body.error).toBe('no_flight');
        const detail = (await as(reader).get(`/hub/trips/${b}`).expect(200)).body;
        expect(detail.flights.map((x) => x.id)).toEqual([f]);
        expect(detail.flights[0].has_booking_ref).toBe(true);
        const da = (await as(reader).get(`/hub/trips/${a}`).expect(200)).body;
        expect(da.deadlines).toHaveLength(1);
        expect(JSON.stringify([detail, da])).not.toContain(REF);
        expect(JSON.stringify(da)).not.toContain('V-REF-1');
        expect(JSON.stringify(da)).not.toContain('9900');
        expect((await as(writer).post(`/hub/trips/${a}/flights/${f}/unlink`, {}).expect(409)).body.error).toBe('not_on_trip');
        expect((await as(writer).post(`/hub/trips/${b}/flights/${f}/unlink`, {}).expect(200)).body.status).toBe('unlinked');
        expect(flights.get(db.get(), f).trip_id).toBeNull();
    });

    test('changes are audited under the key with ids and titles, never notes or references', async () => {
        const rows = audit.recent(db.get(), 300).filter((r) => r.action.startsWith('trip_'));
        const actions = new Set(rows.map((r) => r.action));
        for (const a of ['trip_created', 'trip_updated', 'trip_restored', 'trip_flight_linked', 'trip_flight_unlinked']) expect(actions.has(a)).toBe(true);
        expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['trips-editor']));
        const text = JSON.stringify(rows);
        for (const secret of [NOTE, REF, 'V-REF-1']) expect(text).not.toContain(secret);
        // Newest first: the move to Doha B, then the first link to Doha A.
        const links = rows.filter((r) => r.action === 'trip_flight_linked').map((r) => r.detail);
        expect(links[0]).toMatchObject({ title: 'Doha B', flight: 'QR 700 DFW-DOH 2099-06-01' });
        expect(links[1]).toMatchObject({ title: 'Doha A' });
        expect(links[1]).not.toHaveProperty('moved_from');
    });
});

describe('domain switch', () => {
    afterEach(() => domains.setEnabled(db.get(), 'trips', true, 'test'));

    test('a switched-off domain answers 503 to valid keys but keeps its data', async () => {
        const before = (await as(reader).get('/hub/trips').expect(200)).body.total;
        domains.setEnabled(db.get(), 'trips', false, 'test');
        expect((await as(reader).get('/hub/trips').expect(503)).body.error).toBe('domain_disabled');
        await as(reader).get('/hub/trips/1').expect(503);
        await as(writer).post('/hub/trips', trip()).expect(503);
        domains.setEnabled(db.get(), 'trips', true, 'test');
        expect((await as(reader).get('/hub/trips').expect(200)).body.total).toBe(before);
    });

    test('the old flights trip routes keep working', async () => {
        const t = (await as(other).post('/hub/flights/trips', { title: 'Legacy' }).expect(201)).body;
        expect(Object.keys(t).sort()).toEqual(['id', 'status', 'title']);
        expect((await as(other).get('/hub/flights/trips').expect(200)).body.trips.find((x) => x.id === t.id)).toMatchObject({ title: 'Legacy', flights: 0 });
    });
});
