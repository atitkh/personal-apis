process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const digests = require('../services/digests');
const audit = require('../services/audit');
const registry = require('../services/mcp/registry');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const keyRecords = {};
const make = (name, scopes) => {
    const k = apiKeys.create(db.get(), { name, scopes });
    keys[name] = k.key;
    keyRecords[name] = { id: k.id, name, scopes: k.scopes };
};

beforeAll(() => {
    make('reader', 'digests:read');
    make('editor', 'digests:read, digests:edit');
    make('publisher', 'digests:read, digests:publish');
    make('legacy-writer', 'digests:read, digests:write');
    make('digests-all', 'digests:*');
    make('everything', '*');
    make('portfolio-only', 'portfolio:read');
    make('flights', 'attendance:read');
});
afterAll(() => db.close());

// Every test starts from the defaults: both domains on, MCP mode read.
afterEach(() => {
    for (const name of domains.names()) {
        domains.setEnabled(db.get(), name, true, 'test');
        domains.setMcpMode(db.get(), name, 'read', 'test');
    }
});

const rpc = (key, method, params = {}, id = 1) => {
    const r = request(app).post('/hub/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json');
    if (key) r.set('Authorization', `Bearer ${key}`);
    return r.send({ jsonrpc: '2.0', id, method, params });
};
const listTools = async (name) => {
    const res = await rpc(keys[name], 'tools/list').expect(200);
    return res.body.result.tools;
};
const toolNames = async (name) => (await listTools(name)).map((t) => t.name).sort();
const actionsOf = async (name, tool) => {
    const t = (await listTools(name)).find((x) => x.name === tool);
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (name, tool, args) => (await rpc(keys[name], 'tools/call', { name: tool, arguments: args }).expect(200)).body.result;
const textOf = (result) => result.content[0].text;
const jsonOf = (result) => JSON.parse(textOf(result).replace(`${DATA_NOTE}\n`, ''));
const mcpRows = () => audit.recent(db.get(), 200).filter((e) => e.action === 'mcp_call');

// The audit row is written when the response finishes; give the server a moment.
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('mcp: access', () => {
    test('a request without a key is refused with 401', async () => {
        await rpc(null, 'tools/list').expect(401);
    });

    test('an unknown or revoked key is refused with 401', async () => {
        await rpc('pak_not-a-real-key', 'tools/list').expect(401);
        const k = apiKeys.create(db.get(), { name: 'gone', scopes: 'digests:read' });
        apiKeys.revoke(db.get(), k.id);
        await rpc(k.key, 'tools/list').expect(401);
    });

    test('GET is 405 because the endpoint is stateless', async () => {
        await request(app).get('/hub/mcp').set('Authorization', `Bearer ${keys.reader}`).expect(405);
    });

    test('/api does not list the MCP endpoint', async () => {
        const res = await request(app).get('/api').expect(200);
        expect(JSON.stringify(res.body)).not.toMatch(/mcp|\/hub/i);
    });

    test('a key with no hub scopes sees only the two hub tools', async () => {
        expect(await toolNames('flights')).toEqual(['hub_briefing', 'hub_overview']);
    });
});

describe('mcp: which tools a key sees', () => {
    test('a read-only key sees digests without edit or publish', async () => {
        expect(await actionsOf('reader', 'digests')).toEqual(['get', 'recent', 'search']);
        const props = (await listTools('reader')).find((t) => t.name === 'digests').inputSchema.properties;
        expect(props.body).toBeUndefined();
        expect(props.sources).toBeUndefined();
    });

    test('a key without a digests scope does not see the digests tool', async () => {
        expect(await toolNames('portfolio-only')).toEqual(['hub_briefing', 'hub_overview', 'portfolio']);
    });

    test('mcp_mode read hides write actions even from a digests:* key', async () => {
        expect(await actionsOf('digests-all', 'digests')).toEqual(['get', 'recent', 'search']);
    });

    test('mcp_mode write offers each write action only with its own scope', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        expect(await actionsOf('digests-all', 'digests')).toEqual(['edit', 'get', 'publish', 'recent', 'search']);
        expect(await actionsOf('everything', 'digests')).toEqual(['edit', 'get', 'publish', 'recent', 'search']);
        expect(await actionsOf('editor', 'digests')).toEqual(['edit', 'get', 'recent', 'search']);
        expect(await actionsOf('publisher', 'digests')).toEqual(['get', 'publish', 'recent', 'search']);
        expect(await actionsOf('reader', 'digests')).toEqual(['get', 'recent', 'search']);
    });

    test('the REST digests:write scope does not grant MCP edit or publish', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        expect(await actionsOf('legacy-writer', 'digests')).toEqual(['get', 'recent', 'search']);
    });

    test('mcp_mode off hides the tool', async () => {
        domains.setMcpMode(db.get(), 'digests', 'off', 'test');
        expect(await toolNames('everything')).toEqual(['deadlines', 'flights', 'hub_briefing', 'hub_overview', 'places', 'portfolio', 'preferences']);
    });

    test('a disabled domain hides the tool even in write mode', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        domains.setEnabled(db.get(), 'digests', false, 'test');
        expect(await toolNames('everything')).toEqual(['deadlines', 'flights', 'hub_briefing', 'hub_overview', 'places', 'portfolio', 'preferences']);
    });

    test('portfolio is read-only', async () => {
        domains.setMcpMode(db.get(), 'portfolio', 'write', 'test');
        expect(await actionsOf('everything', 'portfolio')).toEqual(['get', 'list']);
    });

    test('mcp_mode rejects unknown values and domains.list reports it', () => {
        expect(() => domains.setMcpMode(db.get(), 'digests', 'admin', 'test')).toThrow();
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        expect(domains.list(db.get()).find((d) => d.name === 'digests').mcpMode).toBe('write');
        expect(domains.list(db.get()).find((d) => d.name === 'portfolio').mcpMode).toBe('read');
    });
});

describe('mcp: digests', () => {
    const BODY = '# 2026-11-01\n\nMorning run. Lunch with Sam. SECRET-MARKER-123 in the text.';

    test('publish creates revision 1 with meta.sources, like the nightly job', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        const result = await call('publisher', 'digests', {
            action: 'publish', kind: 'daily', period: '2026-11-01', body: BODY, model: 'bonsai2',
            sources: { calendar: 'ok', email: 'failed' },
        });
        expect(result.isError).toBeFalsy();
        expect(jsonOf(result)).toEqual({ status: 'created', rev: 1 });
        const d = digests.get(db.get(), 'daily', '2026-11-01');
        expect(d).toMatchObject({ rev: 1, source: 'generated', actor: 'publisher', model: 'bonsai2', meta: { sources: { calendar: 'ok', email: 'failed' } } });
        expect(d.body.startsWith('Morning run.')).toBe(true);

        const again = await call('publisher', 'digests', { action: 'publish', kind: 'daily', period: '2026-11-01', body: BODY });
        expect(jsonOf(again)).toEqual({ status: 'unchanged', rev: 1 });
    });

    test('edit creates revision 2, and publish then keeps the hand edit unless forced', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        const result = await call('editor', 'digests', { action: 'edit', kind: 'daily', period: '2026-11-01', body: 'Fixed text.', note: 'typo' });
        expect(jsonOf(result)).toEqual({ status: 'updated', rev: 2 });
        const d = digests.get(db.get(), 'daily', '2026-11-01');
        expect(d).toMatchObject({ rev: 2, source: 'edit', actor: 'editor', note: 'typo', body: 'Fixed text.' });
        expect(digests.get(db.get(), 'daily', '2026-11-01', { rev: 1 }).source).toBe('generated');

        const kept = await call('publisher', 'digests', { action: 'publish', kind: 'daily', period: '2026-11-01', body: 'New generated.' });
        expect(kept.isError).toBe(true);
        expect(JSON.parse(textOf(kept)).error).toBe('edited');
        const forced = await call('publisher', 'digests', { action: 'publish', kind: 'daily', period: '2026-11-01', body: 'New generated.', force: true });
        expect(jsonOf(forced)).toEqual({ status: 'updated', rev: 3 });
    });

    test('get, recent and search return stored text marked as data', async () => {
        const got = await call('reader', 'digests', { action: 'get', kind: 'daily', period: '2026-11-01' });
        expect(textOf(got).startsWith(DATA_NOTE)).toBe(true);
        expect(jsonOf(got)).toMatchObject({ period: '2026-11-01', rev: 3, truncated: false, body: 'New generated.' });
        const first = await call('reader', 'digests', { action: 'get', kind: 'daily', period: '2026-11-01', rev: 1 });
        expect(jsonOf(first).body).toMatch(/SECRET-MARKER-123/);

        const recent = await call('reader', 'digests', { action: 'recent' });
        expect(textOf(recent).startsWith(DATA_NOTE)).toBe(true);
        expect(jsonOf(recent).digests.map((d) => d.period)).toContain('2026-11-01');

        const found = await call('reader', 'digests', { action: 'search', query: 'generated' });
        expect(jsonOf(found).results.map((r) => r.period)).toEqual(['2026-11-01']);
    });

    test('a missing digest or a missing argument is a tool error, not a crash', async () => {
        const missing = await call('reader', 'digests', { action: 'get', kind: 'daily', period: '2020-01-01' });
        expect(missing.isError).toBe(true);
        expect(JSON.parse(textOf(missing)).error).toBe('not_found');
        const noPeriod = await call('reader', 'digests', { action: 'get' });
        expect(JSON.parse(textOf(noPeriod)).error).toBe('bad_request');
    });

    test('a read-only key cannot publish: the action is rejected and nothing is stored', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        const result = await call('reader', 'digests', { action: 'publish', kind: 'daily', period: '2026-11-02', body: 'x' });
        expect(result.isError).toBe(true);
        expect(() => digests.get(db.get(), 'daily', '2026-11-02')).toThrow();
    });

    test('a call is checked again at run time if the operator changed the mode after tools/list', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        const server = registry.buildServer(db.get(), keyRecords.editor);
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test', version: '1' });
        await Promise.all([server.connect(b), client.connect(a)]);
        const tools = (await client.listTools()).tools;
        expect(tools.find((t) => t.name === 'digests').inputSchema.properties.action.enum).toContain('edit');

        domains.setMcpMode(db.get(), 'digests', 'read', 'test');
        const refused = await client.callTool({ name: 'digests', arguments: { action: 'edit', kind: 'daily', period: '2026-11-01', body: 'Sneaky.' } });
        expect(refused.isError).toBe(true);
        expect(JSON.parse(refused.content[0].text).error).toBe('not_allowed');

        domains.setEnabled(db.get(), 'digests', false, 'test');
        const off = await client.callTool({ name: 'digests', arguments: { action: 'get', kind: 'daily', period: '2026-11-01' } });
        expect(JSON.parse(off.content[0].text).error).toBe('not_allowed');
        expect(digests.get(db.get(), 'daily', '2026-11-01').body).toBe('New generated.');
        await client.close();
    });
});

describe('mcp: size caps', () => {
    test('a long digest is returned up to 20000 characters with a truncation marker', async () => {
        digests.put(db.get(), 'daily', '2026-10-01', { body: 'word '.repeat(8000), actor: 'test' });
        const got = await call('reader', 'digests', { action: 'get', kind: 'daily', period: '2026-10-01' });
        const d = jsonOf(got);
        expect(d.truncated).toBe(true);
        expect(d.body).toMatch(/…\[truncated: showing 20000 of 39999 characters\]$/);
        expect(d.body.length).toBeLessThan(20100);
        expect(textOf(got).length).toBeLessThanOrEqual(32100);
    });

    test('recent shares the text budget between digests', async () => {
        for (let day = 2; day <= 8; day++) digests.put(db.get(), 'daily', `2026-10-0${day}`, { body: 'long '.repeat(6000), actor: 'test' });
        const recent = await call('reader', 'digests', { action: 'recent', count: 7 });
        expect(textOf(recent).length).toBeLessThan(24000);
        const items = jsonOf(recent).digests;
        expect(items).toHaveLength(7);
        expect(items.filter((d) => d.truncated).length).toBeGreaterThanOrEqual(6);
    });

    test('hub_overview drops brief items past its hard cap and says so', () => {
        const def = registry.TOOLS.find((t) => t.domain === 'digests');
        const original = def.brief;
        def.brief = () => Array.from({ length: 30 }, (_, i) => ({ kind: 'daily', period: `2026-09-${i}`, text: 'x'.repeat(600) }));
        try {
            const result = registry.overview(db.get(), keyRecords.reader);
            const text = result.content[0].text;
            expect(text.length).toBeLessThanOrEqual(6000);
            const o = JSON.parse(text.replace(`${DATA_NOTE}\n`, ''));
            expect(o.truncated).toBe(true);
            expect(o.truncatedNote).toMatch(/Shortened/);
            expect(o.brief.length).toBeLessThan(30);
        } finally {
            def.brief = original;
        }
    });

    test('hub_overview stays under 6000 characters with a 600-character brief per digest', async () => {
        const result = await call('everything', 'hub_overview', {});
        const text = textOf(result);
        expect(text.length).toBeLessThanOrEqual(6000);
        expect(text.startsWith(DATA_NOTE)).toBe(true);
        const o = jsonOf(result);
        expect(o.brief.length).toBeGreaterThan(0);
        expect(o.brief.length).toBeLessThanOrEqual(3);
        for (const b of o.brief) expect(b.text.length).toBeLessThan(700);
        expect(o.brief.some((b) => b.truncated)).toBe(true);
    });
});

describe('mcp: hub_overview', () => {
    test('shows only the domains this key can reach', async () => {
        const all = jsonOf(await call('everything', 'hub_overview', {}));
        expect(all.domains.map((d) => d.name)).toEqual(['deadlines', 'digests', 'flights', 'places', 'portfolio', 'preferences']);
        const digestsRow = all.domains.find((d) => d.name === 'digests');
        expect(digestsRow).toMatchObject({ title: 'Digests', sensitivity: 'private', mcpMode: 'read', actions: ['recent', 'get', 'search'] });
        expect(digestsRow.records).toBeGreaterThan(0);

        const result = await call('portfolio-only', 'hub_overview', {});
        expect(textOf(result)).not.toMatch(/digest/i);
        const p = jsonOf(result);
        expect(p.domains.map((d) => d.name)).toEqual(['portfolio']);
        expect(p.brief).toEqual([]);
    });

    test('a key with no hub scopes gets an empty overview', async () => {
        const o = jsonOf(await call('flights', 'hub_overview', {}));
        expect(o).toMatchObject({ key: 'flights', domains: [], brief: [] });
    });
});

describe('mcp: portfolio', () => {
    test('list and get read the portfolio files', async () => {
        const list = jsonOf(await call('portfolio-only', 'portfolio', { action: 'list' }));
        expect(list.count).toBeGreaterThan(0);
        const first = list.projects[0];
        const got = await call('portfolio-only', 'portfolio', { action: 'get', id: first.id });
        expect(got.isError).toBeFalsy();
        expect(jsonOf(got)).toMatchObject({ id: first.id, title: first.title });
        const missing = await call('portfolio-only', 'portfolio', { action: 'get', id: 999999 });
        expect(JSON.parse(textOf(missing)).error).toBe('not_found');
    });

    test('a disabled portfolio domain hides the tool', async () => {
        domains.setEnabled(db.get(), 'portfolio', false, 'test');
        expect(await toolNames('portfolio-only')).toEqual(['hub_briefing', 'hub_overview']);
    });
});

describe('mcp: audit', () => {
    test('every tool call writes one mcp_call row without the content', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        const before = mcpRows().length;
        await call('publisher', 'digests', { action: 'publish', kind: 'daily', period: '2026-11-05', body: 'AUDIT-CANARY text', sources: { calendar: 'ok' } });
        await call('reader', 'digests', { action: 'publish', kind: 'daily', period: '2026-11-06', body: 'AUDIT-CANARY two' });
        await call('reader', 'no_such_tool', {});
        await settle();
        const rows = mcpRows().slice(0, mcpRows().length - before).reverse();
        expect(rows.map((r) => r.detail)).toEqual([
            { key: 'publisher', tool: 'digests', action: 'publish', ok: true },
            { key: 'reader', tool: 'digests', action: 'publish', ok: false, error: 'rejected' },
            { key: 'reader', tool: 'no_such_tool', action: null, ok: false, error: 'rejected' },
        ]);
        expect(rows.every((r) => r.actor === r.detail.key)).toBe(true);
        expect(JSON.stringify(rows)).not.toMatch(/AUDIT-CANARY|calendar/);
    });

    test('a failing call is audited with its error code', async () => {
        await call('reader', 'digests', { action: 'get', kind: 'daily', period: '2019-01-01' });
        await settle();
        expect(mcpRows()[0].detail).toEqual({ key: 'reader', tool: 'digests', action: 'get', ok: false, error: 'not_found' });
    });

    test('tools/list is not audited', async () => {
        const before = mcpRows().length;
        await listTools('reader');
        await settle();
        expect(mcpRows().length).toBe(before);
    });
});

describe('mcp: real client over HTTP', () => {
    test('the SDK client lists tools and calls one through /hub/mcp', async () => {
        const server = app.listen(0);
        try {
            const url = new URL(`http://127.0.0.1:${server.address().port}/hub/mcp`);
            const client = new Client({ name: 'test', version: '1' });
            await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${keys.reader}` } } }));
            const names = (await client.listTools()).tools.map((t) => t.name).sort();
            expect(names).toEqual(['digests', 'hub_briefing', 'hub_overview']);
            const result = await client.callTool({ name: 'digests', arguments: { action: 'get', kind: 'daily', period: '2026-11-01' } });
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text.startsWith(DATA_NOTE)).toBe(true);
            await client.close();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});
