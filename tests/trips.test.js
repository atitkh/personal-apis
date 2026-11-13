process.env.HUB_DB_FILE = ':memory:';

// The trips service. Every trip, flight, booking reference and deadline in this file is invented. Airports are real.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');
const trips = require('../services/trips');
const flights = require('../services/flights');
const deadlines = require('../services/deadlines');
const domains = require('../services/domains');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };
const REF = 'BKREF77Q';
const NOW = new Date('2026-11-10T18:00:00Z'); // 2026-11-10 in America/Chicago
const add = (extra = {}) => trips.create(conn, { title: 'Hong Kong', ...extra }, 'tester').id;
const flight = (num, extra = {}) => flights.create(conn, {
    airline_iata: 'CX', flight_number: String(num), origin_iata: 'DFW', dest_iata: 'HKG', sched_dep: '2026-12-01T15:00:00Z',
    booking_ref: REF, ...extra,
}, 'tester').id;
const deadline = (extra = {}) => deadlines.create(conn, { title: 'Passport renewal', kind: 'document', due_date: '2026-11-20', reference: 'P-123', amount_cents: null, ...extra }, 'tester').id;

describe('create and validation', () => {
    test('files a trip with defaults and revision 1', () => {
        const r = trips.create(conn, { title: '  Hong Kong ', destination: 'Hong Kong', start_date: '2026-12-01', end_date: '2026-12-10' }, 'tester');
        expect(r).toEqual({ status: 'created', id: 1, title: 'Hong Kong', rev: 1 });
        expect(trips.get(conn, 1, { now: NOW })).toMatchObject({
            title: 'Hong Kong', destination: 'Hong Kong', kind: 'other', status_override: null, phase: 'upcoming',
            days_to_start: 21, days_left: null, nights: 9, flight_count: 0, route: [], item_count: 0, rev: 1, revisions: 1,
            flights: [], deadlines: [],
        });
        expect(trips.history(conn, 1)).toMatchObject([{ rev: 1, source: 'create', actor: 'tester', current: true }]);
    });

    test('fields are checked', () => {
        expect(code(() => trips.create(conn, {}, 't'))).toBe('bad_request');
        expect(code(() => trips.create(conn, { title: 'x'.repeat(121) }, 't'))).toBe('bad_request');
        expect(code(() => trips.create(conn, { title: 'x', kind: 'holiday' }, 't'))).toBe('bad_kind');
        expect(code(() => trips.create(conn, { title: 'x', status_override: 'completed' }, 't'))).toBe('bad_status_override');
        expect(code(() => trips.create(conn, { title: 'x', colour: 'red' }, 't'))).toBe('bad_field');
        for (const d of ['2026-02-30', '2026-13-01', '12/01/2026', 20261201]) expect(code(() => trips.create(conn, { title: 'x', start_date: d }, 't'))).toBe('bad_date');
        expect(code(() => trips.create(conn, { title: 'x', start_date: '2026-12-10', end_date: '2026-12-01' }, 't'))).toBe('bad_date');
        expect(code(() => trips.create(conn, { title: 'x', destination: 'y'.repeat(121) }, 't'))).toBe('bad_request');
        for (const k of trips.KINDS) expect(trips.create(conn, { title: k, kind: k }, 't').status).toBe('created');
    });

    test('missing trips are 404 no_trip', () => {
        expect(code(() => trips.get(conn, 99))).toBe('no_trip');
        expect(code(() => trips.update(conn, 99, { title: 'x' }, 't'))).toBe('no_trip');
        expect(code(() => trips.get(conn, 'abc'))).toBe('no_trip');
        expect(trips.exists(conn, 99)).toBe(false);
    });

    test('the domain is registered, private, read mode by default, with stats, a briefing hook and its agent tool', () => {
        expect(domains.REGISTRY.trips).toMatchObject({ title: 'Trips', sensitivity: 'private' });
        expect(domains.mcpMode(conn, 'trips')).toBe('read');
        add();
        expect(domains.list(conn).find((d) => d.name === 'trips')).toMatchObject({ records: 1, recordLabel: 'trip', enabled: true });
        expect(require('../services/mcp/registry').TOOLS.some((t) => t.domain === 'trips')).toBe(true);
        expect(typeof domains.REGISTRY.trips.briefing).toBe('function');
    });
});

describe('phases and computed fields', () => {
    const phaseOf = (extra, now = NOW) => trips.get(conn, add(extra), { now });

    test('upcoming, ongoing, past and cancelled from the dates in the hub time zone', () => {
        expect(phaseOf({ start_date: '2026-11-11', end_date: '2026-11-12' })).toMatchObject({ phase: 'upcoming', days_to_start: 1, days_left: null, nights: 1 });
        expect(phaseOf({ start_date: '2026-11-08', end_date: '2026-11-16' })).toMatchObject({ phase: 'ongoing', days_to_start: null, days_left: 6, nights: 8 });
        expect(phaseOf({ start_date: '2026-11-01', end_date: '2026-11-10' })).toMatchObject({ phase: 'ongoing', days_left: 0 });
        expect(phaseOf({ start_date: '2026-11-01', end_date: '2026-11-09' })).toMatchObject({ phase: 'past', days_to_start: null, days_left: null });
        expect(phaseOf({ start_date: '2026-12-01', status_override: 'cancelled' })).toMatchObject({ phase: 'cancelled', days_to_start: null });
        // No dates yet: a plan, upcoming without a countdown. One date: a one-day trip.
        expect(phaseOf({})).toMatchObject({ phase: 'upcoming', days_to_start: null, nights: null });
        expect(phaseOf({ start_date: '2026-11-10' })).toMatchObject({ phase: 'ongoing', days_left: 0, nights: null });
        expect(phaseOf({ end_date: '2026-11-09' })).toMatchObject({ phase: 'past' });
        // 2026-11-11T03:00Z is still the 10th in Chicago.
        expect(phaseOf({ start_date: '2026-11-11' }, new Date('2026-11-11T03:00:00Z'))).toMatchObject({ phase: 'upcoming', days_to_start: 1 });
    });

    test('flight count, route and distance come from the linked flights', () => {
        const id = add({ start_date: '2026-12-01', end_date: '2026-12-10' });
        flight(100, { trip_id: id });
        flight(101, { trip_id: id, origin_iata: 'HKG', dest_iata: 'DFW', sched_dep: '2026-12-10T05:00:00Z' });
        flight(102, { trip_id: id, origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: '2026-12-11T05:00:00Z', status: 'cancelled' });
        const t = trips.get(conn, id, { now: NOW });
        expect(t).toMatchObject({ flight_count: 3, route: ['DFW', 'HKG', 'DFW'] });
        expect(t.distance_km).toBeGreaterThan(20000);
        expect(trips.list(conn, { now: NOW }).trips[0]).toMatchObject({ id, flight_count: 3, route: ['DFW', 'HKG', 'DFW'] });
    });

    test('list filters by phase and year, pages, and orders upcoming soonest first', () => {
        const a = add({ title: 'Later', start_date: '2027-03-01', end_date: '2027-03-05' });
        const b = add({ title: 'Soon', start_date: '2026-12-01', end_date: '2026-12-05' });
        const c = add({ title: 'Past', start_date: '2025-06-01', end_date: '2025-06-05' });
        const d = add({ title: 'Now', start_date: '2026-11-09', end_date: '2026-11-12' });
        const e = add({ title: 'Off', start_date: '2026-12-20', status_override: 'cancelled' });
        const ids = (o) => trips.list(conn, { now: NOW, ...o }).trips.map((t) => t.id);
        expect(ids({ phase: 'upcoming' })).toEqual([b, a]);
        expect(ids({ phase: 'ongoing' })).toEqual([d]);
        expect(ids({ phase: 'past' })).toEqual([c]);
        expect(ids({ phase: 'cancelled' })).toEqual([e]);
        expect(ids({ year: '2026' })).toEqual([e, b, d]);
        expect(ids({})).toEqual([a, e, b, d, c]);
        expect(trips.list(conn, { now: NOW, limit: 2, offset: 1 })).toMatchObject({ total: 5, offset: 1, limit: 2 });
        expect(ids({ limit: 2, offset: 1 })).toEqual([e, b]);
        expect(code(() => trips.list(conn, { phase: 'soon' }))).toBe('bad_phase');
        expect(code(() => trips.list(conn, { year: '26' }))).toBe('bad_year');
    });

    test('a trip detail lists its flights without booking references and its deadlines without reference or money', () => {
        const id = add({ start_date: '2026-12-01', end_date: '2026-12-10' });
        const f = flight(200, { trip_id: id });
        const d = deadline({ trip_id: id });
        deadlines.create(conn, { title: 'Visa fee', kind: 'bill', due_date: '2026-11-25', amount_cents: 16000, currency: 'USD', trip_id: id }, 't');
        const t = trips.get(conn, id, { now: NOW });
        expect(t.flights).toHaveLength(1);
        expect(t.flights[0]).toMatchObject({ id: f, flight_number: '200', has_booking_ref: true });
        expect(t.flights[0]).not.toHaveProperty('booking_ref');
        expect(t.deadlines[0]).toEqual({ id: d, title: 'Passport renewal', kind: 'document', due_date: '2026-11-20', status: 'active', days_left: 10 });
        const text = JSON.stringify(t);
        for (const secret of [REF, 'P-123', '16000']) expect(text).not.toContain(secret);
    });
});

describe('edits, revisions and restore', () => {
    test('partial edits, unchanged detection, a revision per change with source, actor and note', () => {
        const id = add({ destination: 'Hong Kong' });
        expect(trips.update(conn, id, { kind: 'conference', note: 'It is a conference' }, 'editor')).toEqual({ status: 'updated', id, title: 'Hong Kong', rev: 2, fields: ['kind'] });
        expect(trips.update(conn, id, { kind: 'conference' }, 'editor')).toMatchObject({ status: 'unchanged', rev: 2 });
        expect(trips.update(conn, id, { destination: null, start_date: '2026-12-01' }, 'editor').fields).toEqual(['destination', 'start_date']);
        expect(code(() => trips.update(conn, id, { note: 'only a note' }, 'e'))).toBe('bad_request');
        expect(code(() => trips.update(conn, id, { title: null }, 'e'))).toBe('bad_request');
        expect(trips.history(conn, id).map((h) => [h.rev, h.source, h.actor, h.note])).toEqual([
            [3, 'edit', 'editor', null], [2, 'edit', 'editor', 'It is a conference'], [1, 'create', 'tester', null]]);
        expect(trips.get(conn, id, { rev: 1 })).toMatchObject({ kind: 'other', destination: 'Hong Kong', rev: 1, revisions: 3 });
        expect(code(() => trips.get(conn, id, { rev: 9 }))).toBe('no_revision');
    });

    test('restore puts an older version back as a new revision', () => {
        const id = add({ destination: 'Hong Kong' });
        trips.update(conn, id, { title: 'HK', status_override: 'cancelled' }, 't');
        expect(trips.restore(conn, id, 1, 'admin')).toEqual({ status: 'updated', id, title: 'Hong Kong', rev: 3, fields: ['title', 'status_override'] });
        expect(trips.get(conn, id)).toMatchObject({ title: 'Hong Kong', status_override: null, rev: 3 });
        expect(trips.history(conn, id)[0]).toMatchObject({ source: 'restore', note: 'Restored revision 1' });
        expect(trips.restore(conn, id, 3, 'admin').status).toBe('unchanged');
        expect(code(() => trips.restore(conn, id, 7, 'admin'))).toBe('no_revision');
    });

    test('audit detail carries ids, title and field names only', () => {
        const id = add({ notes: 'secret plan' });
        const r = trips.update(conn, id, { notes: 'another secret' }, 't');
        expect(trips.auditDetail(r)).toEqual({ id, title: 'Hong Kong', rev: 2, fields: ['notes'] });
    });
});

describe('flight links', () => {
    test('link, link again (unchanged), move from another trip, unlink; each is a flight revision', () => {
        const a = add({ title: 'A' });
        const b = add({ title: 'B' });
        const f = flight(300);
        expect(trips.linkFlight(conn, a, f, 'tester')).toMatchObject({ status: 'linked', id: a, title: 'A', flight_id: f, flight: 'CX 300 DFW-HKG 2026-12-01', moved_from: null });
        expect(trips.linkFlight(conn, a, f, 'tester').status).toBe('unchanged');
        const moved = trips.linkFlight(conn, b, f, 'tester');
        expect(moved).toMatchObject({ status: 'moved', id: b, moved_from: { id: a, title: 'A' } });
        expect(trips.auditDetail(moved)).toEqual({ id: b, title: 'B', flight_id: f, flight: 'CX 300 DFW-HKG 2026-12-01', moved_from: a });
        expect(flights.get(conn, f).trip_id).toBe(b);
        expect(code(() => trips.unlinkFlight(conn, a, f, 'tester'))).toBe('not_on_trip');
        expect(trips.unlinkFlight(conn, b, f, 'tester')).toMatchObject({ status: 'unlinked', id: b, flight_id: f });
        expect(flights.get(conn, f).trip_id).toBeNull();
        expect(flights.history(conn, f).map((h) => h.note)).toEqual(['Unlinked from trip 2', 'Moved from trip 1 to trip 2', 'Linked to trip 1', null]);
        expect(code(() => trips.linkFlight(conn, a, 999, 't'))).toBe('no_flight');
        expect(code(() => trips.linkFlight(conn, a, undefined, 't'))).toBe('no_flight');
        expect(code(() => trips.linkFlight(conn, 999, f, 't'))).toBe('no_trip');
    });
});

describe('delete', () => {
    test('preview counts; flights block unless unassign; flights and deadlines stay without the link; items go', () => {
        const id = add();
        const f = flight(400, { trip_id: id });
        const d = deadline({ trip_id: id });
        conn.prepare("INSERT INTO trip_items (trip_id, title, created_at, updated_at, updated_by) VALUES (?, 'Hotel', 'x', 'x', 't')").run(id);
        expect(trips.removalPreview(conn, id)).toEqual({ id, label: 'Hong Kong', counts: { flights: 1, deadlines: 1, items: 1 } });
        expect(code(() => trips.remove(conn, id, {}))).toBe('confirm_required');
        expect(code(() => trips.remove(conn, id, { confirm: true }))).toBe('trip_in_use');
        const r = trips.remove(conn, id, { confirm: true, unassign: true });
        expect(trips.removedAuditDetail(r)).toEqual({ id, trip: 'Hong Kong', flights: 1, deadlines: 1, items: 1, unassigned: true });
        expect(trips.exists(conn, id)).toBe(false);
        expect(flights.get(conn, f).trip_id).toBeNull();
        expect(deadlines.get(conn, d).trip_id).toBeNull();
        expect(conn.prepare('SELECT COUNT(*) AS n FROM trip_items').get().n).toBe(0);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM trip_revisions').get().n).toBe(0);
        expect(code(() => trips.remove(conn, id, { confirm: true }))).toBe('no_trip');
    });
});

describe('deadlines.trip_id is checked against the trips', () => {
    test('create and edit need an existing trip; restore leaves out a trip that is gone', () => {
        const id = add();
        expect(code(() => deadline({ trip_id: 999 }))).toBe('bad_trip');
        const d = deadline({ trip_id: id });
        expect(code(() => deadlines.update(conn, d, { trip_id: 998 }, 't'))).toBe('bad_trip');
        const other = add({ title: 'Other' });
        expect(deadlines.update(conn, d, { trip_id: other }, 't').fields).toEqual(['trip_id']);
        trips.remove(conn, id, { confirm: true });
        expect(deadlines.restore(conn, d, 1, 't').fields).toEqual(['trip_id']);
        expect(deadlines.get(conn, d).trip_id).toBeNull();
        // An item whose trip vanished outside the service can still be edited in other ways.
        conn.prepare('UPDATE deadlines SET trip_id = 4242 WHERE id = ?').run(d);
        expect(deadlines.update(conn, d, { title: 'Passport' }, 't').status).toBe('updated');
    });
});

describe('the flights trip functions call this service and keep their answers', () => {
    test('createTrip, updateTrip, listTrips, getTrip and the delete', () => {
        const t = flights.createTrip(conn, { title: 'Spring', start_date: '2026-03-01' }, 'tester');
        expect(t).toEqual({ status: 'created', id: t.id, title: 'Spring' });
        expect(trips.history(conn, t.id)).toHaveLength(1);
        expect(code(() => flights.createTrip(conn, { title: 'x', kind: 'work' }, 't'))).toBe('bad_field');
        expect(code(() => flights.updateTrip(conn, t.id, { destination: 'x' }, 't'))).toBe('bad_field');
        expect(code(() => flights.updateTrip(conn, t.id, {}, 't'))).toBe('bad_request');
        expect(code(() => flights.updateTrip(conn, 99, {}, 't'))).toBe('no_trip');
        expect(flights.updateTrip(conn, t.id, { notes: 'n' }, 't')).toEqual({ status: 'updated', id: t.id, title: 'Spring' });
        flight(500, { trip_id: t.id });
        expect(Object.keys(flights.listTrips(conn)[0])).toEqual(['id', 'title', 'start_date', 'end_date', 'notes', 'flights', 'created_at', 'updated_at', 'updated_by']);
        expect(flights.getTrip(conn, t.id).flights[0].booking_ref).toBe(REF);
        let err;
        try { flights.getTrip(conn, 99); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(flights.FlightError);
        expect(flights.tripRemovalPreview(conn, t.id).counts).toMatchObject({ flights: 1, deadlines: 0 });
        expect(code(() => flights.removeTrip(conn, t.id, { confirm: true }))).toBe('trip_in_use');
    });
});

describe('migration 017', () => {
    test('existing trips keep their ids and links and get revision 1', () => {
        const dir = path.join(__dirname, '..', 'db', 'migrations');
        const c = new Database(':memory:');
        c.pragma('foreign_keys = ON');
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
            if (f.startsWith('017_')) {
                c.prepare("INSERT INTO trips (id, title, start_date, notes, created_at, updated_at, updated_by) VALUES (7, 'Old trip', '2025-05-01', 'n', 'c', '2025-01-01T00:00:00Z', 'someone')").run();
                c.prepare("INSERT INTO deadlines (title, kind, due_date, trip_id, created_at, updated_at, updated_by) VALUES ('Visa', 'document', '2025-04-01', 7, 'x', 'x', 'x')").run();
            }
            c.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
        }
        expect(c.prepare('SELECT id, kind, destination, status_override, current_rev FROM trips').all()).toEqual([
            { id: 7, kind: 'other', destination: null, status_override: null, current_rev: 1 }]);
        const rev = c.prepare('SELECT * FROM trip_revisions').get();
        expect(rev).toMatchObject({ trip_id: 7, rev: 1, source: 'migration', actor: 'someone', at: '2025-01-01T00:00:00Z' });
        expect(JSON.parse(rev.snapshot)).toEqual({ title: 'Old trip', destination: null, kind: 'other', start_date: '2025-05-01', end_date: null, notes: 'n', status_override: null });
        expect(c.prepare('SELECT trip_id FROM deadlines').get().trip_id).toBe(7);
        c.close();
    });
});
