// hub_overview and hub_briefing have scopes of their own (overview:read, briefing:read): an agent without them does not see the
// tool, and GET /hub/briefing answers 403. `*` includes both; a domain wildcard does not. Migration 016 gave existing keys both.
process.env.HUB_DB_FILE = ':memory:';
process.env.ADMIN_KEY = 'g'.repeat(40);

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const keys = {};
beforeAll(() => {
    const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes }).key; };
    make('plain', 'digests:read');
    make('wild', 'digests:*');
    make('overview', 'digests:read, overview:read');
    make('briefing', 'digests:read, briefing:read');
    make('both', 'digests:read, overview:read, briefing:read');
    make('all', '*');
});
afterAll(() => db.close());

const rpc = (key, method, params = {}) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').set('Authorization', `Bearer ${key}`)
    .send({ jsonrpc: '2.0', id: 1, method, params });
const tools = async (name) => (await rpc(keys[name], 'tools/list').expect(200)).body.result.tools.map((t) => t.name).filter((n) => n.startsWith('hub_')).sort();

describe('the general tools follow their own scopes', () => {
    test('tools/list', async () => {
        expect(await tools('plain')).toEqual([]);
        expect(await tools('wild')).toEqual([]); // digests:* is a domain wildcard, not everything
        expect(await tools('overview')).toEqual(['hub_overview']);
        expect(await tools('briefing')).toEqual(['hub_briefing']);
        expect(await tools('both')).toEqual(['hub_briefing', 'hub_overview']);
        expect(await tools('all')).toEqual(['hub_briefing', 'hub_overview']);
    });

    test('calling a tool the key does not have is refused', async () => {
        const res = await rpc(keys.plain, 'tools/call', { name: 'hub_briefing', arguments: {} });
        const text = JSON.stringify(res.body);
        expect(text).toMatch(/error|not found|unknown/i);
        expect(text).not.toMatch(/"attention"/);
    });

    test('GET /hub/briefing needs briefing:read', async () => {
        await request(app).get('/hub/briefing').set('Authorization', `Bearer ${keys.plain}`).expect(403);
        await request(app).get('/hub/briefing').set('Authorization', `Bearer ${keys.overview}`).expect(403);
        await request(app).get('/hub/briefing').set('Authorization', `Bearer ${keys.briefing}`).expect(200);
        await request(app).get('/hub/briefing').set('Authorization', `Bearer ${keys.all}`).expect(200);
        await request(app).get('/hub/briefing').expect(401);
    });
});

describe('the dashboard shows it', () => {
    let agent;
    beforeAll(async () => {
        agent = request.agent(app);
        await agent.post('/admin/api/login').set(H).send({ key: 'g'.repeat(40) }).expect(200);
    });

    test('Agent access lists both tools as general (not matrix columns) and each key\'s own', async () => {
        const data = (await agent.get('/admin/api/agents').expect(200)).body;
        const general = data.tools.filter((t) => t.general).map((t) => [t.tool, t.scope]);
        expect(general).toEqual([['hub_overview', 'overview:read'], ['hub_briefing', 'briefing:read']]);
        const by = Object.fromEntries(data.keys.map((k) => [k.name, k.general.slice().sort()]));
        expect(by.plain).toEqual([]);
        expect(by.overview).toEqual(['hub_overview']);
        expect(by.both).toEqual(['hub_briefing', 'hub_overview']);
        expect(by.all).toEqual(['hub_briefing', 'hub_overview']);
    });

    test('a key can be edited to drop them', async () => {
        const id = apiKeys.list(db.get()).find((k) => k.name === 'both').id;
        await agent.patch(`/admin/api/keys/${id}`).set(H).send({ scopes: ['digests:read'] }).expect(200);
        expect(await tools('both')).toEqual([]);
    });
});

describe('migration 016', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).find((n) => n.startsWith('016_'))), 'utf8');
    const run = (scopesList) => {
        const conn = new Database(':memory:');
        conn.exec('CREATE TABLE api_keys (id INTEGER PRIMARY KEY, scopes TEXT NOT NULL)');
        scopesList.forEach((s, i) => conn.prepare('INSERT INTO api_keys (id, scopes) VALUES (?, ?)').run(i + 1, JSON.stringify(s)));
        conn.exec(sql);
        conn.exec(sql); // running it twice changes nothing more
        const out = conn.prepare('SELECT scopes FROM api_keys ORDER BY id').all().map((r) => JSON.parse(r.scopes));
        conn.close();
        return out;
    };

    test('adds both scopes after the existing ones; leaves * and keys that already have them alone', () => {
        const [a, star, has, one] = run([['digests:read', 'places:read'], ['*'], ['x:read', 'overview:read', 'briefing:read'], ['a:read', 'briefing:read']]);
        expect(a).toEqual(['digests:read', 'places:read', 'overview:read', 'briefing:read']);
        expect(star).toEqual(['*']);
        expect(has).toEqual(['x:read', 'overview:read', 'briefing:read']);
        expect(one).toEqual(['a:read', 'briefing:read', 'overview:read']);
    });

    test('the live database ran it', () => {
        expect(db.get().prepare("SELECT 1 FROM schema_migrations WHERE name LIKE '016_%'").get()).toBeTruthy();
    });
});
