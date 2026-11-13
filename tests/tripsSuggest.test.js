// Suggested trips from flights that have no trip, and the admin-only accept / dismiss / restore-dismissed.
// Every flight, booking reference and trip here is invented. Each test uses its own year, so tests stay independent.
const KEY = 's'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const flights = require('../services/flights');
const trips = require('../services/trips');
const suggest = require('../services/tripSuggest');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const REF = 'SUGREF31PQ';
const conn = () => db.get();
let admin;
let num = 100;

beforeAll(async () => {
    admin = request.agent(app);
    await admin.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

// One flight: from, to, departure and arrival as UTC ISO. Returns its id.
const fly = (from, to, dep, arr, extra = {}) => {
    num += 1;
    return flights.create(conn(), { airline_iata: 'ZZ', flight_number: String(num), origin_iata: from, dest_iata: to, sched_dep: dep, sched_arr: arr, booking_ref: REF, ...extra }, 'test').id;
};
const inYear = (y) => suggest.suggest(conn()).suggestions.filter((s) => s.start_date.startsWith(String(y)));
const setHome = (code) => flights.putSettings(conn(), { home_airport: code }, 'test');
const code = (fn) => { try { fn(); return 'no error'; } catch (err) { return err.code; } };

describe('no home airport', () => {
    test('suggests nothing and says why', async () => {
        fly('LIT', 'DFW', '2090-01-10T14:00:00Z', '2090-01-10T15:10:00Z');
        fly('DFW', 'LIT', '2090-01-12T14:00:00Z', '2090-01-12T15:10:00Z');
        expect(suggest.suggest(conn())).toMatchObject({ needs_home_airport: true, home_airport: null, suggestions: [] });
        const body = (await admin.get('/admin/api/trips/suggestions').expect(200)).body;
        expect(body.needs_home_airport).toBe(true);
        setHome('LIT');
        expect(inYear(2090)).toHaveLength(1);
    });
});

describe('chain rules', () => {
    test('a round trip from home: title from the turnaround city and the start month', () => {
        const ids = [
            fly('LIT', 'DFW', '2091-01-10T12:00:00Z', '2091-01-10T13:10:00Z'),
            fly('DFW', 'HKG', '2091-01-10T16:00:00Z', '2091-01-11T22:00:00Z'),
            fly('HKG', 'DFW', '2091-01-20T02:00:00Z', '2091-01-20T16:00:00Z'),
            fly('DFW', 'LIT', '2091-01-20T19:00:00Z', '2091-01-20T20:10:00Z'),
        ];
        const [s] = inYear(2091);
        expect(s).toMatchObject({
            key: [...ids].sort((a, b) => a - b).join(','), title: 'Hong Kong Jan 2091', start_date: '2091-01-10', end_date: '2091-01-20',
            flight_ids: ids, flight_count: 4, route: ['LIT', 'DFW', 'HKG', 'DFW', 'LIT'],
        });
        expect(JSON.stringify(s)).not.toContain(REF);
    });

    test('a multi-leg trip stays one chain however long the stops; the longest stop names it', () => {
        fly('LIT', 'DFW', '2092-05-01T12:00:00Z', '2092-05-01T13:10:00Z');
        fly('DFW', 'LHR', '2092-05-01T22:00:00Z', '2092-05-02T12:00:00Z');
        fly('LHR', 'CDG', '2092-05-06T09:00:00Z', '2092-05-06T10:20:00Z');
        fly('CDG', 'DOH', '2092-05-20T09:00:00Z', '2092-05-20T17:00:00Z');
        fly('DOH', 'DFW', '2092-05-21T02:00:00Z', '2092-05-21T14:00:00Z');
        fly('DFW', 'LIT', '2092-05-21T18:00:00Z', '2092-05-21T19:10:00Z');
        const s = inYear(2092);
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({ flight_count: 6, start_date: '2092-05-01', end_date: '2092-05-21' });
        expect(s[0].title).toMatch(/^Paris .* May 2092$/);
    });

    test('away from home, a gap of more than 2 days splits the chain; loose single flights are not proposed', () => {
        fly('LHR', 'CDG', '2093-03-01T09:00:00Z', '2093-03-01T10:20:00Z');
        fly('CDG', 'LHR', '2093-03-03T09:00:00Z', '2093-03-03T10:20:00Z'); // gap 2 days: same chain
        fly('LHR', 'KTM', '2093-03-10T09:00:00Z', '2093-03-10T23:00:00Z'); // gap 7 days: new chain
        fly('KTM', 'DOH', '2093-03-11T09:00:00Z', '2093-03-11T12:00:00Z');
        fly('NRT', 'HKG', '2093-06-01T09:00:00Z', '2093-06-01T13:00:00Z'); // alone
        const s = inYear(2093);
        expect(s.map((x) => x.route)).toEqual([['LHR', 'CDG', 'LHR'], ['LHR', 'KTM', 'DOH']]);
    });

    test('a new departure from home closes a chain that never came back', () => {
        fly('LIT', 'DFW', '2094-02-01T12:00:00Z', '2094-02-01T13:00:00Z');
        fly('DFW', 'NRT', '2094-02-01T16:00:00Z', '2094-02-02T08:00:00Z');
        fly('LIT', 'DFW', '2094-04-01T12:00:00Z', '2094-04-01T13:00:00Z');
        fly('DFW', 'LIT', '2094-04-03T12:00:00Z', '2094-04-03T13:00:00Z');
        expect(inYear(2094).map((x) => x.route)).toEqual([['LIT', 'DFW', 'NRT'], ['LIT', 'DFW', 'LIT']]);
    });

    test('flights already on a trip and cancelled flights are left out', () => {
        const a = fly('LIT', 'DFW', '2095-02-01T12:00:00Z', '2095-02-01T13:00:00Z');
        fly('DFW', 'LIT', '2095-02-05T12:00:00Z', '2095-02-05T13:00:00Z');
        expect(inYear(2095)).toHaveLength(1);
        const t = trips.create(conn(), { title: 'Already filed' }, 'test').id;
        trips.linkFlight(conn(), t, a, 'test');
        expect(inYear(2095)).toHaveLength(0); // the return alone is not a trip
        fly('LIT', 'DFW', '2095-06-01T12:00:00Z', '2095-06-01T13:00:00Z', { status: 'cancelled' });
        fly('DFW', 'LIT', '2095-06-05T12:00:00Z', '2095-06-05T13:00:00Z');
        expect(inYear(2095)).toHaveLength(0);
    });
});

describe('accept, dismiss, restore (admin only)', () => {
    test('accept creates the trip, links the flights, audits; a stale key is refused', async () => {
        const ids = [fly('LIT', 'DFW', '2096-03-01T12:00:00Z', '2096-03-01T13:00:00Z'), fly('DFW', 'LIT', '2096-03-04T12:00:00Z', '2096-03-04T13:00:00Z')];
        const [s] = inYear(2096);
        await admin.post('/admin/api/trips/suggestions/accept').send({ key: s.key }).expect(403); // no X-Requested-With
        await request(app).post('/admin/api/trips/suggestions/accept').set(H).send({ key: s.key }).expect(401);
        const r = (await admin.post('/admin/api/trips/suggestions/accept').set(H).send({ key: s.key, title: 'Dallas weekend' }).expect(201)).body;
        expect(r).toMatchObject({ status: 'accepted', title: 'Dallas weekend', key: s.key, flight_ids: ids });
        const t = trips.get(conn(), r.id);
        expect(t).toMatchObject({ kind: 'other', start_date: '2096-03-01', end_date: '2096-03-04', flight_count: 2 });
        const row = audit.recent(conn(), 5, { actions: ['trip_suggestion_accepted'] })[0];
        expect(row).toMatchObject({ actor: 'admin', detail: { key: s.key, id: r.id, title: 'Dallas weekend' } });
        expect(JSON.stringify(row)).not.toContain(REF);
        // The same key again: the flights are on a trip now, so it is no longer proposed.
        expect((await admin.post('/admin/api/trips/suggestions/accept').set(H).send({ key: s.key }).expect(409)).body.code).toBe('stale_suggestion');
        await admin.post('/admin/api/trips/suggestions/accept').set(H).send({ key: 'drop table' }).expect(400);
        await admin.post('/admin/api/trips/suggestions/accept').set(H).send({}).expect(400);
    });

    test('dismiss hides a suggestion; restore-dismissed brings it back; both audited', async () => {
        fly('LIT', 'DFW', '2097-03-01T12:00:00Z', '2097-03-01T13:00:00Z');
        fly('DFW', 'LIT', '2097-03-04T12:00:00Z', '2097-03-04T13:00:00Z');
        const [s] = inYear(2097);
        const d = (await admin.post('/admin/api/trips/suggestions/dismiss').set(H).send({ key: s.key }).expect(200)).body;
        expect(d).toMatchObject({ status: 'dismissed', key: s.key });
        expect(inYear(2097)).toHaveLength(0);
        expect(suggest.suggest(conn()).dismissed).toBeGreaterThanOrEqual(1);
        await admin.post('/admin/api/trips/suggestions/dismiss').set(H).send({ key: s.key }).expect(409);
        expect(code(() => suggest.accept(conn(), { key: s.key }, 'admin'))).toBe('stale_suggestion');
        expect(audit.recent(conn(), 5, { actions: ['trip_suggestion_dismissed'] })[0]).toMatchObject({ actor: 'admin', detail: { key: s.key } });
        const back = (await admin.post('/admin/api/trips/suggestions/restore-dismissed').set(H).send({}).expect(200)).body;
        expect(back.status).toBe('restored');
        expect(inYear(2097)).toHaveLength(1);
        expect(audit.recent(conn(), 5, { actions: ['trip_suggestions_restored'] })[0]).toMatchObject({ actor: 'admin' });
        expect((await admin.post('/admin/api/trips/suggestions/restore-dismissed').set(H).send({}).expect(200)).body.status).toBe('unchanged');
    });

    test('accept and dismiss do not exist over /hub', async () => {
        const key = apiKeys.create(conn(), { name: 'sug-writer', scopes: 'trips:read, trips:api-write' }).key;
        const res = await request(app).post('/hub/trips/suggestions/accept').set({ Authorization: `Bearer ${key}` }).send({ key: '1,2' });
        expect([404, 405]).toContain(res.status);
        expect(conn().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'trip_suggestion%' AND actor = 'sug-writer'").get().n).toBe(0);
    });
});
