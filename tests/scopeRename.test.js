// Scope names (X:write -> X:api-write, X:edit -> X:agent-write), the old names as aliases, migration 013 and audit rows
// by key id (a renamed key keeps its history).
const KEY = 'b'.repeat(40);
process.env.ADMIN_KEY = KEY;

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const domains = require('../services/domains');
const agents = require('../services/mcp/agents');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
const settle = () => new Promise((r) => setTimeout(r, 25));

afterAll(() => db.close());

describe('old scope names are aliases', () => {
    test('parseScopes normalises old names to new ones, keeps order and drops the duplicate', () => {
        expect(apiKeys.parseScopes('flights:read, flights:write, flights:edit, places:suggest')).toEqual(['flights:read', 'flights:api-write', 'flights:agent-write', 'places:suggest']);
        expect(apiKeys.parseScopes(['flights:write', 'flights:api-write'])).toEqual(['flights:api-write']);
        expect(apiKeys.parseScopes('digests:publish, places:*, flights:observe')).toEqual(['digests:publish', 'places:*', 'flights:observe']);
    });

    test('hasScope answers the same for the old and the new name, and loosens nothing', () => {
        expect(apiKeys.hasScope(['flights:write'], 'flights:api-write')).toBe(true);
        expect(apiKeys.hasScope(['flights:api-write'], 'flights:write')).toBe(true);
        expect(apiKeys.hasScope(['deadlines:edit'], 'deadlines:agent-write')).toBe(true);
        expect(apiKeys.hasScope(['deadlines:agent-write'], 'deadlines:edit')).toBe(true);
        // The two writes stay separate.
        expect(apiKeys.hasScope(['flights:api-write'], 'flights:agent-write')).toBe(false);
        expect(apiKeys.hasScope(['flights:edit'], 'flights:write')).toBe(false);
        expect(apiKeys.hasScope(['flights:read'], 'flights:write')).toBe(false);
    });

    test('a key stored with old names reads back with the new ones and still verifies', () => {
        const k = apiKeys.create(db.get(), { name: 'old-names', scopes: 'flights:read' });
        db.get().prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run(JSON.stringify(['flights:read', 'flights:write', 'deadlines:edit', 'x-odd:thing']), k.id);
        expect(apiKeys.verify(db.get(), k.key).scopes).toEqual(['flights:read', 'flights:api-write', 'deadlines:agent-write', 'x-odd:thing']);
        expect(apiKeys.get(db.get(), k.id).scopes).toContain('deadlines:agent-write');
        expect(apiKeys.list(db.get()).find((r) => r.id === k.id).scopes).toContain('flights:api-write');
    });

    test('new keys and edits store only the new names', () => {
        const k = apiKeys.create(db.get(), { name: 'stores-new', scopes: 'places:read, places:write, places:edit' });
        expect(JSON.parse(db.get().prepare('SELECT scopes FROM api_keys WHERE id = ?').get(k.id).scopes)).toEqual(['places:read', 'places:api-write', 'places:agent-write']);
        apiKeys.update(db.get(), k.id, { scopes: ['places:read', 'places:edit'] });
        expect(JSON.parse(db.get().prepare('SELECT scopes FROM api_keys WHERE id = ?').get(k.id).scopes)).toEqual(['places:read', 'places:agent-write']);
    });

    test('REST: a key stored with the old write name still passes the write route', async () => {
        const k = apiKeys.create(db.get(), { name: 'old-rest', scopes: 'deadlines:read' });
        db.get().prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run(JSON.stringify(['deadlines:read', 'deadlines:write']), k.id);
        const r = await request(app).post('/hub/deadlines').set('Authorization', `Bearer ${k.key}`).send({ title: 'Old name works', due_date: '2031-01-01' });
        expect(r.status).toBe(201);
        const none = apiKeys.create(db.get(), { name: 'read-only-rest', scopes: 'deadlines:read' });
        await request(app).post('/hub/deadlines').set('Authorization', `Bearer ${none.key}`).send({ title: 'No', due_date: '2031-01-01' }).expect(403);
    });

    test('MCP: a key stored with deadlines:edit sees the write actions in write mode, and not in read mode', async () => {
        const k = apiKeys.create(db.get(), { name: 'old-mcp', scopes: 'deadlines:read' });
        db.get().prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run(JSON.stringify(['deadlines:read', 'deadlines:edit']), k.id);
        const actions = () => agents.visibleFor(db.get(), apiKeys.get(db.get(), k.id)).find((t) => t.tool === 'deadlines');
        domains.setMcpMode(db.get(), 'deadlines', 'read', 'test');
        expect(actions().writes).toBe(false);
        domains.setMcpMode(db.get(), 'deadlines', 'write', 'test');
        expect(actions().writes).toBe(true);
        domains.setMcpMode(db.get(), 'deadlines', 'read', 'test');
    });
});

describe('migration 013', () => {
    const upTo = (conn, last) => {
        for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
            if (f < last) conn.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
        }
    };
    const m013 = fs.readFileSync(path.join(MIGRATIONS, fs.readdirSync(MIGRATIONS).find((n) => n.startsWith('013_'))), 'utf8');
    const scopesOf = (conn, name) => JSON.parse(conn.prepare('SELECT scopes FROM api_keys WHERE name = ?').get(name).scopes);

    function seeded() {
        const conn = new Database(':memory:');
        upTo(conn, '013');
        const add = conn.prepare("INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_at, revoked_at) VALUES (?, 'pak_xxxx', ?, ?, '2026-01-01T00:00:00Z', ?)");
        let n = 0;
        const key = (name, scopes, revoked = null) => add.run(name, `hash${n += 1}`, JSON.stringify(scopes), revoked);
        key('openclaw', ['digests:read', 'deadlines:read', 'deadlines:edit', 'places:suggest']);
        key('flights-job', ['flights:read', 'flights:suggest', 'flights:write', 'flights:observe']);
        key('both', ['places:write', 'places:read', 'places:api-write']);
        key('everything', ['*']);
        key('wild', ['flights:*', 'digest:*', 'weird:thing']);
        key('twin', ['digests:read'], '2026-02-01T00:00:00Z');
        key('twin', ['digests:read']);
        return conn;
    }

    test('rewrites old names to new ones, keeps order, merges a scope held twice, leaves the rest alone', () => {
        const conn = seeded();
        conn.exec(m013);
        expect(scopesOf(conn, 'openclaw')).toEqual(['digests:read', 'deadlines:read', 'deadlines:agent-write', 'places:suggest']);
        expect(scopesOf(conn, 'flights-job')).toEqual(['flights:read', 'flights:suggest', 'flights:api-write', 'flights:observe']);
        expect(scopesOf(conn, 'both')).toEqual(['places:api-write', 'places:read']);
        expect(scopesOf(conn, 'everything')).toEqual(['*']);
        expect(scopesOf(conn, 'wild')).toEqual(['flights:*', 'digest:*', 'weird:thing']);
    });

    test('is idempotent', () => {
        const conn = seeded();
        conn.exec(m013);
        const once = conn.prepare('SELECT id, scopes, revoked_at FROM api_keys ORDER BY id').all();
        const auditOnce = conn.prepare('SELECT id, detail FROM audit_log ORDER BY id').all();
        conn.exec(m013);
        expect(conn.prepare('SELECT id, scopes, revoked_at FROM api_keys ORDER BY id').all()).toEqual(once);
        expect(conn.prepare('SELECT id, detail FROM audit_log ORDER BY id').all()).toEqual(auditOnce);
    });

    test('backfills key_id into old audit rows where the name maps to exactly one key; skips ambiguous names, people and rows already carrying one', () => {
        const conn = seeded();
        const id = (name) => conn.prepare('SELECT id FROM api_keys WHERE name = ? ORDER BY id').get(name).id;
        const add = conn.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES ('2026-03-01T00:00:00Z', ?, ?, ?)");
        add.run('openclaw', 'mcp_call', JSON.stringify({ key: 'openclaw', tool: 'deadlines', action: 'list', ok: true }));
        add.run('flights-job', 'flight_candidate_filed', JSON.stringify({ flight: 'AA 1 LIT-DFW' }));
        add.run('flights-job', 'flight_settings_changed', null);
        add.run('twin', 'mcp_call', JSON.stringify({ key: 'twin', tool: 'digests', action: 'get', ok: true }));
        add.run('admin', 'key_created', JSON.stringify({ id: 1, name: 'openclaw' }));
        add.run('openclaw', 'mcp_call', JSON.stringify({ key: 'openclaw', key_id: 999, tool: 'x', ok: true }));
        conn.exec(m013);
        const rows = conn.prepare('SELECT actor, action, detail FROM audit_log ORDER BY id').all().map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
        expect(rows[0].detail).toEqual({ key: 'openclaw', tool: 'deadlines', action: 'list', ok: true, key_id: id('openclaw') });
        expect(rows[1].detail).toEqual({ flight: 'AA 1 LIT-DFW', key_id: id('flights-job') });
        expect(rows[2].detail).toEqual({ key_id: id('flights-job') });
        expect(rows[3].detail.key_id).toBeUndefined(); // two keys named twin
        expect(rows[4].detail).toEqual({ id: 1, name: 'openclaw' }); // a person
        expect(rows[5].detail.key_id).toBe(999); // untouched
    });

    test('the live database ran 013 (new keys, new names)', () => {
        expect(db.get().prepare("SELECT 1 FROM schema_migrations WHERE name LIKE '013_%'").get()).toBeTruthy();
    });
});

describe('audit rows carry the key id', () => {
    const rpcCall = (secret, name, args) => request(app).post('/hub/mcp')
        .set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').set('Authorization', `Bearer ${secret}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const mcpRows = () => audit.recent(db.get(), 300).filter((e) => e.action === 'mcp_call');

    test('recordKey stores the key id in detail and the name as actor', () => {
        audit.recordKey(db.get(), { id: 77, name: 'some-key' }, 'trip_created', { id: 1, title: 'T' }, '127.0.0.1');
        const row = audit.recent(db.get(), 1)[0];
        expect(row).toMatchObject({ actor: 'some-key', action: 'trip_created', detail: { id: 1, title: 'T', key_id: 77 } });
        expect(audit.keyIdOf(row.detail)).toBe(77);
        expect(audit.keyIdOf({})).toBeNull();
        expect(audit.keyIdOf(null)).toBeNull();
    });

    test('a renamed key keeps its history: calls are counted and listed by id, old name or new', async () => {
        const reader = apiKeys.create(db.get(), { name: 'before-rename', scopes: 'digests:read' });
        const other = apiKeys.create(db.get(), { name: 'someone-else', scopes: 'digests:read' });
        await rpcCall(reader.key, 'digests', { action: 'recent' }).expect(200);
        await rpcCall(other.key, 'digests', { action: 'recent' }).expect(200);
        await settle();
        apiKeys.update(db.get(), reader.id, { name: 'after-rename' });
        await rpcCall(reader.key, 'digests', { action: 'recent' }).expect(200);
        await settle();

        const rows = mcpRows().filter((e) => e.detail.key_id === reader.id);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.detail.key).sort()).toEqual(['after-rename', 'before-rename']); // the name is a snapshot

        const mine = agents.summary(db.get()).keys.find((k) => k.id === reader.id);
        expect(mine.calls30d).toBe(2);
        expect(agents.summary(db.get()).keys.find((k) => k.id === other.id).calls30d).toBe(1);
        expect(agents.callsFor(db.get(), apiKeys.get(db.get(), reader.id))).toHaveLength(2);
        // The recent list names the key as it is called now.
        const recent = agents.summary(db.get()).recent.filter((c) => c.key === 'after-rename' || c.key === 'before-rename');
        expect(recent.map((c) => c.key)).toEqual(['after-rename', 'after-rename']);

        // Over HTTP too.
        const agent = request.agent(app);
        await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
        const calls = (await agent.get(`/admin/api/keys/${reader.id}/calls`).expect(200)).body.calls;
        expect(calls).toHaveLength(2);
        const body = (await agent.get('/admin/api/agents').expect(200)).body;
        expect(body.keys.find((k) => k.id === reader.id).calls30d).toBe(2);
        const feed = (await agent.get('/admin/api/activity?type=agents').expect(200)).body.events.filter((e) => e.detail && e.detail.key_id === reader.id);
        expect(feed.map((e) => e.actor)).toEqual(['after-rename', 'after-rename']);
    });

    test('old rows without key_id still match by name, and a key with the same name made later does not take them over by id', () => {
        const old = apiKeys.create(db.get(), { name: 'legacy-name', scopes: 'digests:read' });
        audit.record(db.get(), 'legacy-name', 'mcp_call', { key: 'legacy-name', tool: 'digests', action: 'get', ok: true }, null);
        audit.record(db.get(), 'legacy-name', 'mcp_call', { key: 'legacy-name', tool: 'digests', action: 'get', ok: true }, null);
        audit.recordKey(db.get(), { id: old.id + 1000, name: 'legacy-name' }, 'mcp_call', { key: 'legacy-name', tool: 'digests', action: 'list', ok: true }, null);
        const k = agents.summary(db.get()).keys.find((x) => x.id === old.id);
        expect(k.calls30d).toBe(2); // the two name-only rows; the row with another key's id is not this key's
        expect(agents.callsFor(db.get(), apiKeys.get(db.get(), old.id))).toHaveLength(2);
    });
});

describe('dashboard scope labels', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'public', 'scopes.js'), 'utf8');

    test('the catalogue lists only the new write names, with plain-words labels', () => {
        expect(src).not.toMatch(/scope: '[a-z]+:(write|edit)'/);
        const names = [...src.matchAll(/scope: '([a-z]+:(?:api-write|agent-write))', label: '([^']+)', text: '([^']+)'/g)];
        expect(names.length).toBeGreaterThanOrEqual(10);
        for (const [, scope, label, text] of names) {
            if (scope.endsWith('agent-write')) {
                expect(label).toBe('Agent write');
                expect(text).toMatch(/^Write through the agent tool \(the domain must also be switched to Read and write on the Overview board\)/);
            } else {
                expect(label).toBe('API write');
                expect(text).toMatch(/^Write through the API \(jobs and scripts\)/);
            }
        }
    });
});
