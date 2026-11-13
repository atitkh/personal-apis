process.env.HUB_DB_FILE = ':memory:';

// The trips agent tool. Every trip, flight, item, reference and note in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const flights = require('../services/flights');
const trips = require('../services/trips');
const items = require('../services/tripItems');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes: `${scopes}, overview:read, briefing:read` }).key; };
const ITEM_REF = 'TRIPITEM-REF-5521';
const BOOKING = 'BKREF9Q';
const CANARY_NOTE = 'canary-note-kowloonferry';
const LONG_NOTE = `${'long trip note words '.repeat(30)}end`;
const READS = ['get', 'list', 'suggest', 'upcoming'];
const ALL = ['add', 'add_item', 'edit', 'edit_item', 'get', 'link_flight', 'list', 'remove_item', 'suggest', 'unlink_flight', 'upcoming'];
let hk;
let flightId;

beforeAll(() => {
    make('reader', 'trips:read');
    make('editor', 'trips:read, trips:agent-write');
    make('edit-only', 'trips:agent-write');
    make('rest-writer', 'trips:read, trips:api-write');
    make('other', 'flights:read');
    make('all', 'trips:*');
    const conn = db.get();
    hk = trips.create(conn, { title: 'Hong Kong trip', destination: 'Hong Kong', kind: 'leisure', start_date: '2099-11-12', end_date: '2099-11-20', notes: LONG_NOTE }, 'seed').id;
    items.add(conn, hk, { kind: 'stay', title: 'Harbour hotel', start_date: '2099-11-12', reference: ITEM_REF, notes: CANARY_NOTE }, 'seed');
    flightId = flights.create(conn, { airline_iata: 'CX', flight_number: '881', origin_iata: 'LAX', dest_iata: 'HKG', sched_dep: '2099-11-12T06:00:00Z', booking_ref: BOOKING }, 'seed').id;
});
afterAll(() => db.close());
afterEach(() => {
    domains.setEnabled(db.get(), 'trips', true, 'test');
    domains.setMcpMode(db.get(), 'trips', 'read', 'test');
});

const rpc = (key, method, params = {}, id = 1) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`)
    .send({ jsonrpc: '2.0', id, method, params });
const listTools = async (key) => (await rpc(key, 'tools/list').expect(200)).body.result.tools;
const tool = async (key) => (await listTools(key)).find((t) => t.name === 'trips');
const actionsOf = async (key) => {
    const t = await tool(key);
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'trips', arguments: args }).expect(200)).body.result;
const textOf = (r) => r.content[0].text;
const jsonOf = (r) => JSON.parse(textOf(r).replace(`${DATA_NOTE}\n`, ''));
const errorOf = (r) => {
    if (!r.isError) return 'no error';
    try { return JSON.parse(textOf(r)).error; } catch (err) { return /^MCP error/.test(textOf(r)) ? 'refused' : textOf(r); }
};

describe('visibility per key and mode', () => {
    test('read mode: read actions for a read key; nothing for others', async () => {
        expect(await actionsOf('reader')).toEqual(READS);
        expect(await actionsOf('editor')).toEqual(READS);
        expect(await actionsOf('all')).toEqual(READS);
        expect(await actionsOf('rest-writer')).toEqual(READS);
        expect(await actionsOf('edit-only')).toBeNull();
        expect(await actionsOf('other')).toBeNull();
    });

    test('write mode adds the write actions only with trips:agent-write; never delete, accept, dismiss or restore', async () => {
        domains.setMcpMode(db.get(), 'trips', 'write', 'test');
        expect(await actionsOf('reader')).toEqual(READS);
        expect(await actionsOf('editor')).toEqual(ALL);
        expect(await actionsOf('all')).toEqual(ALL);
        expect(await actionsOf('rest-writer')).toEqual(READS); // trips:api-write is REST only
        expect(await actionsOf('edit-only')).toBeNull();
        for (const a of ALL) expect(a).not.toMatch(/^(delete|accept|dismiss|restore)/);
        const t = await tool('editor');
        expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    });

    test('mode off or domain off hides the tool', async () => {
        domains.setMcpMode(db.get(), 'trips', 'off', 'test');
        expect(await actionsOf('reader')).toBeNull();
        domains.setMcpMode(db.get(), 'trips', 'read', 'test');
        domains.setEnabled(db.get(), 'trips', false, 'test');
        expect(await actionsOf('reader')).toBeNull();
    });

    test('the description says dates are local, references are left out and suggestions are proposals', async () => {
        const t = await tool('reader');
        expect(t.description).toMatch(/LOCAL dates/);
        expect(t.description).toMatch(/references are left out/);
        expect(t.description).toMatch(/only Atit accepts or dismisses/);
    });
});

describe('read actions', () => {
    test('list carries the preamble, clips long notes and has no references', async () => {
        const r = await call('reader', { action: 'list' });
        expect(textOf(r).startsWith(DATA_NOTE)).toBe(true);
        const body = jsonOf(r);
        const t = body.trips.find((x) => x.id === hk);
        expect(t).toMatchObject({ title: 'Hong Kong trip', phase: 'upcoming', item_count: 1, notesTruncated: true });
        expect(t.notes.length).toBeLessThan(LONG_NOTE.length);
        expect(textOf(r)).not.toContain(ITEM_REF);
        expect(jsonOf(await call('reader', { action: 'list', phase: 'past' })).trips.find((x) => x.id === hk)).toBeUndefined();
        expect(errorOf(await call('reader', { action: 'list', phase: 'someday' }))).toBe('bad_phase');
    });

    test('get: items without references unless include_reference=true; flights without booking references', async () => {
        const plain = await call('reader', { action: 'get', id: hk });
        expect(textOf(plain)).not.toContain(ITEM_REF);
        expect(jsonOf(plain).items[0]).toMatchObject({ title: 'Harbour hotel', has_reference: true });
        expect(jsonOf(plain).notes).toBe(LONG_NOTE);
        const withRef = jsonOf(await call('reader', { action: 'get', id: hk, include_reference: true }));
        expect(withRef.items[0].reference).toBe(ITEM_REF);
        expect(errorOf(await call('reader', { action: 'get' }))).toBe('bad_request');
        expect(errorOf(await call('reader', { action: 'get', id: 9999 }))).toBe('no_trip');
    });

    test('upcoming and suggest', async () => {
        const up = jsonOf(await call('reader', { action: 'upcoming', days: 365 }));
        expect(Array.isArray(up.trips)).toBe(true);
        const s = jsonOf(await call('reader', { action: 'suggest' }));
        expect(s).toMatchObject({ needs_home_airport: true, suggestions: [] });
    });

    test('a read key cannot call a write action', async () => {
        domains.setMcpMode(db.get(), 'trips', 'write', 'test');
        expect(errorOf(await call('reader', { action: 'add', title: 'Nope' }))).not.toBe('no error');
        expect(trips.list(db.get()).trips.some((t) => t.title === 'Nope')).toBe(false);
    });
});

describe('write actions (write mode only)', () => {
    test('read mode refuses writes even for an editor', async () => {
        expect(errorOf(await call('editor', { action: 'add', title: 'Read mode trip' }))).not.toBe('no error');
        expect(trips.list(db.get()).trips.some((t) => t.title === 'Read mode trip')).toBe(false);
    });

    test('add, edit, link and unlink a flight, add, edit and remove an item', async () => {
        domains.setMcpMode(db.get(), 'trips', 'write', 'test');
        const added = jsonOf(await call('editor', { action: 'add', title: 'Kathmandu', destination: 'Nepal', kind: 'family', start_date: '2099-06-01', end_date: '2099-06-20' }));
        expect(added).toMatchObject({ status: 'created', title: 'Kathmandu' });
        const id = added.id;
        expect(jsonOf(await call('editor', { action: 'edit', id, destination: null, note: 'not sure yet' }))).toMatchObject({ status: 'updated', fields: ['destination'] });
        expect(errorOf(await call('editor', { action: 'edit', id }))).toBe('bad_request');
        expect(errorOf(await call('editor', { action: 'add', title: 'Bad', start_date: '2099-02-30' }))).toBe('bad_date');

        const linked = jsonOf(await call('editor', { action: 'link_flight', id, flight_id: flightId }));
        expect(linked).toMatchObject({ status: 'linked', flight_id: flightId });
        expect(textOf(await call('editor', { action: 'get', id }))).not.toContain(BOOKING);
        expect(jsonOf(await call('editor', { action: 'unlink_flight', id, flight_id: flightId }))).toMatchObject({ status: 'unlinked' });

        const item = jsonOf(await call('editor', { action: 'add_item', id, item_title: 'Bus to Pokhara', item_kind: 'ground', start_date: '2099-06-05', reference: ITEM_REF }));
        expect(item).toMatchObject({ status: 'created', title: 'Bus to Pokhara', item: { kind: 'ground', has_reference: true } });
        expect(JSON.stringify(item)).not.toContain(ITEM_REF);
        expect(errorOf(await call('editor', { action: 'add_item', id }))).toBe('bad_request');
        expect(jsonOf(await call('editor', { action: 'edit_item', id, item_id: item.item_id, place: 'Kathmandu bus park' }))).toMatchObject({ status: 'updated', fields: ['place'] });
        expect(errorOf(await call('editor', { action: 'edit_item', id, item_id: item.item_id }))).toBe('bad_request');
        expect(jsonOf(await call('editor', { action: 'remove_item', id, item_id: item.item_id }))).toMatchObject({ status: 'removed' });
        expect(errorOf(await call('editor', { action: 'remove_item', id, item_id: item.item_id }))).toBe('no_item');
        // The trip itself stays: there is no delete over MCP.
        expect(trips.get(db.get(), id).title).toBe('Kathmandu');
    });

    test('unknown actions (delete, accept, dismiss) are refused', async () => {
        domains.setMcpMode(db.get(), 'trips', 'write', 'test');
        for (const action of ['delete', 'accept', 'dismiss', 'restore']) {
            expect(errorOf(await call('all', { action, id: hk }))).not.toBe('no error');
        }
        expect(trips.get(db.get(), hk).title).toBe('Hong Kong trip');
    });
});

describe('audit', () => {
    test('mcp_call rows hold no arguments or results', async () => {
        domains.setMcpMode(db.get(), 'trips', 'write', 'test');
        await call('editor', { action: 'get', id: hk, include_reference: true });
        await call('editor', { action: 'add_item', id: hk, item_title: 'Ferry', reference: `${ITEM_REF}-B`, notes: CANARY_NOTE });
        const rows = db.get().prepare("SELECT detail FROM audit_log WHERE action = 'mcp_call'").all();
        expect(rows.length).toBeGreaterThan(0);
        const text = rows.map((r) => r.detail).join('\n');
        for (const secret of [ITEM_REF, CANARY_NOTE, BOOKING, 'Ferry']) expect(text).not.toContain(secret);
    });
});
