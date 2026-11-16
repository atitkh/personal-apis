process.env.HUB_DB_FILE = ':memory:';

// The notes agent tool. Every note and name in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const entities = require('../services/entities');
const notes = require('../services/notes');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes: `${scopes}, overview:read, briefing:read` }).key; };

beforeAll(() => {
    make('reader', 'notes:read');
    make('editor', 'notes:read, notes:agent-write, entities:read');
    make('edit-only', 'notes:agent-write');
    make('other', 'flights:read');
    const conn = db.get();
    entities.create(conn, { kind: 'person', name: 'Zorblax Quimby', aliases: ['Zed'] }, 'seed');
    notes.create(conn, { title: 'Lab log', body: `${'intro words '.repeat(1000)} marmalade at the end`, tags: ['lab'] }, 'seed');
});
afterAll(() => db.close());
afterEach(() => domains.setMcpMode(db.get(), 'notes', 'read', 'test'));

const rpc = (key, method, params = {}) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`).send({ jsonrpc: '2.0', id: 1, method, params });
const actionsOf = async (key) => {
    const t = (await rpc(key, 'tools/list').expect(200)).body.result.tools.find((x) => x.name === 'notes');
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'notes', arguments: args }).expect(200)).body.result;
const jsonOf = (r) => JSON.parse(r.content[0].text.replace(`${DATA_NOTE}\n`, ''));

test('read mode: list, get and search for a read key; write adds add, append and edit only with agent-write', async () => {
    expect(await actionsOf('reader')).toEqual(['get', 'list', 'search']);
    expect(await actionsOf('edit-only')).toBeNull();
    expect(await actionsOf('other')).toBeNull();
    expect(await actionsOf('editor')).toEqual(['get', 'list', 'search']);
    domains.setMcpMode(db.get(), 'notes', 'write', 'test');
    expect(await actionsOf('editor')).toEqual(['add', 'append', 'edit', 'get', 'list', 'search']);
    expect(await actionsOf('reader')).toEqual(['get', 'list', 'search']);
});

test('results carry the data note; get clips a long body and says so; search returns a snippet', async () => {
    const r = await call('reader', { action: 'get', id: 1 });
    expect(r.content[0].text.startsWith(DATA_NOTE)).toBe(true);
    const n = jsonOf(r);
    expect(n).toMatchObject({ title: 'Lab log', truncated: true, links: [] });
    expect(n.body.length).toBeLessThan(8300);
    expect(n.body).toContain('truncated');
    const s = jsonOf(await call('reader', { action: 'search', q: 'MARMALADE' }));
    expect(s.notes[0]).toMatchObject({ id: 1, title: 'Lab log' });
    expect(s.notes[0].snippet).toContain('marmalade');
    const l = jsonOf(await call('reader', { action: 'list', tag: 'lab' }));
    expect(l).toMatchObject({ count: 1, notes: [{ title: 'Lab log' }] });
    expect(l.notes[0]).not.toHaveProperty('body');
});

test('add, append and edit in write mode link wikilinks as the key; no delete or restore action exists', async () => {
    domains.setMcpMode(db.get(), 'notes', 'write', 'test');
    const added = jsonOf(await call('editor', { action: 'add', title: 'Inbox item', kind: 'inbox', body: 'Ask [[Zed]] about [[Missing page]]', pin: true }));
    expect(added).toMatchObject({ status: 'created', kind: 'inbox', links: { added: 1 }, unresolved: ['Missing page'] });
    expect(db.get().prepare("SELECT actor, rel FROM links WHERE from_domain = 'notes' AND from_id = ?").get(String(added.id))).toEqual({ actor: 'editor', rel: 'mentions' });
    expect(jsonOf(await call('editor', { action: 'append', id: added.id, text: 'Also [[Lab log]]' }))).toMatchObject({ status: 'updated', rev: 2, links: { added: 1, resolved: 2 } });
    expect(notes.get(db.get(), added.id).body).toBe('Ask [[Zed]] about [[Missing page]]\n\nAlso [[Lab log]]');
    expect(jsonOf(await call('editor', { action: 'edit', id: added.id, title: 'Inbox item 2', tags: ['a'] }))).toMatchObject({ status: 'updated', fields: ['title', 'tags'] });
    expect(jsonOf(await call('editor', { action: 'get', id: added.id })).links).toHaveLength(2);
    for (const action of ['delete', 'restore', 'trash']) {
        const r = await rpc('editor', 'tools/call', { name: 'notes', arguments: { action, id: 1 } }).expect(200);
        expect(r.body.result.isError || r.body.error).toBeTruthy();
    }
});

test('a read-mode key cannot write even with the scope; a missing id or text is an error', async () => {
    const r = await rpc('editor', 'tools/call', { name: 'notes', arguments: { action: 'add', title: 'x' } }).expect(200);
    expect(r.body.result.isError || r.body.error).toBeTruthy();
    domains.setMcpMode(db.get(), 'notes', 'write', 'test');
    expect((await rpc('editor', 'tools/call', { name: 'notes', arguments: { action: 'append', id: 1 } }).expect(200)).body.result.isError).toBe(true);
    expect((await rpc('editor', 'tools/call', { name: 'notes', arguments: { action: 'add', body: 'no title' } }).expect(200)).body.result.isError).toBe(true);
});
