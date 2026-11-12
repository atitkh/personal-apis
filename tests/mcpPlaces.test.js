process.env.HUB_DB_FILE = ':memory:';

// The places agent tool. Every address, street and coordinate in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const places = require('../services/places');
const audit = require('../services/audit');
const agents = require('../services/mcp/agents');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes }).key; };
let home;
let cafe;

beforeAll(() => {
    make('reader', 'places:read');
    make('suggester', 'places:read, places:suggest');
    make('editor', 'places:read, places:agent-write');
    make('rest-writer', 'places:read, places:api-write');
    make('all', 'places:*');
    make('digests', 'digests:read');
    const conn = db.get();
    home = places.create(conn, {
        label: 'Home', kind: 'home', notes: 'The flat.',
        rules: [{ type: 'street', value: 'Maple Ridge Dr' }, { type: 'zone', value: 'home' }, { type: 'radius', lat: 11.25, lon: 22.5, radius_m: 80 }],
    }, 'seed').id;
    cafe = places.create(conn, { label: 'Corner cafe', kind: 'store', rules: [{ type: 'street', value: 'Springfield' }] }, 'seed').id;
});
afterAll(() => db.close());
afterEach(() => {
    domains.setEnabled(db.get(), 'places', true, 'test');
    domains.setMcpMode(db.get(), 'places', 'read', 'test');
});

const rpc = (key, method, params = {}, id = 1) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`)
    .send({ jsonrpc: '2.0', id, method, params });
const listTools = async (key) => (await rpc(key, 'tools/list').expect(200)).body.result.tools;
const tool = async (key) => (await listTools(key)).find((t) => t.name === 'places');
const actionsOf = async (key) => {
    const t = await tool(key);
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'places', arguments: args }).expect(200)).body.result;
const textOf = (r) => r.content[0].text;
const jsonOf = (r) => JSON.parse(textOf(r).replace(`${DATA_NOTE}\n`, ''));
// A hub error is JSON with a code; an action or argument the schema refuses is the SDK's own text.
const errorOf = (r) => {
    if (!r.isError) return 'no error';
    try { return JSON.parse(textOf(r)).error; } catch (err) { return /^MCP error/.test(textOf(r)) ? 'refused' : textOf(r); }
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const writeMode = () => domains.setMcpMode(db.get(), 'places', 'write', 'test');

describe('mcp places: what a key sees', () => {
    test('read mode: list, get, resolve for every places:read key; write actions are not described', async () => {
        for (const key of ['reader', 'suggester', 'editor', 'all']) expect(await actionsOf(key)).toEqual(['get', 'list', 'resolve']);
        const t = await tool('all');
        expect(t.description).not.toMatch(/suggest:|add:|edit:/);
        expect(t.inputSchema.properties.label).toBeUndefined();
        expect(t.inputSchema.properties.add_rules).toBeUndefined();
        expect(t.annotations.readOnlyHint).toBe(true);
    });

    test('write mode adds suggest with places:suggest and add/edit with places:agent-write', async () => {
        writeMode();
        expect(await actionsOf('reader')).toEqual(['get', 'list', 'resolve']);
        expect(await actionsOf('suggester')).toEqual(['get', 'list', 'resolve', 'suggest']);
        expect(await actionsOf('editor')).toEqual(['add', 'edit', 'get', 'list', 'resolve']);
        expect(await actionsOf('all')).toEqual(['add', 'edit', 'get', 'list', 'resolve', 'suggest']);
        const t = await tool('editor');
        expect(t.description).toMatch(/add:/);
        expect(t.description).not.toMatch(/suggest:/);
        expect(t.inputSchema.properties.add_rules).toBeDefined();
        expect(t.annotations.readOnlyHint).toBe(false);
    });

    test('the REST places:api-write scope grants no MCP write action', async () => {
        writeMode();
        expect(await actionsOf('rest-writer')).toEqual(['get', 'list', 'resolve']);
    });

    test('mode off or a disabled domain hides the tool; other keys never see it', async () => {
        expect(await tool('digests')).toBeUndefined();
        domains.setMcpMode(db.get(), 'places', 'off', 'test');
        expect(await tool('all')).toBeUndefined();
        writeMode();
        domains.setEnabled(db.get(), 'places', false, 'test');
        expect(await tool('all')).toBeUndefined();
    });

    test('there is no delete, restore or accept/dismiss action at all', () => {
        const def = require('../services/mcp/domains/places');
        expect(Object.keys(def.actions).sort()).toEqual(['add', 'edit', 'get', 'list', 'resolve', 'suggest']);
    });

    test('hub_overview lists places with its record count and the actions of this key', async () => {
        writeMode();
        const o = jsonOf((await rpc('editor', 'tools/call', { name: 'hub_overview', arguments: {} }).expect(200)).body.result);
        expect(o.domains).toEqual([expect.objectContaining({ name: 'places', sensitivity: 'private', mcpMode: 'write', records: places.stats(db.get()).records, actions: ['list', 'get', 'resolve', 'add', 'edit'] })]);
        expect(o.brief).toEqual([]);
    });

    test('the Agent access data lists places actions per key', async () => {
        writeMode();
        const s = agents.summary(db.get());
        const row = (name) => s.keys.find((k) => k.name === name);
        expect(row('reader').visibleTools).toEqual([{ tool: 'places', actions: ['list', 'get', 'resolve'] }]);
        expect(row('suggester').visibleTools).toEqual([{ tool: 'places', actions: ['list', 'get', 'resolve', 'suggest'] }]);
        expect(row('editor')).toMatchObject({ canWrite: true, visibleTools: [{ tool: 'places', actions: ['list', 'get', 'resolve', 'add', 'edit'] }] });
        expect(row('rest-writer').canWrite).toBe(false);
        const t = s.tools.find((x) => x.tool === 'places');
        expect(t.actions).toEqual(expect.arrayContaining([{ name: 'edit', scope: 'places:agent-write', write: true }, { name: 'suggest', scope: 'places:suggest', write: true }]));
    });
});

describe('mcp places: reading', () => {
    test('list returns rules with values, marked as data, and caps at 50', async () => {
        const r = await call('reader', { action: 'list' });
        expect(textOf(r).startsWith(DATA_NOTE)).toBe(true);
        const out = jsonOf(r);
        expect(out).toMatchObject({ count: 2, total: 2 });
        const h = out.places.find((p) => p.label === 'Home');
        expect(h).toEqual({ id: home, label: 'Home', kind: 'home', notes: 'The flat.', rev: 1, rules: [
            { id: expect.any(Number), type: 'street', value: 'Maple Ridge Dr' },
            { id: expect.any(Number), type: 'zone', value: 'home' },
            { id: expect.any(Number), type: 'radius', lat: 11.25, lon: 22.5, radius_m: 80 },
        ] });
        expect(jsonOf(await call('reader', { action: 'list', kind: 'store' })).places.map((p) => p.label)).toEqual(['Corner cafe']);
        expect(jsonOf(await call('reader', { action: 'list', limit: 1 }))).toMatchObject({ count: 1, total: 2 });
        expect(errorOf(await call('reader', { action: 'list', limit: 51 }))).toBe('refused');
    });

    test('get returns one place; a missing one is a tool error', async () => {
        expect(jsonOf(await call('reader', { action: 'get', id: home }))).toMatchObject({ id: home, label: 'Home', revisions: 1, source: 'manual', rules: expect.any(Array) });
        expect(errorOf(await call('reader', { action: 'get', id: 99999 }))).toBe('not_found');
        expect(errorOf(await call('reader', { action: 'get' }))).toBe('bad_request');
    });

    test('resolve gives label, kind, notes, confidence, rule type and alternative labels, no street text', async () => {
        const r = jsonOf(await call('reader', { action: 'resolve', geocode: '410 Maple Ridge Dr, Springfield, AR' }));
        expect(r).toEqual({ match: { id: home, label: 'Home', kind: 'home', notes: 'The flat.' }, confidence: 'street', matched_rule_type: 'street', alternatives: ['Corner cafe'] });
        expect(jsonOf(await call('reader', { action: 'resolve', lat: 11.2501, lon: 22.5001 }))).toMatchObject({ match: { label: 'Home' }, confidence: 'exact', matched_rule_type: 'radius' });
        expect(jsonOf(await call('reader', { action: 'resolve', zone: 'zone.home' })).matched_rule_type).toBe('zone');
        expect(errorOf(await call('reader', { action: 'resolve' }))).toBe('bad_query');
    });

    test('resolve never files a suggestion, even for a key that may suggest', async () => {
        writeMode();
        const before = places.suggestionCounts(db.get());
        expect(jsonOf(await call('suggester', { action: 'resolve', geocode: '9 Brambleworth Close, Elsewhere' }))).toEqual({ match: null });
        expect(places.suggestionCounts(db.get())).toEqual(before);
    });
});

describe('mcp places: writing', () => {
    test('suggest files an unmatched street once per sighting; a match files nothing', async () => {
        writeMode();
        const first = jsonOf(await call('suggester', { action: 'suggest', geocode: '9 Brambleworth Close, Elsewhere' }));
        expect(first).toEqual({ match: null, suggestion: { id: expect.any(Number), status: 'pending', count: 1 } });
        expect(jsonOf(await call('suggester', { action: 'suggest', geocode: '11 Brambleworth Close' })).suggestion).toMatchObject({ id: first.suggestion.id, count: 2 });
        expect(jsonOf(await call('suggester', { action: 'suggest', geocode: '410 Maple Ridge Dr' }))).not.toHaveProperty('suggestion');
        // A dismissed street is only counted.
        places.dismissSuggestion(db.get(), first.suggestion.id, 'admin');
        expect(jsonOf(await call('suggester', { action: 'suggest', geocode: '13 Brambleworth Close' })).suggestion).toMatchObject({ status: 'dismissed', count: 3 });
        expect(places.suggestions(db.get()).find((s) => s.id === first.suggestion.id)).toBeUndefined();
    });

    test('suggest is refused in read mode and without places:suggest, and nothing is filed', async () => {
        const before = places.suggestionCounts(db.get());
        expect(errorOf(await call('suggester', { action: 'suggest', geocode: '2 Wrenfold Mews' }))).toBe('refused');
        writeMode();
        expect(errorOf(await call('editor', { action: 'suggest', geocode: '2 Wrenfold Mews' }))).toBe('refused');
        expect(places.suggestionCounts(db.get())).toEqual(before);
    });

    test('add creates a place with rules as revision 1 by the key', async () => {
        writeMode();
        const out = jsonOf(await call('editor', { action: 'add', label: 'Pottery class', kind: 'other', notes: 'Wednesdays.', rules: [{ type: 'street', value: 'Quillfeather Lane' }] }));
        expect(out).toEqual({ status: 'created', id: expect.any(Number), label: 'Pottery class', rev: 1 });
        expect(places.get(db.get(), out.id)).toMatchObject({ kind: 'other', updated_by: 'editor', rules: [expect.objectContaining({ type: 'street', value: 'Quillfeather Lane' })] });
        expect(errorOf(await call('editor', { action: 'add', label: 'home' }))).toBe('label_taken');
        expect(errorOf(await call('editor', { action: 'add', label: 'Bad', rules: [{ type: 'street', value: 'x' }] }))).toBe('bad_rule');
    });

    test('edit changes fields and adds, updates and removes rules in one call, each as a revision', async () => {
        writeMode();
        const id = places.create(db.get(), { label: 'Gym', rules: [{ type: 'zone', value: 'gym' }, { type: 'street', value: 'Tannery Row' }] }, 'seed').id;
        const [zoneRule, streetRule] = places.get(db.get(), id).rules;
        const out = jsonOf(await call('editor', {
            action: 'edit', id, notes: 'Mornings.', note: 'agent tidy',
            add_rules: [{ type: 'street', value: 'Tannery Row West', exclude: true }],
            update_rules: [{ id: zoneRule.id, priority: 5 }],
            remove_rule_ids: [streetRule.id],
        }));
        expect(out).toMatchObject({ status: 'updated', id, label: 'Gym', rev: 5 });
        expect(out.changes.map((c) => c.what)).toEqual(['place', 'rule_added', 'rule_updated', 'rule_removed']);
        const p = places.get(db.get(), id);
        expect(p.notes).toBe('Mornings.');
        expect(p.rules.map((r) => [r.type, r.value, r.exclude, r.priority])).toEqual([['zone', 'gym', false, 5], ['street', 'Tannery Row West', true, 0]]);
        expect(places.history(db.get(), id).map((h) => h.actor)).toEqual(['editor', 'editor', 'editor', 'editor', 'seed']);
        expect(jsonOf(await call('editor', { action: 'edit', id, notes: 'Mornings.' }))).toMatchObject({ status: 'unchanged', changes: [] });
    });

    test('a failing step undoes the whole edit', async () => {
        writeMode();
        const id = places.create(db.get(), { label: 'Library', rules: [{ type: 'zone', value: 'library' }] }, 'seed').id;
        const r = await call('editor', { action: 'edit', id, label: 'City library', remove_rule_ids: [999999] });
        expect(errorOf(r)).toBe('no_rule');
        expect(places.get(db.get(), id)).toMatchObject({ label: 'Library', rev: 1 });
        expect(errorOf(await call('editor', { action: 'edit', id }))).toBe('bad_request');
        expect(errorOf(await call('editor', { action: 'edit', label: 'X' }))).toBe('bad_request');
    });

    test('add and edit are refused in read mode and for a REST write key, and change nothing', async () => {
        expect(errorOf(await call('editor', { action: 'add', label: 'Nope' }))).toBe('refused');
        writeMode();
        expect(errorOf(await call('rest-writer', { action: 'add', label: 'Nope' }))).toBe('refused');
        expect(errorOf(await call('rest-writer', { action: 'edit', id: home, notes: 'Nope' }))).toBe('refused');
        expect(places.list(db.get()).some((p) => p.label === 'Nope')).toBe(false);
        expect(places.get(db.get(), home).notes).toBe('The flat.');
    });
});

describe('mcp places: audit', () => {
    test('mcp_call rows hold tool, action and outcome only, never arguments or results', async () => {
        writeMode();
        await call('reader', { action: 'list' });
        await call('reader', { action: 'get', id: home });
        await call('reader', { action: 'resolve', geocode: '410 Maple Ridge Dr, Springfield', lat: 11.25, lon: 22.5 });
        await call('suggester', { action: 'suggest', geocode: '5 Larkspur Wynd, Elsewhere' });
        await call('editor', { action: 'add', label: 'Audit canary place', notes: 'canary notes', rules: [{ type: 'street', value: 'Canary Crescent' }] });
        await call('editor', { action: 'get', id: 99999 });
        await settle();
        const rows = audit.recent(db.get(), 300).filter((e) => e.action === 'mcp_call').slice(0, 6).reverse();
        expect(rows.map((r) => r.detail)).toEqual([
            { key: 'reader', key_id: expect.any(Number), tool: 'places', action: 'list', ok: true },
            { key: 'reader', key_id: expect.any(Number), tool: 'places', action: 'get', ok: true },
            { key: 'reader', key_id: expect.any(Number), tool: 'places', action: 'resolve', ok: true },
            { key: 'suggester', key_id: expect.any(Number), tool: 'places', action: 'suggest', ok: true },
            { key: 'editor', key_id: expect.any(Number), tool: 'places', action: 'add', ok: true },
            { key: 'editor', key_id: expect.any(Number), tool: 'places', action: 'get', ok: false, error: 'not_found' },
        ]);
        expect(JSON.stringify(audit.recent(db.get(), 500))).not.toMatch(/maple|ridge|springfield|larkspur|canary|flat|11\.25|22\.5|brambleworth|tannery|quillfeather/i);
    });
});

describe('places: editing a key changes its tools at once', () => {
    test('tools/list follows a scope change with the same secret', async () => {
        const k = apiKeys.create(db.get(), { name: 'live-mcp', scopes: 'digests:read' });
        keys['live-mcp'] = k.key;
        writeMode();
        expect(await tool('live-mcp')).toBeUndefined();

        apiKeys.update(db.get(), k.id, { scopes: ['digests:read', 'places:read'] });
        expect(await actionsOf('live-mcp')).not.toContain('add');
        expect(await tool('live-mcp')).toBeDefined();

        apiKeys.update(db.get(), k.id, { scopes: ['digests:read', 'places:read', 'places:agent-write'] });
        expect(await actionsOf('live-mcp')).toContain('add');

        apiKeys.update(db.get(), k.id, { scopes: ['digests:read', 'places:read'] });
        expect(await actionsOf('live-mcp')).not.toContain('add');

        apiKeys.update(db.get(), k.id, { scopes: ['digests:read'] });
        expect(await tool('live-mcp')).toBeUndefined();
    });
});
