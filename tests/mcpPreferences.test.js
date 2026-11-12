process.env.HUB_DB_FILE = ':memory:';

// The preferences agent tool. Every preference in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const preferences = require('../services/preferences');
const audit = require('../services/audit');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes }).key; };

beforeAll(() => {
    make('reader', 'preferences:read');
    make('editor', 'preferences:read, preferences:edit');
    make('edit-only', 'preferences:edit');
    make('rest-writer', 'preferences:read, preferences:write');
    make('other', 'flights:read');
    make('all', 'preferences:*');
    const conn = db.get();
    preferences.create(conn, { area: 'travel', key: 'airline_seat', value: 'aisle', notes: 'near the front' }, 'seed');
    preferences.create(conn, { area: 'communication', key: 'call_hours', value: 'No calls before 10 am' }, 'seed');
});
afterAll(() => db.close());
afterEach(() => {
    domains.setEnabled(db.get(), 'preferences', true, 'test');
    domains.setMcpMode(db.get(), 'preferences', 'read', 'test');
});

const rpc = (key, method, params = {}, id = 1) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`)
    .send({ jsonrpc: '2.0', id, method, params });
const listTools = async (key) => (await rpc(key, 'tools/list').expect(200)).body.result.tools;
const tool = async (key) => (await listTools(key)).find((t) => t.name === 'preferences');
const actionsOf = async (key) => {
    const t = await tool(key);
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'preferences', arguments: args }).expect(200)).body.result;
const textOf = (r) => r.content[0].text;
const jsonOf = (r) => JSON.parse(textOf(r).replace(`${DATA_NOTE}\n`, ''));
const errorOf = (r) => {
    if (!r.isError) return 'no error';
    try { return JSON.parse(textOf(r)).error; } catch (err) { return /^MCP error/.test(textOf(r)) ? 'refused' : textOf(r); }
};

describe('visibility per key and mode', () => {
    test('read mode: read actions for a read key; nothing for others', async () => {
        expect(await actionsOf('reader')).toEqual(['get', 'list']);
        expect(await actionsOf('editor')).toEqual(['get', 'list']);
        expect(await actionsOf('all')).toEqual(['get', 'list']);
        expect(await actionsOf('rest-writer')).toEqual(['get', 'list']);
        expect(await actionsOf('edit-only')).toBeNull();      // no read scope: the tool is not offered
        expect(await actionsOf('other')).toBeNull();
    });

    test('write mode adds set and unset only with preferences:edit', async () => {
        domains.setMcpMode(db.get(), 'preferences', 'write', 'test');
        expect(await actionsOf('reader')).toEqual(['get', 'list']);
        expect(await actionsOf('editor')).toEqual(['get', 'list', 'set', 'unset']);
        expect(await actionsOf('all')).toEqual(['get', 'list', 'set', 'unset']);
        expect(await actionsOf('rest-writer')).toEqual(['get', 'list']); // preferences:write is REST only
        expect(await actionsOf('edit-only')).toBeNull();
    });

    test('mode off or domain off hides the tool; results start with the data note', async () => {
        const r = await call('reader', { action: 'list' });
        expect(textOf(r).startsWith(DATA_NOTE)).toBe(true);
        domains.setMcpMode(db.get(), 'preferences', 'off', 'test');
        expect(await actionsOf('reader')).toBeNull();
        domains.setMcpMode(db.get(), 'preferences', 'read', 'test');
        domains.setEnabled(db.get(), 'preferences', false, 'test');
        expect(await actionsOf('reader')).toBeNull();
    });

    test('a call to an action the key cannot use is refused', async () => {
        expect(errorOf(await call('reader', { action: 'set', area: 'food', key: 'x', value: 'y' }))).toMatch(/refused|not_allowed|Invalid/);
        domains.setMcpMode(db.get(), 'preferences', 'write', 'test');
        expect(errorOf(await call('reader', { action: 'unset', area: 'travel', key: 'airline_seat' }))).toMatch(/refused|not_allowed|Invalid/);
        expect(preferences.getByKey(db.get(), 'travel', 'airline_seat').removed).toBe(false);
    });
});

describe('reading', () => {
    test('list and get; no internal columns', async () => {
        const list = jsonOf(await call('reader', { action: 'list' }));
        expect(list.total).toBe(2);
        expect(list.preferences.map((p) => `${p.area}/${p.key}`)).toEqual(['travel/airline_seat', 'communication/call_hours']);
        expect(list.preferences[0]).toMatchObject({ value: 'aisle', notes: 'near the front' });
        expect(list.preferences[0]).not.toHaveProperty('updated_by');
        expect(jsonOf(await call('reader', { action: 'list', area: 'communication' })).total).toBe(1);
        expect(jsonOf(await call('reader', { action: 'list', q: 'calls' })).preferences[0].key).toBe('call_hours');
        expect(jsonOf(await call('reader', { action: 'get', area: 'travel', key: 'Airline Seat' }))).toMatchObject({ value: 'aisle' });
        expect(jsonOf(await call('reader', { action: 'get', id: 2 })).key).toBe('call_hours');
        expect(errorOf(await call('reader', { action: 'get', area: 'travel', key: 'nope' }))).toBe('not_found');
        expect(errorOf(await call('reader', { action: 'get' }))).toBe('bad_request');
        expect(errorOf(await call('reader', { action: 'list', area: 'pets' }))).toBe('bad_area');
    });
});

describe('writing', () => {
    beforeEach(() => domains.setMcpMode(db.get(), 'preferences', 'write', 'test'));

    test('set creates and updates by area and key; unset hides', async () => {
        const made = jsonOf(await call('editor', { action: 'set', area: 'food', key: 'allergy', value: 'peanuts' }));
        expect(made).toMatchObject({ status: 'created', area: 'food', key: 'allergy', rev: 1 });
        const changed = jsonOf(await call('editor', { action: 'set', area: 'food', key: 'allergy', value: 'peanuts and shrimp', note: 'added shrimp' }));
        expect(changed).toMatchObject({ status: 'updated', id: made.id, rev: 2, fields: ['value'] });
        expect(jsonOf(await call('editor', { action: 'set', area: 'food', key: 'allergy', value: 'peanuts and shrimp' })).status).toBe('unchanged');
        expect(jsonOf(await call('editor', { action: 'unset', area: 'food', key: 'allergy' }))).toMatchObject({ status: 'unset', id: made.id });
        expect(jsonOf(await call('reader', { action: 'list', area: 'food' })).total).toBe(0);
        expect(jsonOf(await call('editor', { action: 'set', area: 'food', key: 'allergy', value: 'none' }))).toMatchObject({ status: 'created', id: made.id });
        expect(jsonOf(await call('editor', { action: 'unset', id: made.id })).status).toBe('unset');
        expect(preferences.history(db.get(), made.id)[0].actor).toBe('editor');
    });

    test('secret-looking text and bad input are clean errors', async () => {
        expect(errorOf(await call('editor', { action: 'set', area: 'food', key: 'k', value: 'sk-live-123' }))).toBe('secret_like');
        const r = await call('editor', { action: 'set', area: 'food', key: 'wifi_password', value: 'tulips' });
        expect(errorOf(r)).toBe('secret_like');
        expect(textOf(r)).toContain('Keep passwords, numbers and keys in the vault, not here.');
        expect(errorOf(await call('editor', { action: 'set', area: 'food', key: 'k', value: 'card 4111 1111 1111 1111' }))).toBe('secret_like');
        expect(errorOf(await call('editor', { action: 'set', area: 'pets', key: 'k', value: 'v' }))).toBe('bad_area');
        expect(errorOf(await call('editor', { action: 'set', area: 'food', key: 'k' }))).toBe('bad_request');
        expect(errorOf(await call('editor', { action: 'set', key: 'k', value: 'v' }))).toBe('bad_request');
        expect(errorOf(await call('editor', { action: 'unset', area: 'food', key: 'ghost' }))).toBe('not_found');
        expect(errorOf(await call('editor', { action: 'unset' }))).toBe('bad_request');
    });

    test('a read-mode domain refuses writes even for an edit key; mcp audit rows hold no values', async () => {
        await call('editor', { action: 'set', area: 'home', key: 'thermostat', value: 'cool at night, canary-heronsgate' });
        domains.setMcpMode(db.get(), 'preferences', 'read', 'test');
        expect(errorOf(await call('editor', { action: 'set', area: 'home', key: 'x', value: 'y' }))).toMatch(/refused|not_allowed|Invalid/);
        expect(JSON.stringify(audit.recent(db.get(), 300))).not.toContain('canary-heronsgate');
    });
});
