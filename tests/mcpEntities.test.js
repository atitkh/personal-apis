process.env.HUB_DB_FILE = ':memory:';

// The entities agent tool. Every entity in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const entities = require('../services/entities');
const links = require('../services/links');
const trips = require('../services/trips');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes: `${scopes}, overview:read, briefing:read` }).key; };

beforeAll(() => {
    make('reader', 'entities:read');
    make('editor', 'entities:read, entities:agent-write');
    make('edit-only', 'entities:agent-write');
    make('linker', 'entities:read, trips:read');
    make('other', 'flights:read');
    const conn = db.get();
    entities.create(conn, { kind: 'person', name: 'Zorblax Quimby', aliases: ['Zed'], notes: 'Lab partner' }, 'seed');
    const t = trips.create(conn, { title: 'Lab visit', kind: 'work' }, 'seed').id;
    links.add(conn, { from: { domain: 'trips', id: String(t) }, to: { domain: 'entities', id: '1' }, rel: 'with' }, 'seed');
});
afterAll(() => db.close());
afterEach(() => domains.setMcpMode(db.get(), 'entities', 'read', 'test'));

const rpc = (key, method, params = {}) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`).send({ jsonrpc: '2.0', id: 1, method, params });
const actionsOf = async (key) => {
    const t = (await rpc(key, 'tools/list').expect(200)).body.result.tools.find((x) => x.name === 'entities');
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'entities', arguments: args }).expect(200)).body.result;
const jsonOf = (r) => JSON.parse(r.content[0].text.replace(`${DATA_NOTE}\n`, ''));

test('read mode: list, get and find for a read key; write adds add and edit only with agent-write', async () => {
    expect(await actionsOf('reader')).toEqual(['find', 'get', 'list']);
    expect(await actionsOf('edit-only')).toBeNull();
    expect(await actionsOf('other')).toBeNull();
    expect(await actionsOf('editor')).toEqual(['find', 'get', 'list']);
    domains.setMcpMode(db.get(), 'entities', 'write', 'test');
    expect(await actionsOf('editor')).toEqual(['add', 'edit', 'find', 'get', 'list']);
    expect(await actionsOf('reader')).toEqual(['find', 'get', 'list']);
});

test('find resolves a name or alias; results carry the data note', async () => {
    const r = await call('reader', { action: 'find', name: 'zed' });
    expect(r.content[0].text.startsWith(DATA_NOTE)).toBe(true);
    expect(jsonOf(r)).toMatchObject({ count: 1, entities: [{ id: 1, name: 'Zorblax Quimby' }] });
    expect(jsonOf(await call('reader', { action: 'list', q: 'lab' })).total).toBe(1);
});

test('get returns the links of the domains the key can read, and counts the rest as hidden', async () => {
    const plain = jsonOf(await call('reader', { action: 'get', id: 1 }));
    expect(plain).toMatchObject({ name: 'Zorblax Quimby', links: [], hidden: 1 });
    const seen = jsonOf(await call('linker', { action: 'get', id: 1 }));
    expect(seen.hidden).toBe(0);
    expect(seen.links[0].other).toMatchObject({ domain: 'trips', title: 'Lab visit' });
});

test('add and edit in write mode; no delete or restore action exists', async () => {
    domains.setMcpMode(db.get(), 'entities', 'write', 'test');
    const added = jsonOf(await call('editor', { action: 'add', kind: 'topic', name: 'Cold chain', aliases: ['cold storage'] }));
    expect(added).toMatchObject({ status: 'created', kind: 'topic' });
    expect(jsonOf(await call('editor', { action: 'edit', id: added.id, aliases: null, notes: 'Vaccines' }))).toMatchObject({ status: 'updated', fields: ['aliases', 'notes'] });
    expect(jsonOf(await call('reader', { action: 'find', name: 'cold storage' })).count).toBe(0);
    const r = await rpc('editor', 'tools/call', { name: 'entities', arguments: { action: 'delete', id: 1 } }).expect(200);
    expect(r.body.result.isError || r.body.error).toBeTruthy();
});
