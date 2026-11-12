process.env.HUB_DB_FILE = ':memory:';

// Every preference in this file is invented.
const db = require('../db');
const prefs = require('../services/preferences');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };
const item = (extra = {}) => ({ area: 'travel', key: 'airline_seat', value: 'aisle', ...extra });
const add = (extra, who) => prefs.create(conn, item(extra), who || 'tester').id;

describe('create and validation', () => {
    test('files an item with revision 1 and a slug key', () => {
        const r = prefs.create(conn, { area: 'travel', key: ' Airline Seat ', value: '  aisle ', notes: ' near the front ' }, 'tester');
        expect(r).toEqual({ status: 'created', id: 1, area: 'travel', key: 'airline_seat', rev: 1 });
        expect(prefs.get(conn, 1)).toMatchObject({ area: 'travel', key: 'airline_seat', value: 'aisle', notes: 'near the front', removed: false, rev: 1, revisions: 1 });
    });

    test('area, key and value are required and checked', () => {
        expect(code(() => prefs.create(conn, item({ area: 'pets' }), 't'))).toBe('bad_area');
        expect(code(() => prefs.create(conn, item({ area: undefined }), 't'))).toBe('bad_area');
        expect(code(() => prefs.create(conn, item({ key: '' }), 't'))).toBe('bad_key');
        expect(code(() => prefs.create(conn, item({ key: 'seat!' }), 't'))).toBe('bad_key');
        expect(code(() => prefs.create(conn, item({ key: 'k'.repeat(61) }), 't'))).toBe('bad_key');
        expect(prefs.create(conn, item({ key: 'k'.repeat(60) }), 't').status).toBe('created');
        expect(code(() => prefs.create(conn, item({ value: '' }), 't'))).toBe('bad_value');
        expect(code(() => prefs.create(conn, item({ value: 'x'.repeat(501) }), 't'))).toBe('bad_request');
        expect(code(() => prefs.create(conn, item({ notes: 'n'.repeat(301) }), 't'))).toBe('bad_request');
        expect(code(() => prefs.create(conn, item({ colour: 'red' }), 't'))).toBe('bad_field');
        expect(prefs.AREAS).toHaveLength(8);
    });

    test('values that look like secrets or numbers are refused with the vault sentence', () => {
        const refused = [
            '4111 1111 1111 1111', '123-45-6789 is mine', 'call 5015551234', 'pak_abc123', 'use sk-live-abc', 'AKIAIOSFODNN7EXAMPLE',
            'abcdefghij1234567890abcdef', 'my id is 12345678',
        ];
        for (const value of refused) {
            let err;
            try { prefs.create(conn, item({ value }), 't'); } catch (e) { err = e; }
            expect(err && err.code).toBe('secret_like');
            expect(err.message).toContain('Keep passwords, numbers and keys in the vault, not here.');
            expect(err.extra).toEqual({ field: 'value' });
        }
        expect(code(() => prefs.create(conn, item({ notes: 'code sk-12345' }), 't'))).toBe('secret_like');
        expect(prefs.list(conn).total).toBe(0);
    });

    test('plain facts are accepted, including short numbers, emails and risky-looking words', () => {
        const fine = ['No calls before 10 am', 'American Airlines', 'row 12, window or aisle', 'ask for a desk-side seat', 'task-based planning',
            'send to me.smith1990@example.com', 'a 1234567 style id is fine (7 digits)', 'extraordinarilylongwordwithoutdigitsatall'];
        fine.forEach((value, i) => expect(prefs.create(conn, item({ key: `fact_${i}`, value }), 't').status).toBe('created'));
    });

    test('password-ish key names are refused', () => {
        for (const key of ['password', 'wifi_password', 'door passcode', 'api-token', 'secret_word', 'pin', 'bank_pin_code', 'ssn', 'credit_card', 'cards']) {
            let err;
            try { prefs.create(conn, item({ key }), 't'); } catch (e) { err = e; }
            expect(err && err.code).toBe('secret_like');
            expect(err.extra).toEqual({ field: 'key' });
            expect(err.message).toContain('Keep passwords, numbers and keys in the vault, not here.');
        }
        for (const key of ['pinned_tab', 'spinach', 'cardio_day', 'discard_pile']) expect(prefs.create(conn, item({ key }), 't').status).toBe('created');
    });

    test('area and key are unique together', () => {
        const id = add();
        let err;
        try { prefs.create(conn, item({ value: 'window' }), 't'); } catch (e) { err = e; }
        expect(err.code).toBe('exists');
        expect(err.status).toBe(409);
        expect(err.extra).toEqual({ id });
        expect(prefs.create(conn, item({ area: 'work' }), 't').status).toBe('created');
    });
});

describe('reads', () => {
    beforeEach(() => {
        add({ key: 'airline_seat', value: 'aisle' });
        add({ key: 'airline', value: 'American', notes: 'miles account is in the vault' });
        add({ area: 'communication', key: 'call_hours', value: 'No calls before 10 am' });
        add({ area: 'food', key: 'allergy', value: 'peanuts' });
    });

    test('list is grouped by area order then key, and filters by area and q', () => {
        const all = prefs.list(conn);
        expect(all.total).toBe(4);
        expect(all.preferences.map((p) => `${p.area}/${p.key}`)).toEqual(['travel/airline', 'travel/airline_seat', 'communication/call_hours', 'food/allergy']);
        expect(prefs.list(conn, { area: 'travel' }).total).toBe(2);
        expect(prefs.list(conn, { q: 'calls' }).preferences[0].key).toBe('call_hours');
        expect(prefs.list(conn, { q: 'airline seat' }).preferences.map((p) => p.key)).toEqual(['airline_seat']);
        expect(prefs.list(conn, { q: 'miles' }).total).toBe(1);
        expect(prefs.list(conn, { q: '%' }).total).toBe(0);
        expect(code(() => prefs.list(conn, { area: 'pets' }))).toBe('bad_area');
    });

    test('get by id, by area and key, and not found', () => {
        expect(prefs.getByKey(conn, 'food', 'Allergy')).toMatchObject({ value: 'peanuts' });
        expect(code(() => prefs.getByKey(conn, 'food', 'nope'))).toBe('not_found');
        expect(code(() => prefs.get(conn, 99))).toBe('not_found');
        expect(code(() => prefs.get(conn, 'abc'))).toBe('not_found');
    });

    test('stats counts live items only', () => {
        expect(prefs.stats(conn)).toMatchObject({ records: 4, label: 'preferences' });
        prefs.unset(conn, 1, 't');
        expect(prefs.stats(conn).records).toBe(3);
        expect(prefs.stats(db.open(':memory:'))).toEqual({ records: 0, label: 'preferences', lastChange: null });
    });
});

describe('update, set, revisions', () => {
    test('update changes fields as a new revision; same values are unchanged', () => {
        const id = add();
        expect(prefs.update(conn, id, { value: 'window', note: 'changed my mind' }, 'agent')).toEqual({ status: 'updated', id, area: 'travel', key: 'airline_seat', rev: 2, fields: ['value'] });
        expect(prefs.update(conn, id, { value: 'window' }, 'agent').status).toBe('unchanged');
        expect(code(() => prefs.update(conn, id, {}, 'agent'))).toBe('bad_request');
        expect(prefs.update(conn, id, { notes: 'front half' }, 'agent').rev).toBe(3);
        expect(prefs.update(conn, id, { notes: null }, 'agent').fields).toEqual(['notes']);
        const h = prefs.history(conn, id);
        expect(h.map((r) => r.rev)).toEqual([4, 3, 2, 1]);
        expect(h[0]).toMatchObject({ source: 'edit', actor: 'agent', current: true });
        expect(h[2].note).toBe('changed my mind');
        expect(JSON.stringify(h)).not.toContain('window');
    });

    test('update can move an item to another area but not onto an existing one', () => {
        const a = add();
        add({ area: 'work' });
        expect(code(() => prefs.update(conn, a, { area: 'work' }, 't'))).toBe('exists');
        expect(prefs.update(conn, a, { area: 'other' }, 't').fields).toEqual(['area']);
    });

    test('update refuses secret-looking values', () => {
        const id = add();
        expect(code(() => prefs.update(conn, id, { value: 'sk-abc123' }, 't'))).toBe('secret_like');
        expect(prefs.get(conn, id).value).toBe('aisle');
    });

    test('old revisions can be read', () => {
        const id = add();
        prefs.update(conn, id, { value: 'window' }, 't');
        expect(prefs.get(conn, id, { rev: 1 })).toMatchObject({ value: 'aisle', rev: 1, revisions: 2 });
        expect(prefs.get(conn, id, { rev: 2 }).value).toBe('window');
        expect(code(() => prefs.get(conn, id, { rev: 9 }))).toBe('no_revision');
    });

    test('set upserts by area and key', () => {
        expect(prefs.set(conn, item(), 'agent')).toMatchObject({ status: 'created', id: 1, rev: 1 });
        expect(prefs.set(conn, item({ key: 'Airline Seat', value: 'window' }), 'agent')).toMatchObject({ status: 'updated', id: 1, rev: 2, fields: ['value'] });
        expect(prefs.set(conn, item({ value: 'window' }), 'agent').status).toBe('unchanged');
        prefs.set(conn, item({ notes: 'front' }), 'agent');
        prefs.set(conn, item({ value: 'middle' }), 'agent');
        expect(prefs.get(conn, 1)).toMatchObject({ value: 'middle', notes: 'front' }); // notes kept when not sent
        expect(prefs.list(conn).total).toBe(1);
        expect(code(() => prefs.set(conn, { area: 'travel', key: 'password', value: 'x' }, 'a'))).toBe('secret_like');
        expect(code(() => prefs.set(conn, { area: 'pets', key: 'x', value: 'y' }, 'a'))).toBe('bad_area');
    });
});

describe('unset and restore', () => {
    test('unset hides the item, keeps its history, and is idempotent', () => {
        const id = add();
        expect(prefs.unset(conn, id, 'tester')).toEqual({ status: 'unset', id, area: 'travel', key: 'airline_seat', rev: 2 });
        expect(prefs.unset(conn, id, 'tester').status).toBe('unchanged');
        expect(prefs.list(conn).total).toBe(0);
        const removed = prefs.list(conn, { removed: true });
        expect(removed.preferences).toHaveLength(1);
        expect(removed.preferences[0]).toMatchObject({ id, removed: true });
        expect(prefs.history(conn, id)[0]).toMatchObject({ source: 'unset', note: 'Removed' });
        expect(prefs.getByKey(conn, 'travel', 'airline_seat').removed).toBe(true);
    });

    test('unsetByKey removes by area and key', () => {
        add();
        expect(prefs.unsetByKey(conn, 'travel', 'airline seat', 'agent').status).toBe('unset');
        expect(code(() => prefs.unsetByKey(conn, 'travel', 'nope', 'agent'))).toBe('not_found');
    });

    test('restore with no revision brings a removed item back as it was', () => {
        const id = add();
        prefs.unset(conn, id, 't');
        const r = prefs.restore(conn, id, undefined, 'tester');
        expect(r).toMatchObject({ status: 'updated', id, rev: 3, fields: ['removed'] });
        expect(prefs.list(conn).total).toBe(1);
        expect(prefs.history(conn, id)[0]).toMatchObject({ source: 'restore' });
        expect(prefs.restore(conn, id, undefined, 'tester').status).toBe('unchanged');
    });

    test('restore of an older revision puts the fields back', () => {
        const id = add();
        prefs.update(conn, id, { value: 'window', notes: 'x' }, 't');
        const r = prefs.restore(conn, id, 1, 'tester');
        expect(r.fields).toEqual(['value', 'notes']);
        expect(prefs.get(conn, id)).toMatchObject({ value: 'aisle', notes: null, rev: 3 });
        expect(code(() => prefs.restore(conn, id, 42, 't'))).toBe('no_revision');
    });

    test('creating or setting a removed key revives the same row', () => {
        const id = add();
        prefs.unset(conn, id, 't');
        expect(prefs.set(conn, item({ value: 'window' }), 'agent')).toMatchObject({ status: 'created', id });
        expect(prefs.get(conn, id)).toMatchObject({ value: 'window', removed: false, rev: 3 });
        prefs.unset(conn, id, 't');
        expect(prefs.create(conn, item({ value: 'middle' }), 'agent')).toMatchObject({ status: 'created', id });
        expect(prefs.list(conn).total).toBe(1);
    });

    test('audit detail has id, area and key only', () => {
        const id = add();
        const r = prefs.update(conn, id, { value: 'window' }, 't');
        expect(prefs.auditDetail(r)).toEqual({ id, area: 'travel', key: 'airline_seat' });
    });
});
