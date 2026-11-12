// Dashboard controls for agent access: the per-domain MCP mode, the Agent access page data and the
// overview counts. Runs against the real app, so the MCP endpoint and the dashboard share one database.
const KEY = 'a'.repeat(40);
process.env.ADMIN_KEY = KEY;

const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const domains = require('../services/domains');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const keys = {};

let agent;
beforeAll(async () => {
    for (const [name, scopes] of [['ag-reader', 'digests:read'], ['ag-editor', 'digests:read, digests:agent-write'], ['ag-none', 'attendance:read']]) {
        keys[name] = apiKeys.create(db.get(), { name, scopes });
    }
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
afterEach(() => {
    for (const name of domains.names()) {
        domains.setEnabled(db.get(), name, true, 'test');
        domains.setMcpMode(db.get(), name, 'read', 'test');
    }
});

const rpc = (key, method, params = {}) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${key}`)
    .send({ jsonrpc: '2.0', id: 1, method, params });
const mcpToolNames = async (name) => (await rpc(keys[name].key, 'tools/list').expect(200)).body.result.tools.map((t) => t.name);
const agentsData = async () => (await agent.get('/admin/api/agents').expect(200)).body;
const keyRow = (data, name) => data.keys.find((k) => k.name === name && !k.revoked);

describe('PUT /admin/api/domains/:name/mcp', () => {
    test('changing the mode persists and is audited with from and to', async () => {
        await agent.put('/admin/api/domains/digests/mcp').set(H).send({ mode: 'write' }).expect(200, { ok: true, mode: 'write' });
        expect(domains.mcpMode(db.get(), 'digests')).toBe('write');
        const row = audit.recent(db.get(), 200).find((e) => e.action === 'domain_mcp_changed');
        expect(row.detail).toEqual({ name: 'digests', from: 'read', to: 'write' });
        const d = (await agent.get('/admin/api/domains').expect(200)).body.domains.find((x) => x.name === 'digests');
        expect(d).toMatchObject({ mcpMode: 'write', mcpTool: true });
    });

    test('an invalid mode is refused and nothing changes', async () => {
        for (const body of [{ mode: 'admin' }, { mode: '' }, {}, { mode: ['write'] }]) {
            await agent.put('/admin/api/domains/digests/mcp').set(H).send(body).expect(400);
        }
        expect(domains.mcpMode(db.get(), 'digests')).toBe('read');
    });

    test('an unknown domain is 404', async () => {
        await agent.put('/admin/api/domains/attendance/mcp').set(H).send({ mode: 'read' }).expect(404);
    });

    test('a domain without an agent tool is 400, and the domain list says it has none', async () => {
        domains.REGISTRY.notes = { title: 'Notes', sensitivity: 'private', storage: 'db', defaultEnabled: true, stats: () => ({}) };
        try {
            await agent.put('/admin/api/domains/notes/mcp').set(H).send({ mode: 'read' }).expect(400);
            const o = (await agent.get('/admin/api/overview').expect(200)).body;
            expect(o.domains.find((x) => x.name === 'notes').mcpTool).toBe(false);
            expect(o.domains.find((x) => x.name === 'digests').mcpTool).toBe(true);
        } finally {
            delete domains.REGISTRY.notes;
        }
    });

    test('needs the X-Requested-With header and a session', async () => {
        await agent.put('/admin/api/domains/digests/mcp').send({ mode: 'off' }).expect(403);
        await request(app).put('/admin/api/domains/digests/mcp').set(H).send({ mode: 'off' }).expect(401);
        expect(domains.mcpMode(db.get(), 'digests')).toBe('read');
    });
});

describe('GET /admin/api/agents', () => {
    test('needs a session', async () => {
        await request(app).get('/admin/api/agents').expect(401);
    });

    test('lists the endpoint and every tool with its actions', async () => {
        const data = await agentsData();
        expect(data.endpoint).toBe('/hub/mcp');
        const digestsTool = data.tools.find((t) => t.tool === 'digests');
        expect(digestsTool.actions.map((a) => a.name)).toEqual(expect.arrayContaining(['recent', 'get', 'search', 'edit']));
        expect(digestsTool.actions.find((a) => a.name === 'edit').write).toBe(true);
        expect(data.tools.map((t) => t.tool)).toEqual(expect.arrayContaining(['hub_overview', 'digests', 'portfolio']));
    });

    test('shows what a read-only key sees, and that a key without scopes sees nothing', async () => {
        const data = await agentsData();
        const reader = keyRow(data, 'ag-reader');
        expect(reader.visibleTools).toEqual([{ tool: 'digests', actions: ['recent', 'get', 'search'] }]);
        expect(reader.canWrite).toBe(false);
        expect(keyRow(data, 'ag-none').visibleTools).toEqual([]);
    });

    test('write mode shows edit for an edit key and marks it', async () => {
        domains.setMcpMode(db.get(), 'digests', 'write', 'test');
        const editor = keyRow(await agentsData(), 'ag-editor');
        expect(editor.visibleTools[0].actions).toContain('edit');
        expect(editor.canWrite).toBe(true);
    });

    test('mode off removes the tool from visibleTools and from the real /hub/mcp tools/list', async () => {
        expect(await mcpToolNames('ag-reader')).toContain('digests');
        await agent.put('/admin/api/domains/digests/mcp').set(H).send({ mode: 'off' }).expect(200);
        expect(keyRow(await agentsData(), 'ag-reader').visibleTools).toEqual([]);
        expect(await mcpToolNames('ag-reader')).not.toContain('digests');
    });

    test('a domain switched off hides its tool too', async () => {
        domains.setEnabled(db.get(), 'digests', false, 'test');
        expect(keyRow(await agentsData(), 'ag-reader').visibleTools).toEqual([]);
    });

    test('calls30d and the recent list come from mcp_call rows; old rows are not counted', async () => {
        const before = keyRow(await agentsData(), 'ag-reader').calls30d;
        await rpc(keys['ag-reader'].key, 'tools/call', { name: 'hub_overview', arguments: {} }).expect(200);
        await rpc(keys['ag-reader'].key, 'tools/call', { name: 'digests', arguments: { action: 'edit', kind: 'daily', period: '2026-01-01', body: 'x' } }).expect(200);
        const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
        db.get().prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
            .run(old, 'ag-reader', 'mcp_call', JSON.stringify({ key: 'ag-reader', tool: 'digests', action: 'get', ok: true }));

        const data = await agentsData();
        const reader = keyRow(data, 'ag-reader');
        expect(reader.calls30d).toBe(before + 2);
        expect(Date.parse(reader.lastCallAt)).toBeGreaterThan(Date.now() - 60 * 1000);
        expect(keyRow(data, 'ag-none').calls30d).toBe(0);
        expect(data.recent.length).toBeLessThanOrEqual(50);
        expect(data.recent.slice(1, 3)).toEqual([
            expect.objectContaining({ key: 'ag-reader', tool: 'digests', action: 'edit', ok: false }),
            expect.objectContaining({ key: 'ag-reader', tool: 'hub_overview', ok: true }),
        ]);

        const o = (await agent.get('/admin/api/overview').expect(200)).body;
        expect(o.agents.calls24h).toBeGreaterThanOrEqual(2);
        expect(o.agents.keysWithTools).toBeGreaterThanOrEqual(2);
    });

    test('never contains a key, its hash or its prefix', async () => {
        const text = JSON.stringify(await agentsData());
        const rows = db.get().prepare('SELECT key_hash, key_prefix FROM api_keys').all();
        for (const k of Object.values(keys)) expect(text).not.toContain(k.key);
        for (const r of rows) {
            expect(text).not.toContain(r.key_hash);
            expect(text).not.toContain(r.key_prefix);
        }
        expect(text).not.toMatch(/hash/i);
    });
});

describe('GET /admin/api/series', () => {
    const stats = require('../services/adminStats');
    const row = (at, detail) => db.get().prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
        .run(at, 'ag-series', 'mcp_call', JSON.stringify(detail));

    test('needs a session', async () => {
        await request(app).get('/admin/api/series').expect(401);
    });

    test('returns 14 local days ending today, oldest first', async () => {
        const body = (await agent.get('/admin/api/series').expect(200)).body;
        expect(body.days).toHaveLength(14);
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: body.tz }).format(new Date());
        expect(body.days[13].day).toBe(today);
        expect(body.days[0].day < body.days[13].day).toBe(true);
        for (const d of body.days) expect(d).toEqual(expect.objectContaining({ calls: expect.any(Number), failed: expect.any(Number), byTool: expect.any(Object) }));
        expect((await agent.get('/admin/api/series?days=500').expect(200)).body.days).toHaveLength(90);
        expect((await agent.get('/admin/api/series?days=nope').expect(200)).body.days).toHaveLength(14);
    });

    test('buckets mcp_call rows by local day and tool, counts failures, ignores old rows', () => {
        const conn = db.get();
        const now = new Date('2030-03-10T18:00:00Z'); // noon in Chicago
        row('2030-03-10T15:00:00Z', { tool: 'digests', action: 'get', ok: true });
        row('2030-03-10T16:00:00Z', { tool: 'digests', action: 'edit', ok: false });
        row('2030-03-10T17:00:00Z', { tool: 'hub_overview', ok: true });
        row('2030-03-10T03:00:00Z', { tool: 'portfolio', ok: true }); // 10 PM on the 9th in Chicago
        row('2030-02-01T12:00:00Z', { tool: 'digests', ok: true }); // outside the window
        const s = stats.series(conn, { days: 3, now, tz: 'America/Chicago' });
        expect(s.days.map((d) => d.day)).toEqual(['2030-03-08', '2030-03-09', '2030-03-10']);
        expect(s.days[2]).toEqual({ day: '2030-03-10', calls: 3, failed: 1, byTool: { digests: 2, hub_overview: 1 } });
        expect(s.days[1]).toEqual({ day: '2030-03-09', calls: 1, failed: 0, byTool: { portfolio: 1 } });
        expect(s.days[0].calls).toBe(0);
        expect(s.lastCallAt).toBe('2030-03-10T17:00:00Z');
        conn.prepare("DELETE FROM audit_log WHERE actor = 'ag-series'").run();
    });
});
