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
        expect((await as(reader).get(`/hub/flights/${made.id}?rev=1`).expect(200)).body).toMatchObject({ seat: '14C', status: 'completed', status_override: null });
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

describe('found flights (candidates) over REST', () => {
    const flightsSvc = require('../services/flights');
    const found = (extra = {}) => ({
        airline_iata: 'DL', flight_number: '7101', origin_iata: 'MEM', dest_iata: 'ATL',
        sched_dep: '2026-06-01T09:00', sched_arr: '2026-06-01T11:40', source: 'gmail', source_key: 'h:7101', confidence: 0.9, booking_ref: BOOKING, ...extra,
    });

    test('flights:suggest files a candidate (201) and its answer has no booking reference', async () => {
        const r = (await as(suggester).post('/hub/flights/candidates', found()).expect(201)).body;
        expect(r.status).toBe('filed');
        expect(r.candidate).toMatchObject({ airline_iata: 'DL', flight_number: '7101', status: 'pending', source: 'gmail', confidence: 0.9, dep_local: '2026-06-01T09:00' });
        expect(r.candidate.sched_dep).toBe('2026-06-01T14:00:00.000Z'); // MEM is UTC-5 in June
        expect(JSON.stringify(r)).not.toContain(BOOKING);
    });

    test('filing the same flight again is 200 with the existing candidate, by source key or by flight key', async () => {
        const again = (await as(suggester).post('/hub/flights/candidates', found()).expect(200)).body;
        expect(again.status).toBe('already_suggested');
        const byKey = (await as(suggester).post('/hub/flights/candidates', found({ flight_number: '7999', source_key: 'h:7101' })).expect(200)).body;
        expect(byKey.candidate.id).toBe(again.candidate.id);
        const byFlight = (await as(suggester).post('/hub/flights/candidates', found({ source_key: 'h:other', source: 'calendar' })).expect(200)).body;
        expect(byFlight.candidate.id).toBe(again.candidate.id);
        expect(JSON.stringify([again, byKey, byFlight])).not.toContain(BOOKING);
    });

    test('a flight that is already filed answers 200 exists with its id and files nothing', async () => {
        const id = (await as(writer).post('/hub/flights', flight({ flight_number: '7102', sched_dep: '2026-06-03T12:00:00Z', sched_arr: '2026-06-03T13:00:00Z' })).expect(201)).body.id;
        const r = (await as(suggester).post('/hub/flights/candidates', flight({ flight_number: '7102', sched_dep: '2026-06-03T12:00:00Z', sched_arr: null })).expect(200)).body;
        expect(r).toEqual({ status: 'exists', flight: { id, label: 'AA 7102 LIT-DFW 2026-06-03' } });
        expect(flightsSvc.listCandidates(db.get(), { status: 'all' }).some((c) => c.flight_number === '7102')).toBe(false);
    });

    test('bad input is 400 and echoes no value', async () => {
        const r = (await as(suggester).post('/hub/flights/candidates', found({ flight_number: '7103', source_key: 'h:7103', confidence: 3 })).expect(400)).body;
        expect(r.code || r.error).toMatch(/confidence/);
        await as(suggester).post('/hub/flights/candidates', found({ flight_number: '7103', source: 'feed' })).expect(400);
        await as(suggester).post('/hub/flights/candidates', found({ flight_number: '7103', trip_id: 1 })).expect(400);
    });

    test('scope split: suggest only files; reading the queue needs flights:read; read alone cannot file', async () => {
        await as(suggester).get('/hub/flights/candidates').expect(403);
        await as(reader).post('/hub/flights/candidates', found({ flight_number: '7104', source_key: 'h:7104' })).expect(403);
        await as(other).post('/hub/flights/candidates', found({ flight_number: '7104', source_key: 'h:7104' })).expect(403);
        const list = (await as(reader).get('/hub/flights/candidates').expect(200)).body;
        expect(list.status).toBe('pending');
        expect(list.counts.pending).toBeGreaterThanOrEqual(1);
        expect(list.candidates.find((c) => c.flight_number === '7101').booking_ref).toBe(BOOKING); // REST read answers carry it
        await as(reader).get('/hub/flights/candidates?status=nope').expect(400);
    });

    test('accept and dismiss are not on /hub', async () => {
        const id = flightsSvc.listCandidates(db.get())[0].id;
        for (const key of [writer, suggester, reader]) {
            await as(key).post(`/hub/flights/candidates/${id}/accept`, {}).expect(404);
            await as(key).post(`/hub/flights/candidates/${id}/dismiss`, {}).expect(404);
        }
    });

    test('filing is audited with the flight label only', async () => {
        const rows = audit.recent(db.get(), 300).filter((e) => e.action === 'flight_candidate_filed');
        expect(rows.length).toBe(1);
        expect(rows[0].detail).toEqual({ id: expect.any(Number), flight: 'DL 7101 MEM-ATL 2026-06-01' });
        expect(JSON.stringify(audit.recent(db.get(), 500))).not.toContain(BOOKING);
    });

    test('a switched-off domain answers 503 to suggest', async () => {
        domains.setEnabled(db.get(), 'flights', false, 'test');
        try {
            await as(suggester).post('/hub/flights/candidates', found({ flight_number: '7105', source_key: 'h:7105' })).expect(503);
        } finally {
            domains.setEnabled(db.get(), 'flights', true, 'test');
        }
    });
});

describe('found flights (candidates): service', () => {
    const f = require('../services/flights');
    const c = (n, extra = {}) => ({ airline_iata: 'UA', flight_number: String(n), origin_iata: 'ORD', dest_iata: 'SFO', sched_dep: '2026-08-0' + (n % 9 + 1) + 'T08:00Z', source: 'calendar', source_key: `cal:${n}`, ...extra });

    test('accept creates the flight through create (with overrides) and links it', () => {
        const conn = db.get();
        const cand = f.suggest(conn, c(7201, { booking_ref: 'ZZ11AA', seat: '3a' }), 'job').candidate;
        const r = f.acceptCandidate(conn, cand.id, { seat: '4B', notes: 'window' }, 'admin');
        expect(r.status).toBe('accepted');
        expect(r.candidate).toMatchObject({ status: 'accepted', accepted_flight_id: r.flight.id, decided_by: 'admin' });
        const fl = f.get(conn, r.flight.id);
        expect(fl).toMatchObject({ seat: '4B', notes: 'window', booking_ref: 'ZZ11AA', source: 'calendar', source_key: 'cal:7201', rev: 1 });
        expect(() => f.acceptCandidate(conn, cand.id, null, 'admin')).toThrow(expect.objectContaining({ code: 'already_accepted', status: 409 }));
        expect(() => f.dismissCandidate(conn, cand.id, 'admin')).toThrow(expect.objectContaining({ code: 'already_accepted' }));
        expect(() => f.acceptCandidate(conn, cand.id, { source: 'gmail' }, 'admin')).toThrow(expect.objectContaining({ code: 'bad_field' }));
        // Found again after accepting: it is a flight now.
        expect(f.suggest(conn, c(7201), 'job').status).toBe('exists');
    });

    test('accept of a flight filed meanwhile is 409 duplicate and leaves the candidate pending', () => {
        const conn = db.get();
        const cand = f.suggest(conn, c(7202), 'job').candidate;
        const made = f.create(conn, { ...c(7202), source: 'manual', source_key: null }, 'person');
        expect(() => f.acceptCandidate(conn, cand.id, null, 'admin')).toThrow(expect.objectContaining({ code: 'duplicate', status: 409, extra: { id: made.id } }));
        expect(f.listCandidates(conn, { status: 'all' }).find((x) => x.id === cand.id).status).toBe('pending');
    });

    test('accept-all handles each id on its own', () => {
        const conn = db.get();
        const a = f.suggest(conn, c(7203), 'job').candidate.id;
        const b = f.suggest(conn, c(7204), 'job').candidate.id;
        const dup = f.listCandidates(conn).find((x) => x.flight_number === '7202').id;
        const r = f.acceptAll(conn, [a, 999999, dup, b, 'x'], 'admin');
        expect(r.accepted).toBe(2);
        expect(r.failed).toBe(3);
        expect(r.results.map((x) => [x.status, x.error || null])).toEqual([
            ['accepted', null], ['error', 'not_found'], ['error', 'duplicate'], ['accepted', null], ['error', 'not_found'],
        ]);
        expect(r.results[2].flight_id).toEqual(expect.any(Number));
        expect(() => f.acceptAll(conn, [], 'admin')).toThrow(expect.objectContaining({ code: 'bad_request' }));
        expect(() => f.acceptAll(conn, new Array(101).fill(a), 'admin')).toThrow(expect.objectContaining({ code: 'bad_request' }));
    });

    test('dismiss: stays dismissed when found again; counts', () => {
        const conn = db.get();
        const cand = f.suggest(conn, c(7205), 'job').candidate;
        expect(f.dismissCandidate(conn, cand.id, 'admin').status).toBe('dismissed');
        expect(f.dismissCandidate(conn, cand.id, 'admin').status).toBe('unchanged');
        const again = f.suggest(conn, c(7205), 'job');
        expect(again).toMatchObject({ status: 'already_suggested', candidate: { id: cand.id, status: 'dismissed' } });
        const counts = f.candidateCounts(conn);
        expect(counts.dismissed).toBeGreaterThanOrEqual(1);
        expect(counts.accepted).toBeGreaterThanOrEqual(3);
        expect(f.listCandidates(conn, { status: 'dismissed' }).map((x) => x.id)).toContain(cand.id);
    });
});

describe('found flights: flight_status end to end', () => {
    const f = require('../services/flights');
    const found = (n, extra = {}) => ({
        airline_iata: 'NK', flight_number: String(n), origin_iata: 'DFW', dest_iata: 'LAS', sched_dep: '2026-05-09T08:00',
        source: 'gmail', source_key: `h:${n}`, confidence: 0.5, ...extra,
    });

    test('REST: flight_status is filed, shown on the candidate, and accepting makes a cancelled flight', async () => {
        const r = (await as(suggester).post('/hub/flights/candidates', found(910, { flight_status: 'cancelled' })).expect(201)).body;
        expect(r.candidate).toMatchObject({ flight_status: 'cancelled', status: 'pending' });
        const plain = (await as(suggester).post('/hub/flights/candidates', found(911)).expect(201)).body;
        expect(plain.candidate.flight_status).toBeNull();
        await as(suggester).post('/hub/flights/candidates', found(912, { flight_status: 'landed' })).expect(400);
        const list = (await as(reader).get('/hub/flights/candidates').expect(200)).body.candidates;
        expect(list.find((c) => c.flight_number === '910').flight_status).toBe('cancelled');
        const accepted = f.acceptCandidate(db.get(), r.candidate.id, null, 'admin');
        expect(accepted.flight).toMatchObject({ status: 'created' });
        expect((await as(reader).get(`/hub/flights/${accepted.flight.id}`).expect(200)).body).toMatchObject({ status: 'cancelled', status_override: 'cancelled' });
        const p = f.acceptCandidate(db.get(), plain.candidate.id, null, 'admin');
        expect((await as(reader).get(`/hub/flights/${p.flight.id}`).expect(200)).body).toMatchObject({ status: 'completed', status_override: null });
    });

    test('service: auto and scheduled mean no status, completed is kept, an override can clear it', () => {
        const conn = db.get();
        expect(f.suggest(conn, found(913, { flight_status: 'auto' }), 'job').candidate.flight_status).toBeNull();
        expect(f.suggest(conn, found(914, { flight_status: 'scheduled' }), 'job').candidate.flight_status).toBeNull();
        const c = f.suggest(conn, found(915, { flight_status: 'completed' }), 'job').candidate;
        expect(c.flight_status).toBe('completed');
        const fl = f.acceptCandidate(conn, c.id, { status: 'auto' }, 'admin').flight;
        expect(f.get(conn, fl.id)).toMatchObject({ status_override: null });
        expect(f.CANDIDATE_FLIGHT_STATUSES).toEqual(['cancelled', 'completed']);
    });
});
