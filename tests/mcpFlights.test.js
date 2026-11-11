process.env.HUB_DB_FILE = ':memory:';

// The flights agent tool. Every flight, booking reference and note in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const flights = require('../services/flights');
const audit = require('../services/audit');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes }).key; };
const REF = 'KQ4PZ9';
const CANARY_NOTE = 'canary-note-heronsgate';
let past;
let soon;

beforeAll(() => {
    make('reader', 'flights:read');
    make('job', 'flights:read, flights:suggest');
    make('suggest-only', 'flights:suggest');
    make('editor', 'flights:read, flights:edit');
    make('rest-writer', 'flights:read, flights:write');
    make('all', 'flights:*');
    const conn = db.get();
    past = flights.create(conn, {
        airline_iata: 'AA', flight_number: '3301', origin_iata: 'LIT', dest_iata: 'DFW',
        sched_dep: '2026-02-10T12:05:00Z', sched_arr: '2026-02-10T13:20:00Z', booking_ref: REF, notes: CANARY_NOTE,
    }, 'seed').id;
    soon = flights.create(conn, {
        airline_iata: 'AA', flight_number: '3302', origin_iata: 'DFW', dest_iata: 'LIT',
        sched_dep: '2030-01-05T09:00', sched_arr: '2030-01-05T10:10', booking_ref: REF,
    }, 'seed').id;
    flights.createTrip(conn, { title: 'Winter visit' }, 'seed');
});
afterAll(() => db.close());
afterEach(() => {
    domains.setEnabled(db.get(), 'flights', true, 'test');
    domains.setMcpMode(db.get(), 'flights', 'read', 'test');
});

const rpc = (key, method, params = {}, id = 1) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`)
    .send({ jsonrpc: '2.0', id, method, params });
const listTools = async (key) => (await rpc(key, 'tools/list').expect(200)).body.result.tools;
const tool = async (key) => (await listTools(key)).find((t) => t.name === 'flights');
const actionsOf = async (key) => {
    const t = await tool(key);
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'flights', arguments: args }).expect(200)).body.result;
const textOf = (r) => r.content[0].text;
const jsonOf = (r) => JSON.parse(textOf(r).replace(`${DATA_NOTE}\n`, ''));
const errorOf = (r) => {
    if (!r.isError) return 'no error';
    try { return JSON.parse(textOf(r)).error; } catch (err) { return /^MCP error/.test(textOf(r)) ? 'refused' : textOf(r); }
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const writeMode = () => domains.setMcpMode(db.get(), 'flights', 'write', 'test');
const READ = ['candidates', 'get', 'list', 'sources', 'stats', 'trips', 'upcoming'];

describe('mcp flights: what a key sees', () => {
    test('read mode: the read actions for every flights:read key; nothing for suggest-only', async () => {
        for (const key of ['reader', 'job', 'editor', 'rest-writer', 'all']) expect(await actionsOf(key)).toEqual(READ);
        expect(await actionsOf('suggest-only')).toBeNull();
        const t = await tool('all');
        expect(t.description).not.toMatch(/suggest:|add:|edit:/);
        expect(t.description).toMatch(/UTC/);
        expect(t.description).toMatch(/local/);
        expect(t.inputSchema.properties.flight_number).toBeUndefined();
        expect(t.annotations.readOnlyHint).toBe(true);
    });

    test('write mode adds suggest with flights:suggest and add/edit with flights:edit; flights:write grants none', async () => {
        writeMode();
        expect(await actionsOf('reader')).toEqual(READ);
        expect(await actionsOf('rest-writer')).toEqual(READ);
        expect(await actionsOf('job')).toEqual([...READ, 'suggest'].sort());
        expect(await actionsOf('editor')).toEqual(['add', 'edit', 'refresh', ...READ].sort());
        expect(await actionsOf('all')).toEqual(['add', 'edit', 'refresh', ...READ, 'suggest'].sort());
        expect(await actionsOf('suggest-only')).toBeNull();
        const t = await tool('job');
        expect(t.description).toMatch(/suggest:/);
        expect(t.description).not.toMatch(/add:|edit:/);
        expect(t.inputSchema.properties.source_key).toBeDefined();
        expect(t.inputSchema.properties.actual_dep).toBeUndefined();
    });

    test('mode off and a switched-off domain hide the tool', async () => {
        domains.setMcpMode(db.get(), 'flights', 'off', 'test');
        expect(await tool('all')).toBeUndefined();
        domains.setMcpMode(db.get(), 'flights', 'write', 'test');
        domains.setEnabled(db.get(), 'flights', false, 'test');
        expect(await tool('all')).toBeUndefined();
    });

    test('no delete, restore, accept or dismiss action exists', async () => {
        writeMode();
        for (const action of ['delete', 'restore', 'accept', 'dismiss']) expect(errorOf(await call('all', { action, id: past }))).toBe('refused');
    });
});

describe('mcp flights: reading', () => {
    test('list, upcoming, stats, trips: marked as data, no booking reference anywhere', async () => {
        const list = await call('reader', { action: 'list' });
        expect(textOf(list).startsWith(DATA_NOTE)).toBe(true);
        const l = jsonOf(list);
        expect(l.total).toBe(2);
        expect(l.flights[1]).toMatchObject({ id: past, flight_number: '3301', has_booking_ref: true, dep_local: '2026-02-10T06:05' });
        const up = jsonOf(await call('reader', { action: 'upcoming' }));
        expect(up.flights.map((f) => f.id)).toEqual([soon]);
        const stats = jsonOf(await call('reader', { action: 'stats', year: '2026' }));
        expect(stats).toBeDefined();
        const trips = jsonOf(await call('reader', { action: 'trips' }));
        expect(trips.trips[0].title).toBe('Winter visit');
        expect([textOf(list), JSON.stringify(up), JSON.stringify(stats), JSON.stringify(trips)].join()).not.toContain(REF);
        expect(jsonOf(await call('reader', { action: 'list', year: '2030' })).total).toBe(1);
    });

    test('get leaves the booking reference out unless include_booking_ref is true', async () => {
        const plain = jsonOf(await call('reader', { action: 'get', id: past }));
        expect(plain).toMatchObject({ id: past, notes: CANARY_NOTE, has_booking_ref: true });
        expect(plain.booking_ref).toBeUndefined();
        expect(JSON.stringify(plain)).not.toContain(REF);
        const withRef = jsonOf(await call('reader', { action: 'get', id: past, include_booking_ref: true }));
        expect(withRef.booking_ref).toBe(REF);
        expect(errorOf(await call('reader', { action: 'get', id: 99999 }))).toBe('not_found');
        expect(errorOf(await call('reader', { action: 'get' }))).toBe('bad_request');
    });
});

describe('mcp flights: suggest, add, edit', () => {
    test('suggest files a candidate, a repeat answers what exists, an existing flight says exists', async () => {
        writeMode();
        const args = { action: 'suggest', airline_iata: 'WN', flight_number: '7711', origin_iata: 'LIT', dest_iata: 'DAL', sched_dep: '2030-03-01T07:00', source: 'gmail', source_key: 'g:1', confidence: 0.8, booking_ref: REF };
        const first = jsonOf(await call('job', args));
        expect(first).toMatchObject({ status: 'filed', candidate: { status: 'pending', dep_local: '2030-03-01T07:00' } });
        expect(first.candidate.booking_ref).toBeUndefined();
        const again = jsonOf(await call('job', args));
        expect(again).toMatchObject({ status: 'already_suggested', candidate: { id: first.candidate.id } });
        const known = jsonOf(await call('job', { action: 'suggest', airline_iata: 'AA', flight_number: '3301', origin_iata: 'LIT', dest_iata: 'DFW', sched_dep: '2026-02-10T12:05:00Z' }));
        expect(known).toEqual({ status: 'exists', flight: { id: past, label: 'AA 3301 LIT-DFW 2026-02-10' } });
        const queue = jsonOf(await call('job', { action: 'candidates' }));
        expect(queue.counts.pending).toBe(1);
        expect(queue.candidates[0].source_key).toBeUndefined();
        expect(JSON.stringify([first, again, queue])).not.toContain(REF);
        expect(errorOf(await call('job', { action: 'suggest', airline_iata: 'WN' }))).toBe('bad_flight_number');
        expect(errorOf(await call('reader', { action: 'suggest', ...args }))).toBe('refused');
    });

    test('add and edit (flights:edit, write mode): revisions; a duplicate is refused', async () => {
        expect(errorOf(await call('editor', { action: 'add', airline_iata: 'AA', flight_number: '1' }))).toBe('refused');
        writeMode();
        const made = jsonOf(await call('editor', { action: 'add', airline_iata: 'B6', flight_number: '15', origin_iata: 'JFK', dest_iata: 'BOS', sched_dep: '2030-04-01T08:00' }));
        expect(made).toMatchObject({ status: 'created', rev: 1, label: 'B6 15 JFK-BOS 2030-04-01' });
        const edited = jsonOf(await call('editor', { action: 'edit', id: made.id, seat: '2a', note: 'moved' }));
        expect(edited).toMatchObject({ status: 'updated', rev: 2 });
        expect(flights.get(db.get(), made.id)).toMatchObject({ seat: '2A', updated_by: 'editor', source: 'manual' });
        const cancelled = jsonOf(await call('editor', { action: 'edit', id: made.id, status: 'cancelled' }));
        expect(cancelled.rev).toBe(3);
        expect(errorOf(await call('editor', { action: 'edit', id: made.id }))).toBe('bad_request');
        expect(errorOf(await call('editor', { action: 'add', airline_iata: 'B6', flight_number: '15', origin_iata: 'JFK', dest_iata: 'BOS', sched_dep: '2030-04-01T08:00' }))).toBe('duplicate');
        expect(errorOf(await call('job', { action: 'edit', id: made.id, seat: '1A' }))).toBe('refused');
    });
});

describe('mcp flights: audit', () => {
    test('mcp_call rows hold tool, action and outcome only, never arguments or results', async () => {
        writeMode();
        await call('reader', { action: 'list' });
        await call('reader', { action: 'get', id: past, include_booking_ref: true });
        await call('job', { action: 'suggest', airline_iata: 'F9', flight_number: '880', origin_iata: 'DEN', dest_iata: 'LAS', sched_dep: '2030-05-01T10:00Z', booking_ref: 'ZX9CAN', notes: 'canary-suggest-note' });
        await call('editor', { action: 'get', id: 99999 });
        await settle();
        const rows = audit.recent(db.get(), 300).filter((e) => e.action === 'mcp_call').slice(0, 4).reverse();
        expect(rows.map((r) => r.detail)).toEqual([
            { key: 'reader', tool: 'flights', action: 'list', ok: true },
            { key: 'reader', tool: 'flights', action: 'get', ok: true },
            { key: 'job', tool: 'flights', action: 'suggest', ok: true },
            { key: 'editor', tool: 'flights', action: 'get', ok: false, error: 'not_found' },
        ]);
        expect(JSON.stringify(audit.recent(db.get(), 500))).not.toMatch(new RegExp(`${REF}|ZX9CAN|canary`, 'i'));
    });

    test('hub_overview lists flights with its record count and this key\'s actions', async () => {
        const r = await rpc('reader', 'tools/call', { name: 'hub_overview', arguments: {} }).expect(200);
        const o = JSON.parse(r.body.result.content[0].text.replace(`${DATA_NOTE}\n`, ''));
        const d = o.domains.find((x) => x.name === 'flights');
        expect(d).toMatchObject({ mcpMode: 'read', actions: ['list', 'get', 'upcoming', 'stats', 'trips', 'candidates', 'sources'] });
        expect(d.records).toBeGreaterThanOrEqual(2);
    });
});

describe('mcp flights: flight_status on suggest and the effective status', () => {
    test('suggest takes flight_status and the candidate carries it; flights show status and status_override', async () => {
        writeMode();
        const args = { action: 'suggest', airline_iata: 'NK', flight_number: '910', origin_iata: 'DFW', dest_iata: 'LAS', sched_dep: '2030-05-09T08:00', source: 'gmail', source_key: 'g:910', flight_status: 'cancelled' };
        expect(jsonOf(await call('job', args))).toMatchObject({ status: 'filed', candidate: { flight_status: 'cancelled' } });
        expect(errorOf(await call('job', { ...args, flight_number: '911', source_key: 'g:911', flight_status: 'landed' }))).toBeTruthy();
        const got = jsonOf(await call('reader', { action: 'get', id: past }));
        expect(got).toMatchObject({ status: 'completed', status_override: null });
        expect(jsonOf(await call('reader', { action: 'get', id: soon }))).toMatchObject({ status: 'scheduled', status_override: null });
        expect(jsonOf(await call('reader', { action: 'list', status: 'completed' })).flights.map((x) => x.id)).toContain(past);
    });
});
