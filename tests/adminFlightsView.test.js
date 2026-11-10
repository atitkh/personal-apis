// The dashboard's flights endpoints: list, one flight, edit, restore, Passport stats with map data, upcoming,
// airport search, trips and settings. Every flight and booking reference in this file is invented.
const KEY = 'd'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const flights = require('../services/flights');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const REF = 'ZK9QWE';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
    const c = db.get();
    const add = (o) => flights.create(c, { airline_iata: 'AA', airline_name: 'American', status: 'completed', ...o }, 'test');
    add({ flight_number: '100', origin_iata: 'LIT', dest_iata: 'DFW', sched_dep: '2024-03-01T08:00', sched_arr: '2024-03-01T09:20', booking_ref: REF });
    add({ flight_number: '200', origin_iata: 'DFW', dest_iata: 'JFK', sched_dep: '2025-05-10T12:00', sched_arr: '2025-05-10T16:30', aircraft_type: 'B738' });
    add({ flight_number: '300', origin_iata: 'JFK', dest_iata: 'LHR', sched_dep: '2025-05-20T18:00', sched_arr: '2025-05-21T06:00' });
    add({ flight_number: '400', origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: '2030-01-01T08:00', sched_arr: '2030-01-01T09:20', status: 'scheduled' });
});
afterAll(() => db.close());

describe('admin flights view API: access', () => {
    test('needs a session; changes need the X-Requested-With header', async () => {
        await request(app).get('/admin/api/flights').expect(401);
        await request(app).get('/admin/api/flights/stats').expect(401);
        await request(app).get('/admin/api/flights/airports?q=lit').expect(401);
        await agent.post('/admin/api/flights').send({}).expect(403);
        await agent.put('/admin/api/flights/settings').send({ home_airport: 'LIT' }).expect(403);
        await agent.patch('/admin/api/flights/1').send({ seat: '1A' }).expect(403);
    });
});

describe('admin flights view API: reading', () => {
    test('the list has filters, a total and no booking reference; one flight has it, with its history', async () => {
        const all = (await agent.get('/admin/api/flights').expect(200)).body;
        expect(all.total).toBe(4);
        expect(all.flights[0].flight_number).toBe('400');
        expect(JSON.stringify(all)).not.toContain(REF);
        expect(all.flights.find((f) => f.flight_number === '100').has_booking_ref).toBe(true);
        expect(all.flights.find((f) => f.flight_number === '200').has_booking_ref).toBe(false);
        expect((await agent.get('/admin/api/flights?year=2025').expect(200)).body.total).toBe(2);
        expect((await agent.get('/admin/api/flights?airport=LIT').expect(200)).body.total).toBe(2);
        expect((await agent.get('/admin/api/flights?status=scheduled').expect(200)).body.total).toBe(1);
        expect((await agent.get('/admin/api/flights?year=20x5').expect(400)).body.code).toBe('bad_year');
        const id = all.flights.find((f) => f.flight_number === '100').id;
        const one = (await agent.get(`/admin/api/flights/${id}`).expect(200)).body;
        expect(one).toMatchObject({ booking_ref: REF, dep_local: '2024-03-01T08:00', history: [{ rev: 1, current: true }] });
        expect((await agent.get('/admin/api/flights/9999').expect(404)).body.code).toBe('not_found');
    });

    test('stats carry the map data: airports with coordinates, routes with counts, the settings; year narrows both', async () => {
        const s = (await agent.get('/admin/api/flights/stats').expect(200)).body;
        expect(s).toMatchObject({ flights: 3, airports: 4, countries: 2, upcoming: 1, settings: { home_airport: null } });
        expect(s.map.airports.map((a) => a.iata)).toEqual(['DFW', 'JFK', 'LHR', 'LIT']);
        expect(s.map.airports.find((a) => a.iata === 'LIT')).toMatchObject({ city: expect.any(String), lat: expect.any(Number), lon: expect.any(Number), visits: 1 });
        expect(s.map.routes).toHaveLength(3);
        const y = (await agent.get('/admin/api/flights/stats?year=2025').expect(200)).body;
        expect(y.flights).toBe(2);
        expect(y.map.routes.map((r) => `${r.a}-${r.b}`).sort()).toEqual(['DFW-JFK', 'JFK-LHR']);
        expect(JSON.stringify(s)).not.toContain(REF);
        expect(JSON.stringify(s.map)).not.toMatch(/flight_number|booking|dep_local/);
    });

    test('upcoming lists the next flights', async () => {
        const u = (await agent.get('/admin/api/flights/upcoming?limit=3').expect(200)).body;
        expect(u.flights.map((f) => f.flight_number)).toEqual(['400']);
    });
});

describe('admin flights view API: airport search', () => {
    test('finds by code, city and name; code first; at most 20; empty and odd input are safe', async () => {
        const lit = (await agent.get('/admin/api/flights/airports?q=lit').expect(200)).body.airports;
        expect(lit[0].iata).toBe('LIT');
        expect(lit[0]).toMatchObject({ lat: expect.any(Number), tz: 'America/Chicago' });
        const city = (await agent.get('/admin/api/flights/airports?q=Little%20Rock').expect(200)).body.airports;
        expect(city.map((a) => a.iata)).toContain('LIT');
        const many = (await agent.get('/admin/api/flights/airports?q=a').expect(200)).body.airports;
        expect(many.length).toBeGreaterThan(0);
        expect(many.length).toBeLessThanOrEqual(20);
        expect((await agent.get('/admin/api/flights/airports').expect(200)).body.airports).toEqual([]);
        expect((await agent.get('/admin/api/flights/airports?q=%25').expect(200)).body.airports).toEqual([]);
        expect((await agent.get('/admin/api/flights/airports?q=%27%20OR%201%3D1%20--').expect(200)).body.airports).toEqual([]);
    });
});

describe('admin flights view API: writing', () => {
    test('add, edit, restore are audited as admin without the booking reference; a twin is 409 with its id', async () => {
        const made = (await agent.post('/admin/api/flights').set(H)
            .send({ airline_iata: 'UA', flight_number: '77', origin_iata: 'ORD', dest_iata: 'KTM', sched_dep: '2026-02-01T10:00', booking_ref: 'NEWREF' }).expect(201)).body;
        expect(made).toMatchObject({ status: 'created', rev: 1 });
        const dup = (await agent.post('/admin/api/flights').set(H)
            .send({ airline_iata: 'UA', flight_number: '77', origin_iata: 'ORD', dest_iata: 'KTM', sched_dep: '2026-02-01T10:00' }).expect(409)).body;
        expect(dup).toMatchObject({ code: 'duplicate', id: made.id });
        const upd = (await agent.patch(`/admin/api/flights/${made.id}`).set(H).send({ seat: '14a', booking_ref: 'OTHER1' }).expect(200)).body;
        expect(upd).toMatchObject({ status: 'updated', rev: 2 });
        expect((await agent.patch(`/admin/api/flights/${made.id}`).set(H).send({ seat: '14A' }).expect(200)).body.status).toBe('unchanged');
        const rest = (await agent.post(`/admin/api/flights/${made.id}/restore`).set(H).send({ rev: 1 }).expect(200)).body;
        expect(rest).toMatchObject({ status: 'updated', rev: 3 });
        expect((await agent.get(`/admin/api/flights/${made.id}`).expect(200)).body).toMatchObject({ seat: null, booking_ref: 'NEWREF' });
        const rows = audit.recent(db.get(), 50).filter((r) => r.actor === 'admin' && /^flight_(created|updated|restored)$/.test(r.action));
        expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['flight_created', 'flight_updated', 'flight_restored']));
        const text = JSON.stringify(audit.recent(db.get(), 100));
        for (const v of ['NEWREF', 'OTHER1', REF]) expect(text).not.toContain(v);
    });

    test('cancelling is a status change; the flight stays in the list but leaves the Passport', async () => {
        const id = (await agent.get('/admin/api/flights?year=2024').expect(200)).body.flights[0].id;
        await agent.patch(`/admin/api/flights/${id}`).set(H).send({ status: 'cancelled' }).expect(200);
        const list = (await agent.get('/admin/api/flights?status=cancelled').expect(200)).body;
        expect(list.total).toBe(1);
        const s = (await agent.get('/admin/api/flights/stats?year=2024').expect(200)).body;
        expect(s.flights).toBe(0);
        await agent.patch(`/admin/api/flights/${id}`).set(H).send({ status: 'completed' }).expect(200);
    });

    test('trips: create, list with counts, assign a flight; bad titles refused', async () => {
        const t = (await agent.post('/admin/api/flights/trips').set(H).send({ title: 'Spring trip', start_date: '2026-02-01' }).expect(201)).body;
        expect(t.status).toBe('created');
        await agent.post('/admin/api/flights/trips').set(H).send({ title: '' }).expect(400);
        const id = (await agent.get('/admin/api/flights?year=2025').expect(200)).body.flights[0].id;
        await agent.patch(`/admin/api/flights/${id}`).set(H).send({ trip_id: t.id }).expect(200);
        const trips = (await agent.get('/admin/api/flights/trips').expect(200)).body.trips;
        expect(trips.find((x) => x.id === t.id)).toMatchObject({ title: 'Spring trip', flights: 1 });
        expect(audit.recent(db.get(), 50).some((r) => r.action === 'trip_created')).toBe(true);
    });

    test('settings: home airport must be a known airport; null clears; audited with key names only', async () => {
        expect((await agent.put('/admin/api/flights/settings').set(H).send({ home_airport: 'lit' }).expect(200)).body.home_airport).toBe('LIT');
        expect((await agent.get('/admin/api/flights/settings').expect(200)).body.home_airport).toBe('LIT');
        expect((await agent.put('/admin/api/flights/settings').set(H).send({ home_airport: 'ZZZ' }).expect(400)).body.code).toBe('bad_airport');
        expect((await agent.put('/admin/api/flights/settings').set(H).send({ home_airport: '1' }).expect(400)).body.code).toBeDefined();
        expect((await agent.get('/admin/api/flights/stats').expect(200)).body.settings.home_airport).toBe('LIT');
        expect((await agent.put('/admin/api/flights/settings').set(H).send({ home_airport: null }).expect(200)).body.home_airport).toBeNull();
        expect(audit.recent(db.get(), 50).some((r) => r.action === 'flight_settings_changed')).toBe(true);
    });

    test('the queue routes still win over /flights/:id', async () => {
        const r = (await agent.get('/admin/api/flights/candidates').expect(200)).body;
        expect(r.counts).toBeDefined();
    });
});
