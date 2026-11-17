// The Stats page aggregates (services/stats.js) and its admin endpoint. Every record in this file is invented.
const KEY = 's'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const domains = require('../services/domains');
const stats = require('../services/stats');
const lifelog = require('../services/lifelog');
const deadlines = require('../services/deadlines');
const digests = require('../services/digests');
const entities = require('../services/entities');
const notes = require('../services/notes');
const links = require('../services/links');
const trips = require('../services/trips');
const { hubTz, todayIn } = require('../services/lib/tz');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const conn = () => db.get();
const AMOUNT = 4321; // cents: must only ever show up in sections.deadlines.cost
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let today;

beforeAll(() => {
    const c = conn();
    today = todayIn(hubTz(c));
    const noonUtc = (d) => `${d}T17:00:00Z`;
    lifelog.createEpisode(c, { kind: 'meal', title: 'Lunch', start_at: noonUtc(today), end_at: `${today}T17:45:00Z`, place: 'Cafe A' }, 't');
    lifelog.createEpisode(c, { kind: 'walk', title: 'Walk', start_at: noonUtc(addDays(today, -3)), end_at: `${addDays(today, -3)}T18:00:00Z`, place: 'Park B' }, 't');
    lifelog.createEpisode(c, { kind: 'meal', title: 'Old dinner', start_at: noonUtc(addDays(today, -200)), place: 'Cafe A' }, 't');
    lifelog.addObservation(c, { text: 'saw a cafe', at: noonUtc(today) }, { source: 'dashboard' });

    deadlines.create(c, { title: 'Streaming', kind: 'subscription', due_date: today, repeat_kind: 'monthly', amount_cents: AMOUNT, currency: 'USD', cycle: 'monthly' }, 't');
    deadlines.create(c, { title: 'Gym', kind: 'membership', due_date: addDays(today, 40), repeat_kind: 'yearly', amount_cents: 10000, currency: 'EUR', cycle: 'yearly' }, 't');
    deadlines.create(c, { title: 'Passport', kind: 'document', due_date: addDays(today, 2) }, 't');

    digests.put(c, 'daily', addDays(today, -1), { body: 'A quiet day of invented things.', actor: 't' });
    digests.put(c, 'daily', addDays(today, -5), { body: 'Another invented day.', actor: 't' });

    const a = entities.create(c, { kind: 'person', name: 'Test Person' }, 't').id;
    const b = entities.create(c, { kind: 'project', name: 'Test Project' }, 't').id;
    const n = notes.create(c, { title: 'Test note', body: 'hello' }, 't').id;
    links.add(c, { from: { domain: 'entities', id: String(a) }, to: { domain: 'entities', id: String(b) }, rel: 'about' }, 't');
    links.add(c, { from: { domain: 'notes', id: String(n) }, to: { domain: 'entities', id: String(a) }, rel: 'about' }, 't');

    trips.create(c, { title: 'Conf', kind: 'conference', start_date: '2025-05-01', end_date: '2025-05-05' }, 't');
    trips.create(c, { title: 'Home', kind: 'family', start_date: '2026-01-10', end_date: '2026-01-12' }, 't');

    c.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
        .run(new Date().toISOString(), 'st-agent', 'mcp_call', JSON.stringify({ key: 'st-agent', tool: 'notes', action: 'list', ok: true }));
});
afterAll(() => db.close());
afterEach(() => { for (const d of ['lifelog', 'deadlines', 'digests', 'entities', 'links', 'notes', 'trips', 'flights']) domains.setEnabled(conn(), d, true, 'test'); });

describe('stats service', () => {
    test('range handling: default 90, day buckets; 365 weeks; all months; bad range throws', () => {
        expect(stats.cleanRange(undefined)).toBe('90');
        expect(stats.cleanRange('7')).toBeNull();
        const r90 = stats.collect(conn());
        expect(r90.range).toBe('90');
        expect(r90.bucket).toBe('day');
        expect(r90.to).toBe(today);
        expect(r90.from).toBe(addDays(today, -89));
        expect(r90.sections.lifelog.episodes_by_kind.labels).toHaveLength(90);
        const r30 = stats.collect(conn(), { range: '30' });
        expect(r30.sections.digests.days).toHaveLength(30);
        expect(stats.collect(conn(), { range: '365' }).bucket).toBe('week');
        const all = stats.collect(conn(), { range: 'all' });
        expect(all.bucket).toBe('month');
        expect(all.from <= addDays(today, -200)).toBe(true);
        expect(() => stats.collect(conn(), { range: 'nope' })).toThrow(/range/);
    });

    test('lifelog: stacked kinds, kinds, places, heatmap shape', () => {
        const l = stats.collect(conn(), { range: '30' }).sections.lifelog;
        expect(l.episodes).toBe(2);
        const names = l.episodes_by_kind.series.map((s) => s.name).sort();
        expect(names).toEqual(['meal', 'walk']);
        for (const s of l.episodes_by_kind.series) expect(s.values).toHaveLength(30);
        expect(l.kinds.find((k) => k.kind === 'meal').minutes).toBe(45);
        expect(l.top_places.map((p) => p.place)).toEqual(['Park B', 'Cafe A']);
        expect(l.heatmap.values).toHaveLength(7);
        expect(l.heatmap.values.every((r) => r.length === 24)).toBe(true);
        expect(l.heatmap.values.flat().reduce((a, b) => a + b, 0)).toBe(2);
        expect(l.observations).toBe(1);
        // A year sees the old dinner too.
        expect(stats.collect(conn(), { range: '365' }).sections.lifelog.episodes).toBe(3);
    });

    test('deadlines: windows, kinds and a 12-month cost projection per currency', () => {
        const d = stats.collect(conn()).sections.deadlines;
        expect(d.active).toBe(3);
        expect(d.by_window.urgent).toBeGreaterThanOrEqual(2);
        expect(d.cost.months).toHaveLength(12);
        expect(d.cost.currencies).toEqual(['EUR', 'USD']);
        expect(d.cost.total_cents.USD).toBe(AMOUNT * 12);
        expect(d.cost.total_cents.EUR).toBe(10000);
        expect(d.cost.items).toBe(2);
    });

    test('cost dates: overdue repeats roll forward, a past one-off is left out', () => {
        const row = { due_date: '2026-01-31', cycle: 'monthly', repeat_kind: 'monthly' };
        expect(stats.chargeDates(row, '2026-11-01', '2027-01-01')).toEqual(['2026-11-30', '2026-12-31']);
        expect(stats.chargeDates({ due_date: '2026-01-01', cycle: null, repeat_kind: 'none' }, '2026-11-01', '2027-11-01')).toEqual([]);
        expect(stats.chargeDates({ due_date: '2026-11-02', cycle: 'weekly', repeat_kind: 'none' }, '2026-11-01', '2026-11-20')).toHaveLength(3);
    });

    test('digests, graph, trips, agents, totals, search', () => {
        const s = stats.collect(conn(), { range: '30' }).sections;
        expect(s.digests.present).toBe(2);
        expect(s.digests.days.filter((x) => x.chars).length).toBe(2);
        expect(s.digests.days.find((x) => x.day === addDays(today, -2)).chars).toBeNull();
        expect(s.graph.entities_by_kind.map((e) => e.kind).sort()).toEqual(['person', 'project']);
        expect(s.graph.links_by_rel).toEqual([{ rel: 'about', links: 2 }]);
        expect(s.graph.top_connected[0]).toMatchObject({ domain: 'entities', degree: 2 });
        const linkGrowth = s.graph.growth.series.find((x) => x.name === 'links');
        expect(linkGrowth.cumulative[linkGrowth.cumulative.length - 1]).toBe(2);
        expect(s.trips.per_year).toEqual([{ year: '2025', trips: 1, nights: 4 }, { year: '2026', trips: 1, nights: 2 }]);
        expect(s.agents.calls).toBe(1);
        expect(s.agents.by_key.series[0].name).toBe('st-agent');
        expect(s.totals.domains.find((d) => d.name === 'notes').records).toBe(1);
        expect(Array.isArray(s.search.domains)).toBe(true);
    });

    test('a disabled domain is skipped, not failed; the graph stays while one of its domains is on', () => {
        domains.setEnabled(conn(), 'lifelog', false, 'test');
        domains.setEnabled(conn(), 'links', false, 'test');
        const s = stats.collect(conn()).sections;
        expect(s.lifelog).toEqual({ skipped: 'disabled', domains: ['lifelog'] });
        expect(s.graph.links_by_rel).toBeUndefined();
        expect(s.graph.entities_by_kind).toBeDefined();
        expect(s.flights.error).toBeUndefined();
    });

    test('a failing section answers { error } and the rest still come back', () => {
        const orig = stats.SECTIONS.trips.run;
        stats.SECTIONS.trips.run = () => { throw new Error('boom'); };
        try {
            const s = stats.collect(conn()).sections;
            expect(s.trips).toEqual({ error: 'boom' });
            expect(s.deadlines.active).toBe(3);
        } finally { stats.SECTIONS.trips.run = orig; }
    });

    test('amounts appear only in the deadlines cost block, never in domain stats', () => {
        const out = stats.collect(conn(), { range: 'all' });
        const copy = JSON.parse(JSON.stringify(out));
        delete copy.sections.deadlines.cost;
        const text = JSON.stringify(copy);
        expect(text).not.toMatch(/amount|cents/);
        expect(text).not.toContain(String(AMOUNT));
        expect(JSON.stringify(domains.list(conn()))).not.toContain(String(AMOUNT));
        expect(JSON.stringify(deadlines.stats(conn()))).not.toContain(String(AMOUNT));
    });
});

describe('admin stats endpoint', () => {
    test('needs a session; answers the sections; rejects a bad range', async () => {
        await request(app).get('/admin/api/stats').expect(401);
        const agent = request.agent(app);
        await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
        const body = (await agent.get('/admin/api/stats?range=30').expect(200)).body;
        expect(body.range).toBe('30');
        expect(Object.keys(body.sections).sort()).toEqual(['agents', 'deadlines', 'digests', 'flights', 'graph', 'lifelog', 'search', 'totals', 'trips']);
        expect((await agent.get('/admin/api/stats').expect(200)).body.range).toBe('90');
        await agent.get('/admin/api/stats?range=12').expect(400);
    });
});
