process.env.HUB_DB_FILE = ':memory:';

// Every flight, booking reference and trip in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const audit = require('../services/audit');
const app = require('../app');

let reader;
let writer;
let writeOnly;
let suggester;
let other;

beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'flights-reader', scopes: 'flights:read' }).key;
    writer = apiKeys.create(conn, { name: 'flights-editor', scopes: 'flights:read, flights:write' }).key;
    writeOnly = apiKeys.create(conn, { name: 'flights-blind', scopes: 'flights:write' }).key;
    suggester = apiKeys.create(conn, { name: 'flights-job', scopes: 'flights:suggest' }).key;
    other = apiKeys.create(conn, { name: 'places-only', scopes: 'places:read, places:write' }).key;
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const as = (key) => ({
    get: (url) => request(app).get(url).set(auth(key)),
    post: (url, body) => request(app).post(url).set(auth(key)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(key)).send(body),
    put: (url, body) => request(app).put(url).set(auth(key)).send(body),
});
const BOOKING = 'QX7RZ2';
const flight = (extra = {}) => ({
    airline_iata: 'AA', flight_number: '3301', origin_iata: 'LIT', dest_iata: 'DFW',
    sched_dep: '2026-02-10T12:05:00Z', sched_arr: '2026-02-10T13:20:00Z', ...extra,
});

describe('access', () => {
    test('needs a key', async () => {
        await request(app).get('/hub/flights').expect(401);
        await request(app).post('/hub/flights').send(flight()).expect(401);
    });

    test('a key for another domain, or with only flights:suggest, gets 403', async () => {
        for (const key of [other, suggester]) {
            await as(key).get('/hub/flights').expect(403);
            await as(key).get('/hub/flights/stats').expect(403);
            await as(key).post('/hub/flights', flight({ flight_number: '1' })).expect(403);
        }
    });

    test('a read key reads everything and changes nothing', async () => {
        const id = (await as(writer).post('/hub/flights', flight({ flight_number: '10' })).expect(201)).body.id;
        const trip = (await as(writer).post('/hub/flights/trips', { title: 'Guarded' }).expect(201)).body.id;
        for (const url of ['/hub/flights', `/hub/flights/${id}`, `/hub/flights/${id}/history`, '/hub/flights/upcoming',
            '/hub/flights/stats', '/hub/flights/trips', `/hub/flights/trips/${trip}`, '/hub/flights/settings']) {
            await as(reader).get(url).expect(200);
        }
        await as(reader).post('/hub/flights', flight({ flight_number: '11' })).expect(403);
        await as(reader).patch(`/hub/flights/${id}`, { seat: '1A' }).expect(403);
        await as(reader).post(`/hub/flights/${id}/restore`, { rev: 1 }).expect(403);
        await as(reader).post('/hub/flights/trips', { title: 'Nope' }).expect(403);
        await as(reader).patch(`/hub/flights/trips/${trip}`, { title: 'Nope' }).expect(403);
        await as(reader).put('/hub/flights/settings', { home_airport: 'LIT' }).expect(403);
    });

    test('writing needs flights:read as well, since answers carry the booking reference', async () => {
        const res = await as(writeOnly).post('/hub/flights', flight({ flight_number: '12' })).expect(403);
        expect(res.body.message).toMatch(/flights:read/);
    });

    test('there is no delete', async () => {
        const id = (await as(writer).post('/hub/flights', flight({ flight_number: '13' })).expect(201)).body.id;
        await request(app).delete(`/hub/flights/${id}`).set(auth(writer)).expect(404);
    });
});

describe('flights over REST', () => {
    test('create, get, duplicate, update, restore', async () => {
        const made = (await as(writer).post('/hub/flights', flight({ booking_ref: BOOKING, seat: '14C' })).expect(201)).body;
        expect(made).toMatchObject({ status: 'created', rev: 1, label: 'AA 3301 LIT-DFW 2026-02-10' });

        const got = (await as(reader).get(`/hub/flights/${made.id}`).expect(200)).body;
        expect(got).toMatchObject({ booking_ref: BOOKING, dep_local: '2026-02-10T06:05', dep_tz: 'America/Chicago' });
        expect(got.distance_km).toBeGreaterThan(480);

        const dup = (await as(writer).post('/hub/flights', flight({ sched_dep: '2026-02-10T06:05', sched_arr: null })).expect(409)).body;
        expect(dup).toEqual({ error: 'duplicate', message: expect.any(String), id: made.id });

        expect((await as(writer).patch(`/hub/flights/${made.id}`, { seat: '2A', status: 'completed' }).expect(200)).body).toMatchObject({ status: 'updated', rev: 2 });
        expect((await as(writer).patch(`/hub/flights/${made.id}`, { seat: '2A' }).expect(200)).body.status).toBe('unchanged');
        expect((await as(reader).get(`/hub/flights/${made.id}?rev=1`).expect(200)).body).toMatchObject({ seat: '14C', status: 'scheduled' });
        expect((await as(writer).post(`/hub/flights/${made.id}/restore`, { rev: 1 }).expect(200)).body).toMatchObject({ status: 'updated', rev: 3 });
        expect((await as(reader).get(`/hub/flights/${made.id}`).expect(200)).body.seat).toBe('14C');

        await as(writer).post(`/hub/flights/${made.id}/restore`, { rev: 42 }).expect(404);
        await as(reader).get('/hub/flights/99999').expect(404);
        expect((await as(writer).post('/hub/flights', flight({ dest_iata: 'LIT' })).expect(400)).body.error).toBe('bad_airport');
    });

    test('the booking reference is never in audit rows or error messages', async () => {
        const conn = db.get();
        const id = (await as(writer).post('/hub/flights', flight({ flight_number: '20', booking_ref: 'ZK4ZK4' })).expect(201)).body.id;
        await as(writer).patch(`/hub/flights/${id}`, { booking_ref: 'ZK5ZK5' }).expect(200);
        await as(writer).post(`/hub/flights/${id}/restore`, { rev: 1 }).expect(200);
        const bad = await as(writer).patch(`/hub/flights/${id}`, { booking_ref: 'ZK6-ZK6-BAD' }).expect(400);
        expect(JSON.stringify(bad.body)).not.toMatch(/ZK6/);
        const stats = await as(reader).get('/hub/flights/stats').expect(200);
        expect(JSON.stringify(stats.body)).not.toMatch(/ZK[45]/);

        const rows = audit.recent(conn, 200).filter((r) => r.action.startsWith('flight_'));
        expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['flight_created', 'flight_updated', 'flight_restored']));
        expect(rows.find((r) => r.action === 'flight_created').detail).toEqual({ id: expect.any(Number), flight: expect.stringMatching(/^AA \d+ LIT-DFW/), rev: 1 });
        const raw = conn.prepare('SELECT detail FROM audit_log').all().map((r) => r.detail || '').join('\n');
        expect(raw).not.toMatch(/ZK[456]|booking/i);
    });

    test('list filters, upcoming and stats', async () => {
        await as(writer).post('/hub/flights', flight({ airline_iata: 'QR', flight_number: '730', origin_iata: 'DFW', dest_iata: 'DOH', sched_dep: '2024-05-01T21:00:00Z', sched_arr: '2024-05-02T12:30:00Z' })).expect(201);
        await as(writer).post('/hub/flights', flight({ flight_number: '30', sched_dep: '2099-01-05T15:00:00Z', sched_arr: null })).expect(201);

        const qr = (await as(reader).get('/hub/flights?airline=QR').expect(200)).body;
        expect(qr).toMatchObject({ total: 1, flights: [{ flight_number: '730' }] });
        expect((await as(reader).get('/hub/flights?year=2024&airport=DOH').expect(200)).body.total).toBe(1);
        expect((await as(reader).get('/hub/flights?year=x').expect(400)).body.error).toBe('bad_year');

        const up = (await as(reader).get('/hub/flights/upcoming').expect(200)).body.flights;
        expect(up[0]).toMatchObject({ flight_number: '30' });

        const all = (await as(reader).get('/hub/flights/stats').expect(200)).body;
        expect(all.upcoming).toBeGreaterThanOrEqual(1);
        expect(all.longest.route).toBe('DFW-DOH');
        const y = (await as(reader).get('/hub/flights/stats?year=2024').expect(200)).body;
        expect(y).toMatchObject({ year: '2024', flights: 1, countries: 2 });
    });

    test('trips and settings', async () => {
        const trip = (await as(writer).post('/hub/flights/trips', { title: 'Winter', start_date: '2026-12-15', end_date: '2027-01-10' }).expect(201)).body;
        await as(writer).post('/hub/flights', flight({ flight_number: '40', trip_id: trip.id })).expect(201);
        expect((await as(reader).get(`/hub/flights/trips/${trip.id}`).expect(200)).body.flights).toHaveLength(1);
        expect((await as(reader).get(`/hub/flights?trip=${trip.id}`).expect(200)).body.total).toBe(1);
        expect((await as(writer).patch(`/hub/flights/trips/${trip.id}`, { notes: 'Home' }).expect(200)).body.status).toBe('updated');
        await as(writer).patch('/hub/flights/trips/9999', { notes: 'x' }).expect(404);

        expect((await as(writer).put('/hub/flights/settings', { home_airport: 'lit' }).expect(200)).body).toEqual({ home_airport: 'LIT' });
        expect((await as(reader).get('/hub/flights/settings').expect(200)).body).toEqual({ home_airport: 'LIT' });
        expect((await as(writer).put('/hub/flights/settings', { colour: 'red' }).expect(400)).body.error).toBe('bad_setting');
    });
});

describe('domain switch', () => {
    afterEach(() => domains.setEnabled(db.get(), 'flights', true, 'test'));

    test('a switched-off flights domain answers 503 to valid keys, reads and writes, but keeps its data', async () => {
        const before = (await as(reader).get('/hub/flights').expect(200)).body.total;
        domains.setEnabled(db.get(), 'flights', false, 'test');
        expect((await as(reader).get('/hub/flights').expect(503)).body.error).toBe('domain_disabled');
        await as(reader).get('/hub/flights/stats').expect(503);
        await as(writer).post('/hub/flights', flight({ flight_number: '50' })).expect(503);
        await as(writer).put('/hub/flights/settings', { home_airport: 'LIT' }).expect(503);
        domains.setEnabled(db.get(), 'flights', true, 'test');
        expect((await as(reader).get('/hub/flights').expect(200)).body.total).toBe(before);
    });
});
