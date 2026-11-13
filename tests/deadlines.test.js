process.env.HUB_DB_FILE = ':memory:';

// Every deadline, reference and amount in this file is invented.
const db = require('../db');
const deadlines = require('../services/deadlines');
const domains = require('../services/domains');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };
const NOW = new Date('2026-11-10T18:00:00Z'); // 2026-11-10 in America/Chicago
const item = (extra = {}) => ({ title: 'Passport renewal', kind: 'document', due_date: '2027-03-01', ...extra });
const add = (extra, at) => deadlines.create(conn, item(extra), at || 'tester').id;

describe('create and validation', () => {
    test('files an item with defaults and revision 1', () => {
        const r = deadlines.create(conn, { title: '  Car insurance ', due_date: '2026-12-20' }, 'tester');
        expect(r).toEqual({ status: 'created', id: 1, title: 'Car insurance', rev: 1 });
        const d = deadlines.get(conn, 1, { now: NOW });
        expect(d).toMatchObject({
            kind: 'other', repeat_kind: 'none', repeat_n: null, lead_days: 14, urgent_days: 3, status: 'active',
            next_due: '2026-12-20', days_left: 40, overdue: false, window: 'later', reference: null, amount_cents: null, revisions: 1,
        });
    });

    test('title and due_date are required and checked', () => {
        expect(code(() => deadlines.create(conn, { due_date: '2026-12-20' }, 't'))).toBe('bad_title');
        expect(code(() => deadlines.create(conn, { title: 'x'.repeat(121), due_date: '2026-12-20' }, 't'))).toBe('bad_request');
        expect(code(() => deadlines.create(conn, { title: 'x' }, 't'))).toBe('bad_date');
        for (const d of ['2026-02-30', '2026-13-01', '12/20/2026', '2026-12-20T10:00', 20261220]) {
            expect(code(() => deadlines.create(conn, item({ due_date: d }), 't'))).toBe('bad_date');
        }
        expect(deadlines.create(conn, item({ due_date: '2028-02-29' }), 't').status).toBe('created');
        expect(code(() => deadlines.create(conn, item({ kind: 'pet' }), 't'))).toBe('bad_kind');
        expect(code(() => deadlines.create(conn, item({ colour: 'red' }), 't'))).toBe('bad_field');
    });

    test('due_time is optional HH:MM', () => {
        expect(deadlines.get(conn, add({ due_time: '14:30' })).due_time).toBe('14:30');
        for (const t of ['24:00', '9:30', '14:60', 'noon']) expect(code(() => deadlines.create(conn, item({ due_time: t }), 't'))).toBe('bad_time');
    });

    test('windows: any 0..730, urgent cannot exceed lead', () => {
        expect(deadlines.get(conn, add({ lead_days: 90, urgent_days: 14 }))).toMatchObject({ lead_days: 90, urgent_days: 14 });
        expect(deadlines.get(conn, add({ lead_days: 0, urgent_days: 0, title: 'zero' }))).toMatchObject({ lead_days: 0, urgent_days: 0 });
        expect(code(() => deadlines.create(conn, item({ lead_days: 5, urgent_days: 6 }), 't'))).toBe('bad_window');
        expect(code(() => deadlines.create(conn, item({ lead_days: 2 }), 't'))).toBe('bad_window'); // default urgent 3
        expect(code(() => deadlines.create(conn, item({ lead_days: 731 }), 't'))).toBe('bad_lead_days');
        expect(code(() => deadlines.create(conn, item({ lead_days: -1 }), 't'))).toBe('bad_lead_days');
        expect(code(() => deadlines.create(conn, item({ urgent_days: 1.5 }), 't'))).toBe('bad_urgent_days');
    });

    test('repeat rules: n only for every_n_months and required there', () => {
        expect(deadlines.get(conn, add({ repeat_kind: 'every_n_months', repeat_n: 3 }))).toMatchObject({ repeat_kind: 'every_n_months', repeat_n: 3 });
        expect(code(() => deadlines.create(conn, item({ repeat_kind: 'every_n_months' }), 't'))).toBe('bad_repeat_n');
        expect(code(() => deadlines.create(conn, item({ repeat_kind: 'every_n_months', repeat_n: 0 }), 't'))).toBe('bad_repeat_n');
        expect(code(() => deadlines.create(conn, item({ repeat_kind: 'yearly', repeat_n: 2 }), 't'))).toBe('bad_repeat_n');
        expect(code(() => deadlines.create(conn, item({ repeat_kind: 'weekly' }), 't'))).toBe('bad_repeat_kind');
        expect(deadlines.get(conn, add({ repeat_kind: 'yearly', repeat_n: null })).repeat_n).toBeNull();
    });

    test('money fields only for subscription, membership and bill', () => {
        const money = { amount_cents: 1599, currency: 'usd', cycle: 'monthly', auto_renew: true, cancel_by: '2026-12-01' };
        for (const kind of ['subscription', 'membership', 'bill']) {
            const d = deadlines.get(conn, add({ ...money, kind, title: kind }));
            expect(d).toMatchObject({ amount_cents: 1599, currency: 'USD', cycle: 'monthly', auto_renew: true, cancel_by: '2026-12-01' });
        }
        for (const kind of ['document', 'insurance', 'license', 'task', 'other']) {
            expect(code(() => deadlines.create(conn, item({ ...money, kind }), 't'))).toBe('money_not_allowed');
        }
        expect(code(() => deadlines.create(conn, item({ kind: 'task', cycle: 'weekly' }), 't'))).toBe('money_not_allowed');
        const e = (() => { try { deadlines.create(conn, item({ kind: 'task', amount_cents: 5, currency: 'USD' }), 't'); } catch (err) { return err; } return null; })();
        expect(e.status).toBe(400);
        expect(e.message).toMatch(/only for subscription, membership and bill/);
        expect(code(() => deadlines.create(conn, item({ kind: 'bill', amount_cents: 500 }), 't'))).toBe('bad_currency');
        expect(code(() => deadlines.create(conn, item({ kind: 'bill', amount_cents: -5, currency: 'USD' }), 't'))).toBe('bad_amount_cents');
        expect(code(() => deadlines.create(conn, item({ kind: 'bill', cycle: 'daily' }), 't'))).toBe('bad_cycle');
        expect(code(() => deadlines.create(conn, item({ kind: 'bill', currency: 'DOLLARS' }), 't'))).toBe('bad_request');
        expect(code(() => deadlines.create(conn, item({ kind: 'bill', currency: 'U1D' }), 't'))).toBe('bad_currency');
    });

    test('changing kind away from a money kind needs the money fields cleared', () => {
        const id = add({ kind: 'subscription', amount_cents: 999, currency: 'USD', cycle: 'monthly' });
        expect(code(() => deadlines.update(conn, id, { kind: 'task' }, 't'))).toBe('money_not_allowed');
        const r = deadlines.update(conn, id, { kind: 'task', amount_cents: null, currency: null, cycle: null }, 't');
        expect(r.fields).toEqual(['kind', 'amount_cents', 'currency', 'cycle']);
    });

    test('trip_id must name a trip that exists (since the trips domain)', () => {
        expect(code(() => deadlines.create(conn, item({ trip_id: 4242 }), 't'))).toBe('bad_trip');
        const trip = require('../services/trips').create(conn, { title: 'Hong Kong' }, 't').id;
        expect(deadlines.get(conn, add({ trip_id: trip })).trip_id).toBe(trip);
        expect(code(() => deadlines.create(conn, item({ trip_id: 'abc' }), 't'))).toBe('bad_trip');
    });

    test('reference is limited to 120 characters', () => {
        expect(code(() => deadlines.create(conn, item({ reference: 'x'.repeat(121) }), 't'))).toBe('bad_request');
        expect(deadlines.get(conn, add({ reference: ' P1234-5678 ' })).reference).toBe('P1234-5678');
    });
});

describe('shape and privacy', () => {
    test('reference is only in the full shape; lists say has_reference', () => {
        const id = add({ reference: 'ZX-9981-REF', notes: 'keep in the safe' });
        const row = conn.prepare('SELECT * FROM deadlines WHERE id = ?').get(id);
        expect(deadlines.shape(row, { now: NOW }).reference).toBe('ZX-9981-REF');
        const lean = deadlines.shape(row, { reference: false, now: NOW });
        expect(lean).not.toHaveProperty('reference');
        expect(lean.has_reference).toBe(true);
        expect(JSON.stringify(lean)).not.toContain('ZX-9981-REF');
        const l = deadlines.list(conn, { now: NOW }).deadlines[0];
        expect(l).not.toHaveProperty('reference');
        expect(l.has_reference).toBe(true);
        expect(deadlines.list(conn, { reference: true, now: NOW }).deadlines[0].reference).toBe('ZX-9981-REF');
        expect(deadlines.upcoming(conn, { days: 365, now: NOW })[0]).not.toHaveProperty('reference');
        expect(deadlines.get(conn, id, { reference: false, now: NOW })).not.toHaveProperty('reference');
        expect(JSON.stringify(deadlines.history(conn, id))).not.toContain('ZX-9981-REF');
    });

    test('an item without a reference has no has_reference flag', () => {
        add({});
        expect(deadlines.list(conn, { now: NOW }).deadlines[0]).not.toHaveProperty('has_reference');
    });

    test('auditDetail names fields only', () => {
        const id = add({ reference: 'ZX-9981-REF' });
        const r = deadlines.update(conn, id, { reference: 'NEW-REF-1', notes: 'secret note', amount_cents: undefined }, 't');
        const d = deadlines.auditDetail(r);
        expect(d).toEqual({ id, title: 'Passport renewal', rev: 2, fields: ['reference', 'notes'] });
        expect(JSON.stringify(d)).not.toMatch(/NEW-REF-1|secret/);
    });
});

describe('computed dates and windows', () => {
    test('days_left, overdue and window follow the Chicago date', () => {
        // 2026-11-10 12:00 in Chicago; UTC is already the 10th, and 03:00 UTC on the 11th is still the 10th in Chicago.
        const late = new Date('2026-11-11T03:00:00Z');
        const id = add({ due_date: '2026-11-11', lead_days: 14, urgent_days: 3 });
        expect(deadlines.get(conn, id, { now: late })).toMatchObject({ days_left: 1, window: 'urgent', overdue: false });
        expect(deadlines.get(conn, id, { now: new Date('2026-11-11T07:00:00Z') })).toMatchObject({ days_left: 0, window: 'urgent' });
        expect(deadlines.get(conn, id, { now: new Date('2026-11-12T07:00:00Z') })).toMatchObject({ days_left: -1, overdue: true, window: 'urgent' });
        expect(deadlines.daysLeft('2026-11-20', NOW)).toBe(10);
    });

    test('window edges: urgent <= urgent_days, attention <= lead_days, else later', () => {
        const id = add({ due_date: '2026-11-20', lead_days: 14, urgent_days: 3 });
        const at = (d) => deadlines.get(conn, id, { now: new Date(`${d}T18:00:00Z`) }).window;
        expect(at('2026-11-05')).toBe('later');      // 15 days left
        expect(at('2026-11-06')).toBe('attention');  // 14 left = lead_days
        expect(at('2026-11-07')).toBe('attention');
        expect(at('2026-11-16')).toBe('attention');  // 4 left
        expect(at('2026-11-17')).toBe('urgent');     // 3 left
    });
});

describe('done, roll-forward and end', () => {
    test('done on a one-off sets status done and stamps done_at', () => {
        const id = add({ repeat_kind: 'none' });
        const r = deadlines.done(conn, id, 'tester', { now: NOW });
        expect(r).toMatchObject({ status: 'done', id, rev: 2 });
        const d = deadlines.get(conn, id, { now: NOW });
        expect(d).toMatchObject({ status: 'done', done_at: NOW.toISOString(), next_due: null, days_left: null, overdue: false, window: null });
        expect(code(() => deadlines.done(conn, id, 't', { now: NOW }))).toBe('not_active');
        expect(deadlines.history(conn, id)[0]).toMatchObject({ rev: 2, source: 'done', note: 'Done' });
    });

    test('done on yearly rolls one year, stays active, keeps the note', () => {
        const id = add({ repeat_kind: 'yearly', due_date: '2026-11-15' });
        const r = deadlines.done(conn, id, 'tester', { now: NOW });
        expect(r).toMatchObject({ status: 'rolled', next_due: '2027-11-15', fields: ['due_date'] });
        expect(deadlines.get(conn, id, { now: NOW })).toMatchObject({ status: 'active', due_date: '2027-11-15', done_at: NOW.toISOString() });
        expect(deadlines.history(conn, id)[0]).toMatchObject({ source: 'done', note: 'Done, next due 2027-11-15' });
    });

    test('monthly month-end clamp: Jan 31 -> Feb 28, and a leap year', () => {
        const id = add({ repeat_kind: 'monthly', due_date: '2027-01-31' });
        expect(deadlines.done(conn, id, 't', { now: new Date('2027-01-31T18:00:00Z') }).next_due).toBe('2027-02-28');
        const leap = add({ repeat_kind: 'monthly', due_date: '2028-01-31', title: 'leap' });
        expect(deadlines.done(conn, leap, 't', { now: new Date('2028-01-31T18:00:00Z') }).next_due).toBe('2028-02-29');
        const feb29 = add({ repeat_kind: 'yearly', due_date: '2028-02-29', title: 'feb29' });
        expect(deadlines.done(conn, feb29, 't', { now: new Date('2028-02-29T18:00:00Z') }).next_due).toBe('2029-02-28');
    });

    test('every_n_months adds n months', () => {
        const id = add({ repeat_kind: 'every_n_months', repeat_n: 3, due_date: '2026-11-30' });
        expect(deadlines.done(conn, id, 't', { now: NOW }).next_due).toBe('2027-02-28');
        const six = add({ repeat_kind: 'every_n_months', repeat_n: 6, due_date: '2026-12-15', title: 'six' });
        expect(deadlines.done(conn, six, 't', { now: NOW }).next_due).toBe('2027-06-15');
    });

    test('a roll that is still in the past keeps adding until it is today or later', () => {
        const id = add({ repeat_kind: 'monthly', due_date: '2026-01-31' });
        // Counted from the 31st each time, so the day does not drift down: Feb 28, Mar 31, Apr 30.
        expect(deadlines.done(conn, id, 't', { now: new Date('2026-04-10T18:00:00Z') }).next_due).toBe('2026-04-30');
        const yearly = add({ repeat_kind: 'yearly', due_date: '2023-05-01', title: 'old' });
        expect(deadlines.done(conn, yearly, 't', { now: NOW }).next_due).toBe('2027-05-01');
        // Done on the day itself: the next one is the following period, not today.
        const same = add({ repeat_kind: 'monthly', due_date: '2026-11-10', title: 'same' });
        expect(deadlines.done(conn, same, 't', { now: NOW }).next_due).toBe('2026-12-10');
        // Done early: the next occurrence after the due date.
        const early = add({ repeat_kind: 'monthly', due_date: '2026-12-20', title: 'early' });
        expect(deadlines.done(conn, early, 't', { now: NOW }).next_due).toBe('2027-01-20');
    });

    test('cancel_by keeps its gap to the due date when an item rolls', () => {
        const id = add({ kind: 'subscription', repeat_kind: 'yearly', due_date: '2026-11-20', cancel_by: '2026-11-13' });
        deadlines.done(conn, id, 't', { now: NOW });
        expect(deadlines.get(conn, id, { now: NOW })).toMatchObject({ due_date: '2027-11-20', cancel_by: '2027-11-13' });
    });

    test('end stops reminders; ending again changes nothing; an ended item cannot be marked done', () => {
        const id = add({});
        expect(deadlines.end(conn, id, 'tester')).toMatchObject({ status: 'ended', rev: 2 });
        expect(deadlines.end(conn, id, 'tester')).toMatchObject({ status: 'unchanged', rev: 2 });
        expect(deadlines.get(conn, id, { now: NOW })).toMatchObject({ status: 'ended', next_due: null, window: null, overdue: false });
        expect(code(() => deadlines.done(conn, id, 't', { now: NOW }))).toBe('not_active');
        expect(deadlines.upcoming(conn, { days: 3650, now: NOW })).toHaveLength(0);
    });

    test('an ended item can be reopened by an edit', () => {
        const id = add({});
        deadlines.end(conn, id, 't');
        expect(deadlines.update(conn, id, { status: 'active' }, 't')).toMatchObject({ status: 'updated', fields: ['status'] });
        expect(deadlines.get(conn, id, { now: NOW }).status).toBe('active');
    });
});

describe('overdue and upcoming', () => {
    test('overdue is active and before today', () => {
        const past = add({ due_date: '2026-11-09', title: 'past' });
        add({ due_date: '2026-11-10', title: 'today' });
        add({ due_date: '2026-11-09', title: 'old but ended' });
        deadlines.end(conn, 3, 't');
        const o = deadlines.list(conn, { overdue: true, now: NOW }).deadlines;
        expect(o.map((d) => d.id)).toEqual([past]);
        expect(o[0]).toMatchObject({ overdue: true, days_left: -1, window: 'urgent' });
    });

    test('upcoming: overdue and within the days, soonest first, with windows', () => {
        add({ title: 'overdue', due_date: '2026-11-01' });
        add({ title: 'soon', due_date: '2026-11-12' });
        add({ title: 'mid', due_date: '2026-11-30', lead_days: 30, urgent_days: 5 });
        add({ title: 'far', due_date: '2027-06-01' });
        const u = deadlines.upcoming(conn, { days: 30, now: NOW });
        expect(u.map((d) => [d.title, d.days_left, d.window])).toEqual([
            ['overdue', -9, 'urgent'], ['soon', 2, 'urgent'], ['mid', 20, 'attention'],
        ]);
        expect(deadlines.upcoming(conn, { days: 0, now: NOW }).map((d) => d.title)).toEqual(['overdue']);
        expect(deadlines.upcoming(conn, { now: NOW }).map((d) => d.title)).toEqual(['overdue', 'soon', 'mid']); // default 60 days
    });
});

describe('list filters', () => {
    beforeEach(() => {
        add({ title: 'Passport', kind: 'document', due_date: '2027-03-01' });
        add({ title: 'Netflix', kind: 'subscription', due_date: '2026-12-01', amount_cents: 1599, currency: 'USD', cycle: 'monthly' });
        add({ title: 'Rent 100%', kind: 'bill', due_date: '2026-11-15' });
        add({ title: 'Old licence', kind: 'license', due_date: '2026-10-01' });
        deadlines.end(conn, 4, 't');
        deadlines.done(conn, 3, 't', { now: NOW });
    });

    test('active by default, sorted by due date; status and kind filters', () => {
        const titles = (o) => deadlines.list(conn, { ...o, now: NOW }).deadlines.map((d) => d.title);
        expect(titles({})).toEqual(['Netflix', 'Passport']);
        expect(titles({ status: 'all' })).toEqual(['Old licence', 'Rent 100%', 'Netflix', 'Passport']);
        expect(titles({ status: 'done' })).toEqual(['Rent 100%']);
        expect(titles({ status: 'ended' })).toEqual(['Old licence']);
        expect(titles({ kind: 'document' })).toEqual(['Passport']);
        expect(code(() => deadlines.list(conn, { kind: 'pet' }))).toBe('bad_kind');
        expect(code(() => deadlines.list(conn, { status: 'weird' }))).toBe('bad_status');
    });

    test('due_before, due_after (inclusive), q and paging', () => {
        const titles = (o) => deadlines.list(conn, { status: 'all', ...o, now: NOW }).deadlines.map((d) => d.title);
        expect(titles({ due_before: '2026-11-15' })).toEqual(['Old licence', 'Rent 100%']);
        expect(titles({ due_after: '2026-12-01' })).toEqual(['Netflix', 'Passport']);
        expect(titles({ due_after: '2026-11-15', due_before: '2026-12-01' })).toEqual(['Rent 100%', 'Netflix']);
        expect(titles({ q: 'pass' })).toEqual(['Passport']);
        expect(titles({ q: '100%' })).toEqual(['Rent 100%']);
        expect(titles({ q: '%' })).toEqual(['Rent 100%']);
        expect(titles({ limit: 2, offset: 1 })).toEqual(['Rent 100%', 'Netflix']);
        const page = deadlines.list(conn, { status: 'all', limit: 2, now: NOW });
        expect(page).toMatchObject({ total: 4, limit: 2, offset: 0 });
        expect(code(() => deadlines.list(conn, { due_before: 'soon' }))).toBe('bad_date');
    });
});

describe('revisions and restore', () => {
    test('rev 1 is the first filing; edits add revisions; unchanged edits add none', () => {
        const id = add({ reference: 'ONE-1' });
        expect(deadlines.update(conn, id, { title: 'Passport (new)', note: 'renamed' }, 'agent')).toMatchObject({ status: 'updated', rev: 2, fields: ['title'] });
        expect(deadlines.update(conn, id, { title: 'Passport (new)' }, 'agent')).toMatchObject({ status: 'unchanged', rev: 2 });
        expect(code(() => deadlines.update(conn, id, {}, 'agent'))).toBe('bad_request');
        expect(code(() => deadlines.update(conn, 999, { title: 'x' }, 'agent'))).toBe('not_found');
        const h = deadlines.history(conn, id);
        expect(h.map((r) => [r.rev, r.source, r.note, r.current])).toEqual([[2, 'edit', 'renamed', true], [1, 'create', null, false]]);
        expect(deadlines.get(conn, id, { rev: 1, now: NOW })).toMatchObject({ title: 'Passport renewal', reference: 'ONE-1', rev: 1, revisions: 2 });
        expect(deadlines.get(conn, id, { rev: 1, reference: false, now: NOW })).not.toHaveProperty('reference');
        expect(code(() => deadlines.get(conn, id, { rev: 9 }))).toBe('no_revision');
    });

    test('restore brings an older version back as a new revision, including a rolled date', () => {
        const id = add({ repeat_kind: 'yearly', due_date: '2026-11-15', reference: 'R-1' });
        deadlines.done(conn, id, 't', { now: NOW });
        deadlines.update(conn, id, { reference: 'R-2' }, 't');
        const r = deadlines.restore(conn, id, 1, 'admin');
        expect(r).toMatchObject({ status: 'updated', rev: 4, fields: ['due_date', 'reference'] });
        expect(deadlines.get(conn, id, { now: NOW })).toMatchObject({ due_date: '2026-11-15', reference: 'R-1', rev: 4 });
        expect(deadlines.history(conn, id)[0]).toMatchObject({ source: 'restore', note: 'Restored revision 1' });
        expect(deadlines.restore(conn, id, 1, 'admin').status).toBe('unchanged');
        expect(code(() => deadlines.restore(conn, id, 77, 'admin'))).toBe('no_revision');
        expect(deadlines.get(conn, id, { rev: 1, now: NOW }).due_date).toBe('2026-11-15'); // rev 1 untouched
    });

    test('restoring a done one-off to active clears done_at', () => {
        const id = add({});
        deadlines.done(conn, id, 't', { now: NOW });
        deadlines.restore(conn, id, 1, 't');
        expect(deadlines.get(conn, id, { now: NOW })).toMatchObject({ status: 'active', done_at: null });
    });
});

describe('stats and registry', () => {
    test('stats counts every item', () => {
        expect(deadlines.stats(conn)).toEqual({ records: 0, label: 'deadlines', lastChange: null });
        const id = add({});
        add({ title: 'two' });
        deadlines.end(conn, id, 't');
        const s = deadlines.stats(conn);
        expect(s).toMatchObject({ records: 2, label: 'deadlines' });
        expect(typeof s.lastChange).toBe('string');
    });

    test('the domain is registered, private, on by default', () => {
        expect(domains.REGISTRY.deadlines).toMatchObject({ title: 'Deadlines', sensitivity: 'private', storage: 'db', defaultEnabled: true });
        expect(domains.REGISTRY.deadlines.confirmOff).toBeUndefined();
        domains.sync(conn);
        expect(domains.isEnabled(conn, 'deadlines')).toBe(true);
        expect(domains.mcpMode(conn, 'deadlines')).toBe('read');
        expect(domains.list(conn).find((d) => d.name === 'deadlines')).toMatchObject({ recordLabel: 'deadlines', records: 0 });
    });

    test('the table has no foreign key on trip_id and the CHECKs hold', () => {
        expect(conn.prepare('PRAGMA foreign_key_list(deadlines)').all()).toHaveLength(0);
        const raw = (sql) => { try { conn.prepare(sql).run(); } catch (err) { return err.code; } return 'ok'; };
        const base = "INSERT INTO deadlines (title, kind, due_date, created_at, updated_at, updated_by";
        expect(raw(`${base}) VALUES ('a', 'pet', '2026-01-01', 'x', 'x', 'x')`)).toBe('SQLITE_CONSTRAINT_CHECK');
        expect(raw(`${base}, lead_days, urgent_days) VALUES ('a', 'bill', '2026-01-01', 'x', 'x', 'x', 2, 5)`)).toBe('SQLITE_CONSTRAINT_CHECK');
        expect(raw(`${base}, repeat_kind) VALUES ('a', 'bill', '2026-01-01', 'x', 'x', 'x', 'every_n_months')`)).toBe('SQLITE_CONSTRAINT_CHECK');
        expect(raw(`${base}, repeat_kind, repeat_n) VALUES ('a', 'bill', '2026-01-01', 'x', 'x', 'x', 'yearly', 2)`)).toBe('SQLITE_CONSTRAINT_CHECK');
        expect(raw(`${base}, trip_id) VALUES ('a', 'bill', '2026-01-01', 'x', 'x', 'x', 99999)`)).toBe('ok');
    });
});
