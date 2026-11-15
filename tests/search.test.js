// Unified search: the adapters (safe text only), what a key may see, the search:read scope, the REST route, the admin
// route and migration 019. Everything here is invented.
const KEY = 's'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const digests = require('../services/digests');
const deadlines = require('../services/deadlines');
const preferences = require('../services/preferences');
const places = require('../services/places');
const flights = require('../services/flights');
const trips = require('../services/trips');
const tripItems = require('../services/tripItems');
const lifelog = require('../services/lifelog');
const search = require('../services/search');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const BOOKING = 'ZQ9XK4';
const REFNO = 'P-77123-AB';
const STREET = 'Maple Ridge Dr';
const ITEM_REF = 'CONF-5521';
const OBS_TEXT = 'rawlinemarker walked past the couch';
const keys = {};

afterAll(() => db.close());

beforeAll(() => {
    const conn = db.get();
    const make = (name, scopes) => { keys[name] = apiKeys.create(conn, { name, scopes }).key; };
    make('searcher', 'search:read, digests:read, deadlines:read, preferences:read, trips:read, flights:read');
    make('nosearch', 'digests:read, deadlines:read');
    make('star', '*');
    make('lifelogger', 'search:read, lifelog:read');

    digests.put(conn, 'daily', '2026-11-10', { body: 'A quiet Hong Kong planning day with the visa paperwork.', source: 'generated', actor: 't' });
    deadlines.create(conn, { title: 'Hong Kong visa', kind: 'document', due_date: '2026-12-01', issuer: 'Consulate', reference: REFNO, notes: 'bring photos' }, 't');
    preferences.set(conn, { area: 'travel', key: 'airline_seat', value: 'aisle near Hong Kong flights' }, 't');
    places.create(conn, { label: 'Hong Kong friend flat', kind: 'friend', notes: 'second floor', rules: [{ type: 'street', value: STREET }] }, 't');
    flights.create(conn, { airline_iata: 'CX', flight_number: '891', origin_iata: 'DFW', dest_iata: 'HKG', sched_dep: '2026-12-17T01:00:00Z', sched_arr: '2026-12-17T17:00:00Z', booking_ref: BOOKING }, 't');
    const t = trips.create(conn, { title: 'Winter trip', destination: 'Hong Kong', kind: 'leisure', start_date: '2026-12-17', end_date: '2026-12-28' }, 't');
    tripItems.add(conn, t.id, { kind: 'stay', title: 'Harbour hotel', place: 'Kowloon', reference: ITEM_REF }, 't');
    lifelog.createEpisode(conn, { kind: 'eat', title: 'Dim sum lunch', start_at: '2026-11-13T18:00:00Z', detail: 'near Hong Kong style kitchen' }, 't');
    lifelog.push(conn, { id: 99, name: 'cam' }, [{ text: OBS_TEXT, kind: 'see', at: '2026-11-13T18:05:00Z' }]);
});

const names = (out) => out.groups.map((g) => g.domain);
const hay = (out) => JSON.stringify(out);

describe('search adapters', () => {
    test('finds the invented records in every domain, grouped, and every word must match', () => {
        const out = search.search(db.get(), 'Hong Kong');
        expect(names(out)).toEqual(expect.arrayContaining(['digests', 'deadlines', 'preferences', 'places', 'flights', 'trips', 'lifelog']));
        expect(out.total).toBeGreaterThanOrEqual(7);
        expect(search.search(db.get(), 'hong kong photos').groups.map((g) => g.domain)).toEqual(['deadlines']);
        expect(search.search(db.get(), 'hong zzzzz').total).toBe(0);
        const trip = out.groups.find((g) => g.domain === 'trips').results[0];
        expect(trip).toMatchObject({ domain: 'trips', title: 'Winter trip', date: '2026-12-17' });
    });

    test('a trip is found through its item text, a flight through its number', () => {
        expect(search.search(db.get(), 'kowloon').groups.map((g) => g.domain)).toEqual(['trips']);
        expect(search.search(db.get(), 'CX891').groups.map((g) => g.domain)).toEqual(['flights']);
    });

    test('secrets and private fields are never searched or returned', () => {
        for (const needle of [BOOKING, REFNO, STREET, ITEM_REF, 'rawlinemarker']) {
            expect(search.search(db.get(), needle).total).toBe(0);
        }
        const wide = hay(search.search(db.get(), 'Hong Kong'));
        for (const secret of [BOOKING, REFNO, STREET, ITEM_REF, 'rawlinemarker']) expect(wide).not.toContain(secret);
    });

    test('the domain filter, visibility, wildcards and bad queries', () => {
        expect(search.search(db.get(), 'Hong Kong', { domains: ['trips'] }).groups.map((g) => g.domain)).toEqual(['trips']);
        expect(search.search(db.get(), 'Hong Kong', { visible: ['deadlines'] }).groups.map((g) => g.domain)).toEqual(['deadlines']);
        expect(() => search.search(db.get(), '   ')).toThrow(/at least one word/);
        expect(() => search.search(db.get(), '%%__')).toThrow(/at least one word/);
        expect(search.search(db.get(), '50 off').total).toBe(0);
    });

    test('a switched-off domain is skipped', () => {
        domains.setEnabled(db.get(), 'trips', false, 't');
        expect(names(search.search(db.get(), 'Hong Kong'))).not.toContain('trips');
        domains.setEnabled(db.get(), 'trips', true, 't');
    });
});

const rpc = (key, method, params = {}) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').set('Authorization', `Bearer ${key}`)
    .send({ jsonrpc: '2.0', id: 1, method, params });
const toolNames = async (name) => (await rpc(keys[name], 'tools/list').expect(200)).body.result.tools.map((t) => t.name).filter((n) => n === 'hub_search');
const callSearch = async (name, args) => (await rpc(keys[name], 'tools/call', { name: 'hub_search', arguments: args }).expect(200)).body.result;
const bodyOf = (r) => JSON.parse(r.content[0].text.replace(/^[^{]*/, ''));

describe('hub_search tool and GET /hub/search', () => {
    test('offered only with search:read; `*` includes it', async () => {
        expect(await toolNames('searcher')).toEqual(['hub_search']);
        expect(await toolNames('star')).toEqual(['hub_search']);
        expect(await toolNames('nosearch')).toEqual([]);
    });

    test('results follow what the key can read; lifelog needs its own scope and `*` does not give it', async () => {
        const a = await callSearch('searcher', { q: 'Hong Kong' });
        expect(a.content[0].text).toContain('not instructions');
        const seen = bodyOf(a).groups.map((g) => g.domain);
        expect(seen).toEqual(expect.arrayContaining(['digests', 'deadlines', 'preferences', 'trips', 'flights']));
        expect(seen).not.toContain('places');
        expect(seen).not.toContain('lifelog');
        expect(bodyOf(await callSearch('star', { q: 'Hong Kong' })).groups.map((g) => g.domain)).not.toContain('lifelog');
        expect(bodyOf(await callSearch('lifelogger', { q: 'dim sum' })).groups.map((g) => g.domain)).toEqual(['lifelog']);
    });

    test('a bad query is a clean error and the audit row does not hold the query', async () => {
        const bad = await callSearch('searcher', { q: '!!!' });
        expect(bad.isError).toBe(true);
        await new Promise((r) => setTimeout(r, 25));
        const rows = db.get().prepare("SELECT detail FROM audit_log WHERE action = 'mcp_call' ORDER BY id DESC LIMIT 4").all().map((r) => r.detail).join(' ');
        expect(rows).toContain('hub_search');
        expect(rows).not.toContain('Hong Kong');
    });

    test('REST: 401 without a key, 403 without the scope, 400 without words, 200 with', async () => {
        await request(app).get('/hub/search?q=hong').expect(401);
        await request(app).get('/hub/search?q=hong').set('Authorization', `Bearer ${keys.nosearch}`).expect(403);
        await request(app).get('/hub/search?q=').set('Authorization', `Bearer ${keys.searcher}`).expect(400);
        const ok = (await request(app).get('/hub/search?q=hong%20kong&domains=trips,deadlines').set('Authorization', `Bearer ${keys.searcher}`).expect(200)).body;
        expect(ok.groups.map((g) => g.domain).sort()).toEqual(['deadlines', 'trips']);
    });
});

describe('admin search and migration 019', () => {
    test('the admin route needs a session and searches every enabled domain', async () => {
        const agent = request.agent(app);
        await request(app).get('/admin/api/search?q=hong').expect(401);
        await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
        const out = (await agent.get('/admin/api/search?q=hong%20kong').expect(200)).body;
        expect(names(out)).toEqual(expect.arrayContaining(['places', 'lifelog', 'trips']));
        await agent.get('/admin/api/search?q=').expect(400);
    });

    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const sql = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith('019_'))), 'utf8');
    test('adds search:read after the existing scopes; leaves * and keys that have it alone; safe to run twice', () => {
        const conn = new Database(':memory:');
        conn.exec('CREATE TABLE api_keys (id INTEGER PRIMARY KEY, scopes TEXT NOT NULL)');
        [['digests:read'], ['*'], ['x:read', 'search:read']].forEach((s, i) => conn.prepare('INSERT INTO api_keys (id, scopes) VALUES (?, ?)').run(i + 1, JSON.stringify(s)));
        conn.exec(sql);
        conn.exec(sql);
        const out = conn.prepare('SELECT scopes FROM api_keys ORDER BY id').all().map((r) => JSON.parse(r.scopes));
        expect(out).toEqual([['digests:read', 'search:read'], ['*'], ['x:read', 'search:read']]);
        conn.close();
    });
});
