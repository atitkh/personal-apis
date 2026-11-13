process.env.HUB_DB_FILE = ':memory:';

// The lifelog agent tool. Every observation, episode and source in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const domains = require('../services/domains');
const lifelog = require('../services/lifelog');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes: `${scopes}, overview:read, briefing:read` }).key; };
const CANARY = 'canary-obs-zebrafinch';
const LONG = `${'camera saw a long caption '.repeat(20)}end`;
const READS = ['day', 'episodes', 'observations', 'search', 'sources'];
const WRITES = ['add_episode', 'add_observation', 'edit_episode', 'link', 'unlink'];
const ALL = [...READS, ...WRITES].sort();
let epId;
let obsIds;

beforeAll(() => {
    make('reader', 'lifelog:read');
    make('editor', 'lifelog:read, lifelog:agent-write');
    make('pusher', 'lifelog:push');
    make('star', '*');
    make('all', 'lifelog:*');
    const conn = db.get();
    obsIds = lifelog.push(conn, null, [
        { source: 'cam-a', at: '2026-11-10T15:00:00Z', kind: 'meal', text: `ate momo ${CANARY}` },
        { source: 'cam-a', at: '2026-11-10T16:00:00Z', kind: 'sit', text: LONG },
        { source: 'glasses', at: '2026-11-10T18:30:00Z', kind: 'walk', text: 'walked along the lake' },
    ], { anySource: true }).ids;
    epId = lifelog.createEpisode(conn, { kind: 'meal', title: 'Lunch momo', start_at: '2026-11-10T15:00:00Z', detail: LONG }, 'seed').id;
});
afterAll(() => db.close());
afterEach(() => {
    domains.setEnabled(db.get(), 'lifelog', true, 'test');
    domains.setMcpMode(db.get(), 'lifelog', 'read', 'test');
});

const rpc = (key, method, params = {}, id = 1) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`)
    .send({ jsonrpc: '2.0', id, method, params });
const tool = async (key) => (await rpc(key, 'tools/list').expect(200)).body.result.tools.find((t) => t.name === 'lifelog');
const actionsOf = async (key) => {
    const t = await tool(key);
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'lifelog', arguments: args }).expect(200)).body.result;
const textOf = (r) => r.content[0].text;
const jsonOf = (r) => JSON.parse(textOf(r).replace(`${DATA_NOTE}\n`, ''));
const errorOf = (r) => {
    if (!r.isError) return 'no error';
    try { return JSON.parse(textOf(r)).error; } catch (err) { return 'refused'; }
};

describe('visibility', () => {
    test('read mode: read actions for read keys; nothing for push-only or "*" keys', async () => {
        expect(await actionsOf('reader')).toEqual(READS);
        expect(await actionsOf('editor')).toEqual(READS);
        expect(await actionsOf('all')).toEqual(READS);
        expect(await actionsOf('pusher')).toBeNull();
        expect(await actionsOf('star')).toBeNull();
    });

    test('write mode adds the write actions only with agent-write; no delete, forget or restore', async () => {
        domains.setMcpMode(db.get(), 'lifelog', 'write', 'test');
        expect(await actionsOf('reader')).toEqual(READS);
        expect(await actionsOf('editor')).toEqual(ALL);
        expect(await actionsOf('all')).toEqual(ALL);
        expect(await actionsOf('star')).toBeNull();
        expect(ALL.filter((a) => /delete|remove|forget|restore|push/.test(a))).toEqual([]);
    });

    test('mode off or domain off hides the tool', async () => {
        domains.setMcpMode(db.get(), 'lifelog', 'off', 'test');
        expect(await actionsOf('all')).toBeNull();
        domains.setMcpMode(db.get(), 'lifelog', 'read', 'test');
        domains.setEnabled(db.get(), 'lifelog', false, 'test');
        expect(await actionsOf('all')).toBeNull();
    });
});

describe('reads', () => {
    test('day: episodes and counts, no raw lines, with the preamble', async () => {
        const r = await call('reader', { action: 'day', date: '2026-11-10' });
        expect(textOf(r).startsWith(DATA_NOTE)).toBe(true);
        expect(textOf(r)).not.toContain(CANARY);
        const d = jsonOf(r);
        expect(d.observations.count).toBe(3);
        expect(d.observations.by_source).toEqual([{ source: 'cam-a', count: 2 }, { source: 'glasses', count: 1 }]);
        expect(d.episodes[0]).toMatchObject({ id: epId, title: 'Lunch momo', detailTruncated: true });
        expect(d.episodes[0].detail.length).toBeLessThan(400);
    });

    test('observations: newest first, filtered, clipped with a flag; no data or dedupe', async () => {
        const all = jsonOf(await call('reader', { action: 'observations' }));
        expect(all.observations.map((o) => o.source)).toEqual(['glasses', 'cam-a', 'cam-a']);
        const long = all.observations.find((o) => o.kind === 'sit');
        expect(long.textTruncated).toBe(true);
        expect(long.text.length).toBeLessThan(400);
        expect(long).not.toHaveProperty('data');
        const cam = jsonOf(await call('reader', { action: 'observations', source: 'cam-a', kind: 'meal', limit: 5 }));
        expect(cam.observations).toHaveLength(1);
        expect(cam.observations[0].textTruncated).toBeUndefined();
    });

    test('episodes, search and sources', async () => {
        const eps = jsonOf(await call('reader', { action: 'episodes', kind: 'meal', from: '2026-11-10', to: '2026-11-10' }));
        expect(eps.episodes.map((e) => e.id)).toEqual([epId]);
        const s = jsonOf(await call('reader', { action: 'search', q: 'momo' }));
        expect(s.results.map((x) => x.type).sort()).toEqual(['episode', 'observation']);
        expect(errorOf(await call('reader', { action: 'search' }))).toBe('bad_request');
        const src = jsonOf(await call('reader', { action: 'sources' }));
        expect(src.sources.map((x) => [x.label, x.count])).toEqual([['glasses', 1], ['cam-a', 2]]);
    });
});

describe('writes', () => {
    test('read mode or a read key: no writes', async () => {
        expect(errorOf(await call('editor', { action: 'add_observation', text: 'ate rice' }))).not.toBe('no error');
        domains.setMcpMode(db.get(), 'lifelog', 'write', 'test');
        expect(errorOf(await call('reader', { action: 'add_observation', text: 'ate rice' }))).not.toBe('no error');
    });

    test('add_observation always uses the key name as source', async () => {
        domains.setMcpMode(db.get(), 'lifelog', 'write', 'test');
        const r = jsonOf(await call('editor', { action: 'add_observation', text: 'ate biryani', kind: 'meal', source: 'cam-a' }));
        expect(r).toMatchObject({ status: 'created', source: 'editor' });
        const row = db.get().prepare('SELECT source, key_id FROM lifelog_observations WHERE id = ?').get(r.id);
        expect(row.source).toBe('editor');
        expect(row.key_id).not.toBeNull();
    });

    test('add_episode, edit_episode, link and unlink', async () => {
        domains.setMcpMode(db.get(), 'lifelog', 'write', 'test');
        const made = jsonOf(await call('editor', { action: 'add_episode', kind: 'walk', title: 'Lake walk', start_at: '2026-11-10T18:30:00Z', source: 'derived' }));
        expect(made.status).toBe('created');
        expect(errorOf(await call('editor', { action: 'add_episode', title: 'x', start_at: '2026-11-10T18:30:00Z', source: 'cam-a' }))).toBe('bad_request');
        const ed = jsonOf(await call('editor', { action: 'edit_episode', id: made.id, status: 'cancelled', end_at: '2026-11-10T19:00:00Z' }));
        expect(ed).toMatchObject({ status: 'updated', rev: 2 });
        expect(lifelog.getEpisode(db.get(), made.id)).toMatchObject({ source: 'derived', status: 'cancelled', updated_by: 'editor' });
        expect(jsonOf(await call('editor', { action: 'link', episode_id: made.id, observation_ids: [obsIds[2]] })).linked).toBe(1);
        expect(errorOf(await call('editor', { action: 'link', episode_id: made.id, observation_ids: [99999] }))).toBe('no_observation');
        expect(jsonOf(await call('editor', { action: 'unlink', episode_id: made.id, observation_ids: [obsIds[2]] })).unlinked).toBe(1);
        expect(errorOf(await call('editor', { action: 'edit_episode', id: 99999, title: 'x' }))).toBe('no_episode');
    });
});

test('mcp_call audit rows hold no content', async () => {
    await call('reader', { action: 'observations', q: 'momo' });
    const rows = audit.recent(db.get(), 300).filter((e) => e.action === 'mcp_call');
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    for (const s of [CANARY, 'momo', 'biryani', 'Lake walk', 'camera saw']) expect(text).not.toContain(s);
});
