// Semantic search: settings (the key is write-only), indexing against a fake OpenAI-compatible endpoint, change and
// removal handling, hybrid ranking, fallback to keywords, the admin API and what is never embedded. Invented data.
const KEY = 'm'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const preferences = require('../services/preferences');
const deadlines = require('../services/deadlines');
const lifelog = require('../services/lifelog');
const embeddings = require('../services/embeddings');
const search = require('../services/search');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const SECRET_KEY = 'sk-embed-secret-123';
const REFNO = 'P-99887-ZZ';

// A fake endpoint: a bag-of-words vector (64 buckets) so texts that share words are close.
const calls = [];
let down = false;
const bucket = (w) => [...w].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 64;
const vec = (text) => { const v = new Array(64).fill(0); (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).forEach((w) => { v[bucket(w)] += 1; }); return v; };
const fakeFetch = async (url, opts) => {
    if (down) throw new Error('connect ECONNREFUSED');
    const body = JSON.parse(opts.body);
    calls.push({ url, auth: opts.headers.Authorization, inputs: body.input.length, model: body.model });
    return { status: 200, json: async () => ({ data: body.input.map((t, index) => ({ index, embedding: vec(t) })) }) };
};

let agent;
beforeAll(async () => {
    globalThis.fetch = fakeFetch;
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const conn = () => db.get();
const setup = () => embeddings.saveConfig(conn(), { base_url: 'http://10.0.0.5:11434/v1', model: 'toy-embed', api_key: SECRET_KEY, enabled: true });

describe('embedding settings', () => {
    test('validation, and the key and address path never come back', () => {
        expect(() => embeddings.saveConfig(conn(), { enabled: true })).toThrow(/address and the model/);
        expect(() => embeddings.saveConfig(conn(), { base_url: 'ftp://x' })).toThrow(/http/);
        expect(() => embeddings.saveConfig(conn(), { base_url: 'http://u:p@x/v1' })).toThrow(/key field/);
        expect(() => embeddings.saveConfig(conn(), { nope: 1 })).toThrow(/Unknown setting/);
        setup();
        const pub = embeddings.publicConfig(conn());
        expect(pub).toMatchObject({ enabled: true, model: 'toy-embed', has_api_key: true, include_lifelog: false });
        expect(JSON.stringify(pub)).not.toContain(SECRET_KEY);
    });
});

describe('indexing and querying', () => {
    beforeAll(() => {
        setup();
        preferences.set(conn(), { area: 'travel', key: 'airline_seat', value: 'aisle window never middle' }, 't');
        preferences.set(conn(), { area: 'food', key: 'spice', value: 'mild curry only' }, 't');
        deadlines.create(conn(), { title: 'Renew passport', kind: 'document', due_date: '2027-01-01', reference: REFNO, notes: 'photos needed' }, 't');
        lifelog.createEpisode(conn(), { kind: 'eat', title: 'Secret supper', start_at: '2026-11-13T18:00:00Z', detail: 'private meal' }, 't');
    });

    test('a pass embeds what is new, sends the key, skips unchanged records and never embeds lifelog or references', async () => {
        const first = await embeddings.tick(conn());
        expect(first.error).toBeUndefined();
        expect(first.embedded).toBeGreaterThanOrEqual(3);
        expect(calls[0]).toMatchObject({ url: 'http://10.0.0.5:11434/v1/embeddings', auth: `Bearer ${SECRET_KEY}`, model: 'toy-embed' });
        const stored = conn().prepare('SELECT domain, title, snippet FROM embeddings').all();
        expect(stored.map((r) => r.domain)).not.toContain('lifelog');
        expect(JSON.stringify(stored)).not.toContain(REFNO);
        const before = calls.length;
        const second = await embeddings.tick(conn());
        expect(second.embedded).toBe(0);
        expect(calls.length).toBe(before);
    });

    test('a changed record is re-embedded, a removed one dropped, a new model rebuilds everything', async () => {
        const pref = preferences.list(conn(), { q: 'spice' }).preferences ? preferences.list(conn(), { q: 'spice' }).preferences[0] : preferences.list(conn(), { q: 'spice' })[0];
        preferences.update(conn(), pref.id, { value: 'very hot chili' }, 't');
        expect((await embeddings.tick(conn())).embedded).toBe(1);
        preferences.unset(conn(), pref.id, 't');
        await embeddings.tick(conn());
        expect(conn().prepare("SELECT COUNT(*) AS n FROM embeddings WHERE domain = 'preferences'").get().n).toBe(1);
        embeddings.saveConfig(conn(), { model: 'toy-embed-2' });
        const r = await embeddings.tick(conn());
        expect(r.embedded).toBeGreaterThanOrEqual(2);
        expect(conn().prepare("SELECT DISTINCT model FROM embeddings").all().map((x) => x.model)).toEqual(['toy-embed-2']);
    });

    test('hybrid search finds a record by meaning that keywords miss, and labels the match', async () => {
        const kw = search.search(conn(), 'seat preference aisle');
        expect(kw.total).toBe(0); // "preference" is not in the record text
        const out = await search.searchHybrid(conn(), 'seat preference aisle');
        expect(out.semantic).toBe(true);
        const pref = out.groups.find((g) => g.domain === 'preferences');
        expect(pref.results[0]).toMatchObject({ title: 'travel: airline_seat', match: 'semantic' });
        const both = await search.searchHybrid(conn(), 'aisle window');
        expect(both.groups.find((g) => g.domain === 'preferences').results[0].match).toBe('both');
        expect((await search.searchHybrid(conn(), 'aisle window', { mode: 'keyword' })).semantic).toBe(false);
    });

    test('an unreachable endpoint falls back to keywords with a short reason, and the key is not in it', async () => {
        down = true;
        const out = await search.searchHybrid(conn(), 'aisle window');
        down = false;
        expect(out.semantic).toBe(false);
        expect(out.semantic_error).toMatch(/could not be reached/);
        expect(JSON.stringify(out)).not.toContain(SECRET_KEY);
        expect(out.total).toBeGreaterThan(0);
    });

    test('lifelog episodes are embedded only when asked for and the key can read them', async () => {
        embeddings.saveConfig(conn(), { include_lifelog: true });
        await embeddings.tick(conn());
        expect(conn().prepare("SELECT COUNT(*) AS n FROM embeddings WHERE domain = 'lifelog'").get().n).toBe(1);
        const out = await search.searchHybrid(conn(), 'private meal supper', { visible: ['preferences'] });
        expect(out.groups.map((g) => g.domain)).not.toContain('lifelog');
        embeddings.saveConfig(conn(), { include_lifelog: false });
        await embeddings.tick(conn());
        expect(conn().prepare("SELECT COUNT(*) AS n FROM embeddings WHERE domain = 'lifelog'").get().n).toBe(0);
    });
});

describe('admin API', () => {
    test('needs a session; settings, test and reindex work; the key never appears in responses or audit rows', async () => {
        await request(app).get('/admin/api/search/settings').expect(401);
        const put = await agent.put('/admin/api/search/settings').set(H).send({ model: 'toy-embed', api_key: SECRET_KEY, base_url: 'http://10.0.0.5:11434/v1', enabled: true }).expect(200);
        expect(JSON.stringify(put.body)).not.toContain(SECRET_KEY);
        expect(put.body.settings).toMatchObject({ enabled: true, has_api_key: true });
        await agent.put('/admin/api/search/settings').set(H).send({ base_url: 'nope' }).expect(400);
        const t = (await agent.post('/admin/api/search/test').set(H).send({}).expect(200)).body;
        expect(t).toMatchObject({ ok: true, dim: 64 });
        down = true;
        const bad = await agent.post('/admin/api/search/test').set(H).send({}).expect(502);
        down = false;
        expect(bad.body.error).toMatch(/could not be reached/);
        const re = (await agent.post('/admin/api/search/reindex').set(H).send({}).expect(200)).body;
        expect(re.dropped).toBeGreaterThanOrEqual(0);
        const rows = conn().prepare("SELECT detail FROM audit_log WHERE action LIKE 'search_%'").all().map((r) => r.detail).join(' ');
        expect(rows).toContain('search_settings_changed'.length ? 'fields' : '');
        expect(rows).not.toContain(SECRET_KEY);
        expect(rows).not.toContain('10.0.0.5');
        const found = (await agent.get('/admin/api/search?q=aisle').expect(200)).body;
        expect(found.total).toBeGreaterThan(0);
    });
});
