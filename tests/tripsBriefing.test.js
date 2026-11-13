process.env.HUB_DB_FILE = ':memory:';

// The trips briefing hook: ongoing trips, trips starting inside the horizon and linked deadlines due before a trip.
// Every trip, deadline, reference and note here is invented. The hub zone is America/Chicago (the default).
const db = require('../db');
const trips = require('../services/trips');
const items = require('../services/tripItems');
const deadlines = require('../services/deadlines');
const briefing = require('../services/briefing');
const hooks = require('../services/briefingHooks');

const NOW = new Date('2099-11-14T18:00:00Z'); // noon on 2099-11-14 in Chicago
const REF = 'BRIEFREF-8812';
const NOTE = 'briefing canary note marigold';
const conn = () => db.get();
const ids = {};

const trip = (title, extra = {}) => trips.create(conn(), { title, notes: NOTE, ...extra }, 'seed').id;
const due = (tripId, title, date, extra = {}) => deadlines.create(conn(), { title, due_date: date, trip_id: tripId, reference: REF, ...extra }, 'seed').id;
const run = (days = 14, now = NOW) => hooks.trips(conn(), { now, days });
const all = (r) => [...r.attention, ...r.upcoming];
const byId = (r, id) => all(r).find((i) => i.id === id);

beforeAll(() => {
    ids.hk = trip('Hong Kong trip', { destination: 'Hong Kong', start_date: '2099-11-12', end_date: '2099-11-20' });
    items.add(conn(), ids.hk, { title: 'Hotel', place: 'Invented Road 1', reference: REF }, 'seed');
    ids.lisbon = trip('Lisbon conference', { start_date: '2099-11-19', end_date: '2099-11-25' });
    ids.d4days = due(ids.lisbon, 'Visa letter', '2099-11-18');
    ids.d2days = due(ids.lisbon, 'Passport renewal', '2099-11-16');
    ids.dOver = due(ids.lisbon, 'Travel insurance', '2099-11-10');
    ids.dOnStart = due(ids.lisbon, 'Conference fee', '2099-11-19');
    ids.dAfter = due(ids.lisbon, 'Expense report', '2099-11-30');
    ids.dDone = due(ids.lisbon, 'Book hotel', '2099-11-15');
    deadlines.done(conn(), ids.dDone, 'seed');
    ids.far = trip('Far trip', { destination: 'Kathmandu', start_date: '2099-12-04' });          // 20 days away
    due(ids.far, 'Far visa', '2099-11-01');                                                       // overdue, but the trip is > 14 days away
    ids.cancelled = trip('Called off', { start_date: '2099-11-17', end_date: '2099-11-18', status_override: 'cancelled' });
    due(ids.cancelled, 'Cancelled trip task', '2099-11-15');
    ids.past = trip('Last month', { start_date: '2099-10-01', end_date: '2099-10-05' });
    ids.today = trip('Day out', { start_date: '2099-11-14' });                                    // one date: a one-day trip
    ids.edge14 = trip('Edge 14', { start_date: '2099-11-28' });
    ids.edge15 = trip('Edge 15', { start_date: '2099-11-29' });
    ids.undated = trip('Someday');
});
afterAll(() => db.close());

describe('trips briefing hook', () => {
    test('is registered on the trips domain', () => {
        expect(typeof require('../services/domains').REGISTRY.trips.briefing).toBe('function');
    });

    test('an ongoing trip: day n of m, back on the last day (destination when set)', () => {
        expect(byId(run(), `trips:${ids.hk}:ongoing-2099-11-12`)).toMatchObject({ severity: 'info', text: 'Hong Kong: day 3 of 9, back Nov 20', ref: { domain: 'trips', id: ids.hk } });
        expect(byId(run(), `trips:${ids.today}:ongoing-2099-11-14`)).toMatchObject({ severity: 'info', text: 'Day out: today, a one-day trip' });
    });

    test('a trip starting inside the horizon (title when there is no destination), edges included', () => {
        expect(byId(run(), `trips:${ids.lisbon}:starts-2099-11-19`)).toMatchObject({ severity: 'info', text: 'Lisbon conference starts in 5 days (Nov 19)' });
        expect(byId(run(14), `trips:${ids.edge14}:starts-2099-11-28`)).toBeDefined();
        expect(byId(run(14), `trips:${ids.edge15}:starts-2099-11-29`)).toBeUndefined();
        expect(byId(run(15), `trips:${ids.edge15}:starts-2099-11-29`)).toBeDefined();
        expect(byId(run(14), `trips:${ids.far}:starts-2099-12-04`)).toBeUndefined();
        expect(byId(run(30), `trips:${ids.far}:starts-2099-12-04`)).toBeDefined();
    });

    test('deadline pressure: active linked deadlines overdue or due on or before the start, within 14 days', () => {
        const r = run();
        expect(byId(r, `trips:${ids.lisbon}:deadline-${ids.d4days}`)).toMatchObject({ severity: 'attention', text: 'Visa letter is due before the Lisbon conference trip (starts in 5 days)', date: '2099-11-18' });
        expect(byId(r, `trips:${ids.lisbon}:deadline-${ids.d2days}`)).toMatchObject({ severity: 'urgent' });
        expect(byId(r, `trips:${ids.lisbon}:deadline-${ids.dOver}`)).toMatchObject({ severity: 'urgent' });
        expect(byId(r, `trips:${ids.lisbon}:deadline-${ids.dOnStart}`)).toMatchObject({ severity: 'attention' });
        expect(byId(r, `trips:${ids.lisbon}:deadline-${ids.dAfter}`)).toBeUndefined();
        expect(byId(r, `trips:${ids.lisbon}:deadline-${ids.dDone}`)).toBeUndefined();
        expect(all(r).filter((i) => i.id.startsWith(`trips:${ids.far}:deadline-`))).toEqual([]);
        expect(r.attention.every((i) => i.id.includes(':deadline-'))).toBe(true);
    });

    test('cancelled, past and undated trips give nothing', () => {
        const r = run(90);
        for (const id of [ids.cancelled, ids.past, ids.undated]) expect(all(r).filter((i) => i.id.startsWith(`trips:${id}:`))).toEqual([]);
    });

    test('ids are stable: a new title keeps them, new dates make new ones', () => {
        const before = all(run()).map((i) => i.id).sort();
        trips.update(conn(), ids.lisbon, { title: 'Lisbon summit', destination: 'Lisbon' }, 'test');
        const after = run();
        expect(all(after).map((i) => i.id).sort()).toEqual(before);
        expect(byId(after, `trips:${ids.lisbon}:starts-2099-11-19`).text).toBe('Lisbon starts in 5 days (Nov 19)');
        trips.update(conn(), ids.lisbon, { start_date: '2099-11-20' }, 'test');
        expect(byId(run(), `trips:${ids.lisbon}:starts-2099-11-19`)).toBeUndefined();
        expect(byId(run(), `trips:${ids.lisbon}:starts-2099-11-20`)).toBeDefined();
        trips.update(conn(), ids.lisbon, { title: 'Lisbon conference', destination: null, start_date: '2099-11-19' }, 'test');
    });

    test('the same id every day of a trip; severity escalates as the deadline nears', () => {
        const tomorrow = new Date('2099-11-15T18:00:00Z');
        expect(byId(run(14, tomorrow), `trips:${ids.hk}:ongoing-2099-11-12`).text).toBe('Hong Kong: day 4 of 9, back Nov 20');
        expect(byId(run(14, tomorrow), `trips:${ids.lisbon}:deadline-${ids.d4days}`).severity).toBe('urgent'); // 3 days left
    });

    test('text carries titles and dates only: no references, notes, places', () => {
        const text = JSON.stringify(run(90));
        for (const secret of [REF, NOTE, 'Invented Road']) expect(text).not.toContain(secret);
    });

    test('collect() includes the trips items with the domain set', () => {
        const out = briefing.collect(conn(), { now: NOW, days: 14, cap: Infinity });
        const mine = [...out.attention, ...out.upcoming].filter((i) => i.domain === 'trips');
        expect(mine.length).toBeGreaterThanOrEqual(6);
        expect(JSON.stringify(out)).not.toContain(REF);
    });
});
