process.env.HUB_DB_FILE = ':memory:';

// Every flight, booking reference and trip in this file is invented. Airports are real (the seed).
const db = require('../db');
const seed = require('../db/seed');
const flights = require('../services/flights');
const domains = require('../services/domains');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };
const flight = (extra = {}) => ({
    airline_iata: 'AA', flight_number: '1234', origin_iata: 'LIT', dest_iata: 'DFW',
    sched_dep: '2026-03-01T12:05:00Z', sched_arr: '2026-03-01T13:20:00Z', ...extra,
});
const add = (extra) => flights.create(conn, flight(extra), 'tester').id;
const NOW = new Date('2026-11-10T12:00:00Z');

describe('airports seed', () => {
    test('is loaded at open, with time zones, and a second load is skipped', () => {
        const n = conn.prepare('SELECT COUNT(*) AS n FROM airports').get().n;
        expect(n).toBeGreaterThan(5000);
        expect(conn.prepare('SELECT * FROM airports WHERE iata = ?').get('KTM')).toMatchObject({ country: 'NP', tz: 'Asia/Kathmandu' });
        expect(conn.prepare('SELECT COUNT(*) AS n FROM airports WHERE tz IS NULL').get().n).toBe(0);
        expect(seed.seedAirports(conn)).toBe(0);
        expect(db.health().migrations).toBe(conn.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name NOT LIKE 'seed:%'").get().n);
    });

    test('the build script keeps scheduled IATA airports and big ones, and the bigger of two with one code', () => {
        const { build } = require('../scripts/airports-build');
        const csv = [
            '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"',
            '1,"XAAA","small_airport","Tiny, Field",10,20,,,"US","US-AR","Town","yes","","AAA","XAAA",,,,',
            '2,"XBBB","small_airport","No service",10,20,,,"US","US-AR","Town","no","","BBB","",,,,',
            '3,"XCCC","large_airport","Big",10.123456,20,,,"US","US-AR","City","no","XCCC","CCC","",,,,',
            '4,"XAA2","closed","Old AAA",10,20,,,"US","US-AR","Town","yes","","AAA","",,,,',
            '5,"XDDD","medium_airport","No code",10,20,,,"US","US-AR","Town","yes","","","",,,,',
        ].join('\n');
        const out = build(csv, () => 'America/Chicago');
        expect(out.rows.map((r) => r[0])).toEqual(['AAA', 'CCC']);
        expect(out.rows[0]).toEqual(['AAA', 'XAAA', 'Tiny, Field', 'Town', 'US', 10, 20, 'America/Chicago']);
        expect(out.rows[1][5]).toBe(10.1235);
    });
});

describe('creating and deduping', () => {
    test('derives zones, the local date and the great-circle distance', () => {
        const made = flights.create(conn, flight({ airline_iata: 'aa', flight_number: 'AA 01234', booking_ref: 'xq7k2p' }), 'tester');
        expect(made).toEqual({ status: 'created', id: expect.any(Number), label: 'AA 1234 LIT-DFW 2026-03-01', rev: 1 });
        const f = flights.get(conn, made.id);
        expect(f).toMatchObject({
            airline_iata: 'AA', flight_number: '1234', dep_tz: 'America/Chicago', arr_tz: 'America/Chicago',
            dep_local: '2026-03-01T06:05', arr_local: '2026-03-01T07:20', dep_local_date: '2026-03-01',
            status: 'scheduled', source: 'manual', booking_ref: 'XQ7K2P', rev: 1, revisions: 1,
        });
        // LIT to DFW is about 489 km.
        expect(f.distance_km).toBeGreaterThan(480);
        expect(f.distance_km).toBeLessThan(500);
    });

    test('a time without an offset is airport time; the local date is the one in the origin zone', () => {
        // KTM is UTC+5:45; 00:30 local on 2 March is still 1 March in UTC.
        const id = add({ origin_iata: 'KTM', dest_iata: 'DOH', airline_iata: 'QR', flight_number: '651', sched_dep: '2026-03-02T00:30', sched_arr: '2026-03-02T03:45' });
        const f = flights.get(conn, id);
        expect(f.sched_dep).toBe('2026-03-01T18:45:00.000Z');
        expect(f.dep_local_date).toBe('2026-03-02');
        expect(f.sched_arr).toBe('2026-03-02T00:45:00.000Z');
    });

    test('an unknown airport is allowed: no distance, no zone, and a local time is refused', () => {
        const id = add({ origin_iata: 'QQZ' });
        expect(flights.get(conn, id)).toMatchObject({ distance_km: null, dep_tz: null, dep_local_date: '2026-03-01' });
        expect(code(() => add({ origin_iata: 'QQY', sched_dep: '2026-03-01T10:00' }))).toBe('bad_time');
    });

    test('the same flight twice is a 409 duplicate with the existing id, however it is written', () => {
        const id = add();
        let err;
        try { flights.create(conn, flight({ flight_number: 'AA1234', sched_dep: '2026-03-01T06:05', sched_arr: null }), 'tester'); } catch (e) { err = e; }
        expect(err).toMatchObject({ status: 409, code: 'duplicate', extra: { id } });
        // Another day, another origin or another airline is another flight.
        add({ sched_dep: '2026-03-02T12:05:00Z', sched_arr: null });
        add({ origin_iata: 'MEM' });
        add({ airline_iata: 'DL' });
        // The same source key is the same flight too.
        add({ flight_number: '9', source: 'gmail', source_key: 'h1' });
        expect(code(() => add({ flight_number: '10', source: 'gmail', source_key: 'h1' }))).toBe('duplicate');
    });

    test('refuses bad input without echoing it', () => {
        expect(code(() => add({ airline_iata: 'A' }))).toBe('bad_airline');
        expect(code(() => add({ flight_number: 'abc' }))).toBe('bad_flight_number');
        expect(code(() => add({ origin_iata: 'DFW' }))).toBe('bad_airport');
        expect(code(() => add({ sched_dep: 'tomorrow' }))).toBe('bad_time');
        expect(code(() => add({ sched_arr: '2026-03-01T11:00:00Z' }))).toBe('bad_time');
        expect(code(() => add({ sched_arr: '2026-03-03T11:00:00Z' }))).toBe('bad_time');
        expect(code(() => add({ status: 'landed' }))).toBe('bad_status');
        expect(code(() => add({ source: 'fax' }))).toBe('bad_source');
        expect(code(() => add({ trip_id: 99 }))).toBe('no_trip');
        expect(code(() => add({ dep_local_date: '2020-01-01' }))).toBe('bad_field');
        let err;
        try { add({ booking_ref: 'SECRET-REF-1' }); } catch (e) { err = e; }
        expect(err.code).toBe('bad_booking_ref');
        expect(err.message).not.toMatch(/SECRET/);
    });
});

describe('updates, history and restore', () => {
    test('update stores a revision; a no-op does not; restore goes back as a new revision; rev 1 is kept', () => {
        const id = add({ seat: '12a', booking_ref: 'ABC123' });
        expect(flights.update(conn, id, { seat: '12A' }, 'tester')).toMatchObject({ status: 'unchanged', rev: 1 });
        expect(flights.update(conn, id, { dest_iata: 'ORD', seat: '3C', note: 'rebooked' }, 'editor')).toMatchObject({ status: 'updated', rev: 2, label: 'AA 1234 LIT-ORD 2026-03-01' });
        const now = flights.get(conn, id);
        expect(now).toMatchObject({ dest_iata: 'ORD', seat: '3C', updated_by: 'editor', sched_dep: '2026-03-01T12:05:00.000Z' });
        expect(now.distance_km).toBeGreaterThan(800);

        expect(flights.get(conn, id, { rev: 1 })).toMatchObject({ dest_iata: 'DFW', seat: '12A', rev: 1, revisions: 2 });
        expect(flights.restore(conn, id, 1, 'tester')).toMatchObject({ status: 'updated', rev: 3 });
        const back = flights.get(conn, id);
        expect(back).toMatchObject({ dest_iata: 'DFW', seat: '12A', rev: 3 });
        expect(back.distance_km).toBeLessThan(500);
        expect(flights.restore(conn, id, 1, 'tester').status).toBe('unchanged');
        expect(flights.history(conn, id).map((r) => [r.rev, r.source, r.current])).toEqual([[3, 'restore', true], [2, 'edit', false], [1, 'create', false]]);
        const first = JSON.parse(conn.prepare('SELECT snapshot FROM flight_revisions WHERE flight_id = ? AND rev = 1').get(id).snapshot);
        expect(first).toMatchObject({ dest_iata: 'DFW', seat: '12A' });
        expect(code(() => flights.restore(conn, id, 9, 'tester'))).toBe('no_revision');
    });

    test('an edit that makes it another filed flight is a duplicate; cancelled is a status', () => {
        const a = add();
        const b = add({ flight_number: '99' });
        expect(code(() => flights.update(conn, b, { flight_number: '1234' }, 'tester'))).toBe('duplicate');
        expect(flights.update(conn, a, { status: 'cancelled' }, 'tester').status).toBe('updated');
        expect(code(() => flights.update(conn, a, { sched_dep: null }, 'tester'))).toBe('bad_request');
        expect(code(() => flights.update(conn, a, {}, 'tester'))).toBe('bad_request');
        expect(code(() => flights.update(conn, 999, { seat: '1A' }, 'tester'))).toBe('not_found');
    });
});

describe('list and upcoming', () => {
    test('filters by year, airport, airline, trip and status, newest first, with paging', () => {
        const trip = flights.createTrip(conn, { title: 'Spring', start_date: '2026-03-01', end_date: '2026-03-08' }, 'tester').id;
        const a = add({ trip_id: trip });
        const b = add({ airline_iata: 'DL', origin_iata: 'DFW', dest_iata: 'ATL', sched_dep: '2025-06-01T15:00:00Z', sched_arr: null });
        const c = add({ flight_number: '77', sched_dep: '2026-04-01T15:00:00Z', sched_arr: null, status: 'completed' });
        expect(flights.list(conn).flights.map((f) => f.id)).toEqual([c, a, b]);
        expect(flights.list(conn, { year: 2026 }).total).toBe(2);
        expect(flights.list(conn, { airport: 'atl' }).flights.map((f) => f.id)).toEqual([b]);
        expect(flights.list(conn, { airline: 'DL' }).flights.map((f) => f.id)).toEqual([b]);
        expect(flights.list(conn, { trip }).flights.map((f) => f.id)).toEqual([a]);
        expect(flights.list(conn, { status: 'completed' }).flights.map((f) => f.id)).toEqual([c]);
        expect(flights.list(conn, { limit: 1, offset: 1 })).toMatchObject({ total: 3, limit: 1, offset: 1, flights: [{ id: a }] });
        expect(code(() => flights.list(conn, { year: '26' }))).toBe('bad_year');
        expect(code(() => flights.list(conn, { status: 'x' }))).toBe('bad_status');
    });

    test('upcoming has flights not yet landed, soonest first, without cancelled ones', () => {
        add({ sched_dep: '2026-11-10T11:00:00Z', sched_arr: '2026-11-10T13:00:00Z' });  // in the air at NOW
        add({ flight_number: '2', sched_dep: '2026-12-20T15:00:00Z', sched_arr: null });
        add({ flight_number: '3', sched_dep: '2026-12-01T15:00:00Z', sched_arr: null, status: 'cancelled' });
        add({ flight_number: '4', sched_dep: '2026-01-01T15:00:00Z', sched_arr: null });
        expect(flights.upcoming(conn, { now: NOW }).map((f) => f.flight_number)).toEqual(['1234', '2']);
    });
});

describe('stats', () => {
    test('empty', () => {
        expect(flights.stats(conn, { now: NOW })).toMatchObject({
            flights: 0, distance_km: 0, hours: 0, airports: 0, countries: 0, airlines: 0, aircraft_types: 0,
            longest: null, shortest: null, top_routes: [], per_year: [], upcoming: 0, unmatched: { flights: 0, airports: [] },
        });
    });

    test('totals, records, routes and per-year numbers; cancelled and future flights are left out', () => {
        add({ aircraft_type: 'E175' });                                                        // 2026, 1h15
        add({ origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: '2026-03-08T18:00:00Z', sched_arr: '2026-03-08T19:15:00Z', aircraft_type: 'E175' });
        add({ airline_iata: 'QR', airline_name: 'Qatar Airways', flight_number: '730', origin_iata: 'DFW', dest_iata: 'DOH', sched_dep: '2025-05-01T21:00:00Z', sched_arr: '2025-05-02T12:30:00Z', aircraft_type: 'B77W' });
        add({ flight_number: '5', sched_dep: '2026-04-01T12:00:00Z', sched_arr: null, status: 'cancelled' });
        add({ flight_number: '6', sched_dep: '2026-12-01T12:00:00Z', sched_arr: null });
        const s = flights.stats(conn, { now: NOW });
        expect(s).toMatchObject({ flights: 3, airports: 3, countries: 2, airlines: 2, aircraft_types: 2, hours: 18, upcoming: 1 });
        expect(s.distance_km).toBeGreaterThan(13000);
        expect(s.longest).toMatchObject({ route: 'DFW-DOH', date: '2025-05-01' });
        expect(s.shortest.route).toMatch(/LIT-DFW|DFW-LIT/);
        expect(s.top_routes[0]).toEqual({ route: 'DFW-LIT', flights: 2 });
        expect(s.top_airports[0]).toMatchObject({ iata: 'DFW', visits: 3, country: 'US' });
        expect(s.top_airlines).toEqual([{ iata: 'AA', name: null, flights: 2 }, { iata: 'QR', name: 'Qatar Airways', flights: 1 }]);
        expect(s.country_list).toEqual(['QA', 'US']);
        expect(s.per_year.map((p) => [p.year, p.flights, p.hours])).toEqual([['2025', 1, 15.5], ['2026', 2, 2.5]]);
        expect(JSON.stringify(s)).not.toMatch(/booking|seat|notes/);
    });

    test('one year, and unknown airports are counted under unmatched without breaking anything', () => {
        add({ booking_ref: 'ZZ9ZZ9' });
        add({ airline_iata: 'ZZ', flight_number: '1', origin_iata: 'QQZ', dest_iata: 'DFW', sched_dep: '2026-05-01T12:00:00Z', sched_arr: null });
        add({ flight_number: '2', sched_dep: '2024-05-01T12:00:00Z', sched_arr: null });
        const s = flights.stats(conn, { year: '2026', now: NOW });
        expect(s).toMatchObject({ year: '2026', flights: 2, airports: 3, countries: 1, unmatched: { flights: 1, airports: ['QQZ'] } });
        expect(s.longest.route).toBe('LIT-DFW');
        expect(s.per_year.map((p) => p.year)).toEqual(['2024', '2026']);
        expect(s.top_airports.find((a) => a.iata === 'QQZ')).toMatchObject({ name: null, visits: 1 });
        expect(JSON.stringify(s)).not.toMatch(/ZZ9ZZ9/);
        expect(flights.stats(conn, { year: '2019', now: NOW }).flights).toBe(0);
    });

    test('haversine', () => {
        expect(flights.haversineKm(0, 0, 0, 0)).toBe(0);
        expect(Math.round(flights.haversineKm(0, 0, 0, 180))).toBe(20015);
    });
});

describe('trips and settings', () => {
    test('trips: create, list with counts, get with flights, update', () => {
        const t = flights.createTrip(conn, { title: ' Nepal ', start_date: '2026-06-01', end_date: '2026-07-01' }, 'tester');
        expect(t).toEqual({ status: 'created', id: expect.any(Number), title: 'Nepal' });
        add({ trip_id: t.id });
        expect(flights.listTrips(conn)).toMatchObject([{ id: t.id, title: 'Nepal', flights: 1 }]);
        expect(flights.getTrip(conn, t.id).flights).toHaveLength(1);
        expect(flights.updateTrip(conn, t.id, { notes: 'Summer' }, 'tester').status).toBe('updated');
        expect(flights.updateTrip(conn, t.id, { notes: 'Summer' }, 'tester').status).toBe('unchanged');
        expect(code(() => flights.updateTrip(conn, t.id, { end_date: '2026-05-01' }, 'tester'))).toBe('bad_date');
        expect(code(() => flights.createTrip(conn, { title: '' }, 'tester'))).toBe('bad_request');
        expect(code(() => flights.getTrip(conn, 99))).toBe('no_trip');
    });

    test('settings: home_airport must be a known airport; null clears it; unknown keys are refused', () => {
        expect(flights.getSettings(conn)).toEqual({ home_airport: null });
        expect(flights.putSettings(conn, { home_airport: 'lit' }, 'tester')).toEqual({ home_airport: 'LIT' });
        expect(code(() => flights.putSettings(conn, { home_airport: 'QQZ' }, 'tester'))).toBe('bad_airport');
        expect(code(() => flights.putSettings(conn, { theme: 'x' }, 'tester'))).toBe('bad_setting');
        expect(flights.putSettings(conn, { home_airport: null }, 'tester')).toEqual({ home_airport: null });
    });

    test('the domain is registered, private, and its tile counts flights', () => {
        add();
        expect(domains.list(conn).find((d) => d.name === 'flights')).toMatchObject({ sensitivity: 'private', storage: 'db', enabled: true, records: 1, recordLabel: 'flight' });
    });
});
