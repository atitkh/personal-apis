process.env.HUB_DB_FILE = ':memory:';

// The graph actions of the links agent tool (neighbors, hubs, unlinked): they follow the key's readable domains. Invented data.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const entities = require('../services/entities');
const trips = require('../services/trips');
const deadlines = require('../services/deadlines');
const links = require('../services/links');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes: `${scopes}, overview:read` }).key; };
const rec = (domain, id) => ({ domain, id: String(id) });
let ent; let trip; let dl;

beforeAll(() => {
    make('all', 'links:read, entities:read, trips:read, deadlines:read');
    make('no-trips', 'links:read, entities:read, deadlines:read');
    make('no-links', 'entities:read');
    const c = db.get();
    ent = entities.create(c, { kind: 'person', name: 'Zorblax Quimby' }, 'seed').id;
    trip = trips.create(c, { title: 'Harbor visit', kind: 'work' }, 'seed').id;
    dl = deadlines.create(c, { title: 'Renew parking permit', kind: 'license', due_date: '2027-03-01' }, 'seed').id;
    entities.create(c, { kind: 'topic', name: 'Lonely topic' }, 'seed');
    // entity -- trip -- deadline: the deadline is only reachable through the trip
    links.add(c, { from: rec('trips', trip), to: rec('entities', ent), rel: 'with' }, 'seed');
    links.add(c, { from: rec('deadlines', dl), to: rec('trips', trip), rel: 'for' }, 'seed');
});
afterAll(() => db.close());

const rpc = (key, method, params = {}) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`).send({ jsonrpc: '2.0', id: 1, method, params });
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'links', arguments: args }).expect(200)).body.result;
const jsonOf = (r) => JSON.parse(r.content[0].text.replace(`${DATA_NOTE}\n`, ''));

test('read key sees the graph actions; a key without links:read has no links tool', async () => {
    const t = (await rpc('all', 'tools/list').expect(200)).body.result.tools.find((x) => x.name === 'links');
    expect([...t.inputSchema.properties.action.enum].sort()).toEqual(['hubs', 'neighbors', 'related', 'unlinked']);
    const none = (await rpc('no-links', 'tools/list').expect(200)).body.result.tools.find((x) => x.name === 'links');
    expect(none).toBeUndefined();
});

test('neighbors: one step, two steps, directions and titles', async () => {
    const one = jsonOf(await call('all', { action: 'neighbors', domain: 'trips', id: trip }));
    expect(one.record.title).toBe('Harbor visit');
    expect(one.neighbors.map((n) => n.domain).sort()).toEqual(['deadlines', 'entities']);
    expect(one.links).toHaveLength(2);
    expect(one.links.find((l) => l.rel === 'for')).toMatchObject({ from_title: 'Renew parking permit', to_title: 'Harbor visit' });
    expect(one.hidden).toBe(0);
    const two = jsonOf(await call('all', { action: 'neighbors', domain: 'entities', id: ent, depth: 2 }));
    expect(two.neighbors.map((n) => n.steps).sort()).toEqual([1, 2]);
});

test('neighbors: a key that cannot read trips sees neither trips nor what is only reachable through them', async () => {
    const r = jsonOf(await call('no-trips', { action: 'neighbors', domain: 'entities', id: ent, depth: 2 }));
    expect(r.neighbors).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.hidden).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/Harbor visit|parking/);
    const denied = await call('no-trips', { action: 'neighbors', domain: 'trips', id: trip });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text).error).toBe('not_allowed');
});

test('neighbors: an unknown record is an error, not a crash', async () => {
    const r = await call('all', { action: 'neighbors', domain: 'trips', id: 99999 });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe('not_found');
});

test('hubs and unlinked follow the key\'s domains', async () => {
    const h = jsonOf(await call('all', { action: 'hubs' }));
    expect(h.hubs[0]).toMatchObject({ domain: 'trips', title: 'Harbor visit', links: 2 });
    const hn = jsonOf(await call('no-trips', { action: 'hubs' }));
    expect(hn.hubs.every((x) => x.domain !== 'trips')).toBe(true);
    const u = jsonOf(await call('all', { action: 'unlinked' }));
    expect(u.counts.entities.unlinked).toBe(1);
    const un = jsonOf(await call('no-trips', { action: 'unlinked' }));
    expect(un.counts.trips).toBeUndefined();
    const list = jsonOf(await call('all', { action: 'unlinked', domain: 'entities' }));
    expect(list.records.map((x) => x.title)).toEqual(['Lonely topic']);
    const deniedList = await call('no-trips', { action: 'unlinked', domain: 'trips' });
    expect(deniedList.isError).toBe(true);
});

test('no arguments or results land in the audit rows', async () => {
    const rows = db.get().prepare("SELECT detail FROM audit_log WHERE action = 'mcp_call'").all();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/Harbor visit|Zorblax/);
});
