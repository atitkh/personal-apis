process.env.HUB_DB_FILE = ':memory:';

// services/lifelog.js. Every observation, episode and place in this file is invented.
const db = require('../db');
const lifelog = require('../services/lifelog');
const settings = require('../services/settings');
const places = require('../services/places');

const conn = () => db.get();
const pusher = { id: 7, name: 'cam-kitchen', scopes: ['lifelog:push'] };
const writerKey = { id: 8, name: 'bridge', scopes: ['lifelog:read', 'lifelog:api-write'] };
const NOW = new Date('2026-11-13T20:00:00Z');
const obs = (extra = {}) => ({ at: '2026-11-13T18:00:00Z', text: 'ate dal bhat at the table', kind: 'eat', ...extra });
const push = (items, key = pusher) => lifelog.push(conn(), key, items, { now: NOW });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const n = (sql) => conn().prepare(sql).get().n;

beforeAll(() => settings.set(conn(), 'timezone', 'America/Chicago'));
afterAll(() => db.close());
const wipe = () => lifelog.forget(conn(), { from: '1970-01-01T00:00:00Z', to: '2199-01-01T00:00:00Z', confirm: true });
beforeEach(wipe);

describe('push', () => {
    test('a batch: good ones stored in order, bad ones rejected by index, duplicates skipped and counted', () => {
        const r = push([
            obs({ dedupe: 'a1' }),
            obs({ text: '' }),
            obs({ dedupe: 'a1', text: 'same again' }),
            obs({ at: 'yesterday' }),
            obs({ text: 'walked\u0007 to the shop\u0000', kind: 'Walk', tags: ['outside', 'outside'], data: { steps: 300 }, confidence: 0.7 }),
            obs({ nope: 1 }),
        ]);
        expect(r).toMatchObject({ accepted: 2, duplicates: 1, sources: ['cam-kitchen'] });
        expect(r.rejected.map((x) => x.index)).toEqual([1, 3, 5]);
        expect(r.rejected.map((x) => x.code)).toEqual(['bad_request', 'bad_time', 'bad_field']);
        const list = lifelog.listObservations(conn(), { order: 'asc' }).observations;
        expect(list[1]).toMatchObject({ text: 'walked to the shop', kind: 'walk', tags: ['outside'], data: { steps: 300 }, confidence: 0.7, source: 'cam-kitchen' });
        // a retry of the whole batch adds nothing
        expect(push([obs({ dedupe: 'a1' })])).toMatchObject({ accepted: 0, duplicates: 1 });
    });

    test('limits: 1..100 items, text 2000, data 2 KB, 10 tags, confidence 0..1, end after start', () => {
        expect(code(() => push([]))).toBe('bad_request');
        expect(code(() => push(Array.from({ length: 101 }, () => obs())))).toBe('too_many');
        const r = push([
            obs({ text: 'x'.repeat(2001) }), obs({ data: { s: 'x'.repeat(2100) } }), obs({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }),
            obs({ confidence: 2 }), obs({ end_at: '2026-11-13T17:00:00Z' }), obs({ at: '2026-11-20T00:00:00Z' }), obs({ data: [1] }),
        ]);
        expect(r.accepted).toBe(0);
        expect(r.rejected).toHaveLength(7);
        for (const x of r.rejected) expect(x.error).not.toMatch(/xxxx/);
    });

    test('a push-only key may push only under its own name; lifelog:api-write may name any source', () => {
        const r = push([obs({ source: 'glasses' }), obs({ source: 'cam-kitchen' })]);
        expect(r.accepted).toBe(1);
        expect(r.rejected[0]).toMatchObject({ index: 0, code: 'bad_source' });
        expect(push([obs({ source: 'glasses' })], writerKey).accepted).toBe(1);
        expect(lifelog.sources(conn()).map((s) => s.label).sort()).toEqual(['cam-kitchen', 'glasses']);
    });

    test('local_date is the hub time zone date, and a place resolves to a places id by label', () => {
        const p = places.create(conn(), { label: 'Kitchen Test', kind: 'home', rules: [{ type: 'zone', value: 'kitchen_zone' }] }, 'test');
        push([obs({ at: '2026-11-14T03:30:00Z', place: 'kitchen test' }), obs({ place: 'kitchen_zone' }), obs({ place: 'somewhere else' })]);
        const [a, c, b] = lifelog.listObservations(conn(), { order: 'desc' }).observations; // same time: newest id first
        expect(a).toMatchObject({ local_date: '2026-11-13', place_id: p.id }); // 21:30 in Chicago
        expect(b.place_id).toBe(p.id);
        expect(c).toMatchObject({ place: 'somewhere else', place_id: null });
    });
});

describe('append-only', () => {
    test('UPDATE and DELETE are refused outside forget; the guard row is gone afterwards', () => {
        const [id] = push([obs()]).ids;
        expect(() => conn().prepare('UPDATE lifelog_observations SET text = ? WHERE id = ?').run('changed', id)).toThrow(/append-only/);
        expect(() => conn().prepare('DELETE FROM lifelog_observations WHERE id = ?').run(id)).toThrow(/append-only/);
        expect(n('SELECT COUNT(*) AS n FROM lifelog_observations')).toBe(1);
        expect(n('SELECT COUNT(*) AS n FROM lifelog_forget_guard')).toBe(0);
    });
});

describe('search, lists and the day', () => {
    test('FTS search, filters and the day summary', () => {
        push([obs({ at: '2026-11-13T15:00:00Z', text: 'drank chiya', kind: 'drink' }), obs(), obs({ source: 'glasses', at: '2026-11-13T19:00:00Z', text: 'saw a red bicycle', kind: 'see' })], writerKey);
        expect(lifelog.listObservations(conn(), { q: 'bicycle' }).observations.map((o) => o.text)).toEqual(['saw a red bicycle']);
        expect(lifelog.listObservations(conn(), { kind: 'drink' }).total).toBe(1);
        expect(lifelog.listObservations(conn(), { from: '2026-11-13T16:00:00Z', to: '2026-11-13T18:30:00Z' }).total).toBe(1);
        expect(lifelog.listObservations(conn(), { from: '2026-11-13', to: '2026-11-13' }).total).toBe(3);
        expect(code(() => lifelog.listObservations(conn(), { q: '!!!' }))).toBe('bad_query');
        lifelog.createEpisode(conn(), { kind: 'eat', title: 'Lunch', start_at: '2026-11-13T18:00:00Z', end_at: '2026-11-13T18:25:00Z' }, 'test', { now: NOW });
        const d = lifelog.day(conn(), '2026-11-13');
        expect(d.episodes).toHaveLength(1);
        expect(d.episodes[0]).toMatchObject({ title: 'Lunch', duration_min: 25 });
        expect(d.observations).toMatchObject({ count: 3, first_at: '2026-11-13T15:00:00.000Z', last_at: '2026-11-13T19:00:00.000Z' });
        expect(d.observations.by_source).toEqual([{ source: 'bridge', count: 2 }, { source: 'glasses', count: 1 }]);
        expect(code(() => lifelog.day(conn(), '2026-02-30'))).toBe('bad_date');
        const s = lifelog.stats(conn());
        expect(s).toMatchObject({ records: 3, observations: 3, episodes: 1, sources: 2 });
        expect(s.approx_bytes).toBeGreaterThan(20);
        expect(JSON.stringify(s)).not.toMatch(/chiya|bicycle|Lunch/);
    });
});

describe('episodes', () => {
    test('create, partial update with unchanged detection, history, restore, link and unlink, FTS', () => {
        const ids = push([obs(), obs({ text: 'second bite' })]).ids;
        const c = lifelog.createEpisode(conn(), { kind: 'eat', title: 'Dinner', start_at: '2026-11-13T18:00:00Z', detail: 'rice and lentils' }, 'test', { now: NOW });
        expect(c).toMatchObject({ status: 'created', rev: 1 });
        expect(lifelog.updateEpisode(conn(), c.id, { title: 'Dinner' }, 'test').status).toBe('unchanged');
        const u = lifelog.updateEpisode(conn(), c.id, { title: 'Late dinner', end_at: '2026-11-13T18:40:00Z' }, 'test');
        expect(u).toMatchObject({ status: 'updated', rev: 2, fields: ['title', 'end_at'] });
        expect(lifelog.listEpisodes(conn(), { q: 'late' }).total).toBe(1);
        expect(lifelog.listEpisodes(conn(), { q: 'lentils' }).total).toBe(1);
        expect(lifelog.getEpisode(conn(), c.id, { rev: 1 }).title).toBe('Dinner');
        expect(lifelog.restoreEpisode(conn(), c.id, 1, 'test')).toMatchObject({ status: 'updated', rev: 3 });
        expect(lifelog.history(conn(), c.id).map((h) => h.source)).toEqual(['restore', 'edit', 'create']);
        expect(lifelog.listEpisodes(conn(), { q: 'late' }).total).toBe(0);
        expect(lifelog.link(conn(), c.id, ids, 'test')).toMatchObject({ status: 'linked', linked: 2 });
        expect(lifelog.link(conn(), c.id, ids, 'test').status).toBe('unchanged');
        expect(code(() => lifelog.link(conn(), c.id, [999999], 'test'))).toBe('no_observation');
        expect(lifelog.getEpisode(conn(), c.id).observations).toHaveLength(2);
        expect(lifelog.unlink(conn(), c.id, [ids[0]], 'test')).toMatchObject({ status: 'unlinked', unlinked: 1 });
        expect(code(() => lifelog.updateEpisode(conn(), c.id, { title: null }, 'test'))).toBe('bad_request');
        expect(code(() => lifelog.getEpisode(conn(), 424242))).toBe('no_episode');
        const audit = JSON.stringify(lifelog.auditDetail(u));
        expect(audit).not.toMatch(/dinner|lentils/i);
    });
});

describe('forget', () => {
    test('needs confirm; removes the range, episodes fully inside, keeps overlapping ones unlinked; FTS follows', () => {
        const ids = push([obs({ at: '2026-11-10T12:00:00Z', text: 'old walk' }), obs({ at: '2026-11-12T12:00:00Z', text: 'kept walk' })]).ids;
        const inside = lifelog.createEpisode(conn(), { title: 'In', start_at: '2026-11-10T11:00:00Z', end_at: '2026-11-10T13:00:00Z' }, 'test', { now: NOW });
        const over = lifelog.createEpisode(conn(), { title: 'Over', start_at: '2026-11-10T11:00:00Z', end_at: '2026-11-12T13:00:00Z' }, 'test', { now: NOW });
        lifelog.link(conn(), inside.id, [ids[0]], 'test');
        lifelog.link(conn(), over.id, ids, 'test');
        const range = { from: '2026-11-10', to: '2026-11-10' };
        expect(lifelog.forgetPreview(conn(), range).counts).toEqual({ observations: 1, episodes: 1, links: 2 });
        expect(code(() => lifelog.forget(conn(), range))).toBe('confirm_required');
        expect(code(() => lifelog.forgetPreview(conn(), { from: '2026-11-10' }))).toBe('bad_range');
        const r = lifelog.forget(conn(), { ...range, confirm: true });
        expect(r).toMatchObject({ status: 'forgotten', counts: { observations: 1, episodes: 1, links: 2 } });
        expect(JSON.stringify(lifelog.forgetAuditDetail(r))).not.toMatch(/walk|In|Over/);
        expect(lifelog.listObservations(conn()).observations.map((o) => o.text)).toEqual(['kept walk']);
        expect(lifelog.listObservations(conn(), { q: 'old' }).total).toBe(0);
        expect(lifelog.getEpisode(conn(), over.id).observation_count).toBe(1);
        expect(code(() => lifelog.getEpisode(conn(), inside.id))).toBe('no_episode');
        expect(n('SELECT COUNT(*) AS n FROM lifelog_forget_guard')).toBe(0);
        // with a source, only that source goes
        push([obs({ source: 'glasses', at: '2026-11-12T12:30:00Z' })], writerKey);
        expect(lifelog.forget(conn(), { from: '2026-11-12', to: '2026-11-12', source: 'glasses', confirm: true }).counts.observations).toBe(1);
        expect(lifelog.listObservations(conn()).total).toBe(1);
    });
});

describe('settings', () => {
    test('lifelog.retention_days is empty by default and takes 1..36500', () => {
        expect(settings.get(conn(), 'lifelog.retention_days')).toBeNull();
        expect(() => settings.set(conn(), 'lifelog.retention_days', 0)).toThrow(/1 to 36500/);
        settings.set(conn(), 'lifelog.retention_days', 365);
        expect(settings.get(conn(), 'lifelog.retention_days')).toBe(365);
        settings.set(conn(), 'lifelog.retention_days', null);
        expect(settings.get(conn(), 'lifelog.retention_days')).toBeNull();
    });
});
