// The graph data: a record's neighbourhood, the most connected records, the records with no link. Everything is invented.
const KEY = 'd'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const ents = require('../services/entities');
const links = require('../services/links');
const deadlines = require('../services/deadlines');
const domainSvc = require('../services/domains');
const digests = require('../services/digests');
const trips = require('../services/trips');
const graph = require('../services/graph');
const app = require('../app');

const conn = db.get();
const H = { 'X-Requested-With': 'hub-admin' };
let agent;
let a; let b; let c; let d;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
    a = ents.create(conn, { kind: 'person', name: 'Ines Calder' }, 't').id;
    b = ents.create(conn, { kind: 'project', name: 'Glasshouse' }, 't').id;
    c = ents.create(conn, { kind: 'organization', name: 'Harbour Lab' }, 't').id;
    d = ents.create(conn, { kind: 'topic', name: 'Tides' }, 't').id;
    const ref = (id) => ({ domain: 'entities', id: String(id) });
    links.add(conn, { from: ref(a), to: ref(b), rel: 'works-on' }, 't');
    links.add(conn, { from: ref(b), to: ref(c), rel: 'part-of' }, 't');
    links.add(conn, { from: ref(c), to: ref(d), rel: 'about' }, 't');
});
afterAll(() => db.close());

test('one hop shows direct neighbours; two hops reach their neighbours; edges between shown nodes are kept', () => {
    const one = graph.neighborhood(conn, { domain: 'entities', id: String(b) });
    expect(one.nodes.map((n) => n.title).sort()).toEqual(['Glasshouse', 'Harbour Lab', 'Ines Calder']);
    expect(one.nodes.find((n) => n.depth === 0).title).toBe('Glasshouse');
    expect(one.edges).toHaveLength(2);
    const two = graph.neighborhood(conn, { domain: 'entities', id: String(b), depth: 2 });
    expect(two.nodes).toHaveLength(4);
    expect(two.nodes.find((n) => n.title === 'Tides').depth).toBe(2);
    expect(two.nodes.find((n) => n.title === 'Glasshouse').degree).toBe(2);
});

test('an unknown record is a 404, depth is clamped, and a very busy record is summarised', () => {
    expect(() => graph.neighborhood(conn, { domain: 'entities', id: '9999' })).toThrow(/no entities record/);
    expect(graph.neighborhood(conn, { domain: 'entities', id: String(a), depth: 9 }).depth).toBe(2);
    const hub = ents.create(conn, { kind: 'topic', name: 'Busy' }, 't').id;
    for (let i = 0; i < graph.PER_NODE_CAP + 5; i += 1) {
        const x = ents.create(conn, { kind: 'other', name: `Spoke ${i}` }, 't').id;
        links.add(conn, { from: { domain: 'entities', id: String(hub) }, to: { domain: 'entities', id: String(x) }, rel: 'related' }, 't');
    }
    const r = graph.neighborhood(conn, { domain: 'entities', id: String(hub) });
    expect(r.nodes.length).toBe(graph.PER_NODE_CAP + 1);
    expect(r.truncated).toBe(true);
    expect(r.nodes.find((n) => n.depth === 0).hidden).toBe(5);
});

test('most connected lists the busiest record first, unlinked counts and lists what has no link', () => {
    expect(graph.hubs(conn, { limit: 1 })[0].title).toBe('Busy');
    const lone = ents.create(conn, { kind: 'person', name: 'Loner Vance' }, 't').id;
    const u = graph.unlinked(conn, { domain: 'entities' });
    expect(u.counts.entities.unlinked).toBeGreaterThanOrEqual(1);
    expect(u.records.map((r) => r.id)).toContain(String(lone));
    expect(u.records.map((r) => r.title)).not.toContain('Glasshouse');
    expect(() => graph.unlinked(conn, { domain: 'nope' })).toThrow(/domain must be/);
});

test('the dashboard API needs a session and answers the three reads', async () => {
    await request(app).get('/admin/api/graph?domain=entities&id=1').expect(401);
    const r = (await agent.get(`/admin/api/graph?domain=entities&id=${b}&depth=2`).expect(200)).body;
    expect(r).toMatchObject({ center: `entities:${b}`, depth: 2 });
    expect(r.domains).toContain('entities');
    await agent.get('/admin/api/graph?domain=entities&id=9999').expect(404);
    expect((await agent.get('/admin/api/graph/hubs?limit=3').expect(200)).body.hubs.length).toBeLessThanOrEqual(3);
    expect((await agent.get('/admin/api/graph/unlinked?domain=entities').expect(200)).body.counts.entities).toBeDefined();
});

test('overview: every linked record once, with edges, degree and domain; unlinked records are absent', () => {
    const o = graph.overview(conn);
    const total = conn.prepare('SELECT COUNT(*) AS n FROM (SELECT from_domain, from_id FROM links UNION SELECT to_domain, to_id FROM links)').get().n;
    expect(o.shown + o.leftOut).toBe(total);
    expect(o.leftOut).toBe(0);
    expect(o.nodes).toHaveLength(o.shown);
    expect(new Set(o.nodes.map((n) => n.key)).size).toBe(o.shown);
    const gh = o.nodes.find((n) => n.title === 'Glasshouse');
    expect(gh).toMatchObject({ domain: 'entities', degree: 2 });
    expect(o.nodes.map((n) => n.title)).not.toContain('Loner Vance');
    expect(o.edges.every((e) => o.nodes.some((n) => n.key === e.from) && o.nodes.some((n) => n.key === e.to))).toBe(true);
    expect(o.domains.entities.shown).toBe(o.shown);
});

test('overview: the cap keeps the most connected records and says how many were left out', () => {
    const all = graph.overview(conn);
    const o = graph.overview(conn, { cap: 5 });
    expect(o.nodes).toHaveLength(5);
    expect(o.cap).toBe(5);
    expect(o.leftOut).toBe(all.shown - 5);
    expect(o.nodes[0].title).toBe('Busy');
    const min = Math.min(...o.nodes.map((n) => n.degree));
    const kept = new Set(o.nodes.map((n) => n.key));
    expect(all.nodes.filter((n) => !kept.has(n.key)).every((n) => n.degree <= min)).toBe(true);
    expect(o.edges.every((e) => kept.has(e.from) && kept.has(e.to))).toBe(true);
    expect(o.domains.entities).toEqual({ shown: 5, total: all.shown });
    expect(graph.overview(conn, { cap: 99999 }).cap).toBe(graph.OVERVIEW_CAP);
    expect(graph.overview(conn, { cap: 'x' }).cap).toBe(graph.OVERVIEW_CAP);
});

test('overview: a disabled domain is hidden, and no reference or amount text appears', () => {
    const dl = deadlines.create(conn, { title: 'Studio lease', kind: 'bill', due_date: '2099-02-01', reference: 'SECRET-REF-9', amount_cents: 12345, currency: 'USD' }, 't').id;
    links.add(conn, { from: { domain: 'deadlines', id: String(dl) }, to: { domain: 'entities', id: String(a) }, rel: 'about' }, 't');
    const on = graph.overview(conn);
    expect(on.nodes.find((n) => n.domain === 'deadlines').title).toBe('Studio lease');
    expect(JSON.stringify(on)).not.toMatch(/SECRET-REF-9|12345/);
    domainSvc.setEnabled(conn, 'deadlines', false, 't');
    try {
        const off = graph.overview(conn);
        expect(off.nodes.some((n) => n.domain === 'deadlines')).toBe(false);
        expect(off.domains.deadlines).toBeUndefined();
        expect(off.edges.some((e) => e.from.startsWith('deadlines:') || e.to.startsWith('deadlines:'))).toBe(false);
        expect(off.nodes.find((n) => n.title === 'Ines Calder').degree).toBe(on.nodes.find((n) => n.title === 'Ines Calder').degree - 1);
    } finally { domainSvc.setEnabled(conn, 'deadlines', true, 't'); }
});

test('overview: the API needs a session and honours cap', async () => {
    await request(app).get('/admin/api/graph/overview').expect(401);
    const r = (await agent.get('/admin/api/graph/overview?cap=7').expect(200)).body;
    expect(r.nodes).toHaveLength(7);
    expect(r.leftOut).toBeGreaterThan(0);
    expect(r).toMatchObject({ cap: 7, shown: 7 });
});

test('edges carry their row id, relation and the short note (when there is one), in the overview and in a neighbourhood', () => {
    const ref = (id) => ({ domain: 'entities', id: String(id) });
    const made = links.add(conn, { from: ref(d), to: ref(a), rel: 'for', note: 'seen at the harbour' }, 't');
    const o = graph.overview(conn);
    const e = o.edges.find((x) => x.id === made.id);
    expect(e).toEqual({ id: made.id, from: `entities:${d}`, to: `entities:${a}`, rel: 'for', note: 'seen at the harbour', created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(o.edges.find((x) => x.rel === 'works-on')).not.toHaveProperty('note');
    const n = graph.neighborhood(conn, { domain: 'entities', id: a, depth: 1 });
    expect(n.edges.find((x) => x.id === made.id)).toMatchObject({ rel: 'for', note: 'seen at the harbour' });
    links.remove(conn, made.id);
});

test('link edits from the graph go through the audited admin API: created, already linked (answered unchanged, no audit row), removed', async () => {
    const ref = (id) => ({ domain: 'entities', id: String(id) });
    const rows = () => conn.prepare("SELECT actor, action, detail FROM audit_log WHERE action IN ('link_created', 'link_removed') ORDER BY id").all();
    const before = rows().length;
    await request(app).post('/admin/api/links').set(H).send({ from: ref(a), to: ref(d), rel: 'about' }).expect(401);
    await agent.post('/admin/api/links').send({ from: ref(a), to: ref(d), rel: 'about' }).expect(403);
    const made = (await agent.post('/admin/api/links').set(H).send({ from: ref(a), to: ref(d), rel: 'about', note: 'x' }).expect(201)).body;
    expect(made).toMatchObject({ status: 'created', rel: 'about' });
    const again = (await agent.post('/admin/api/links').set(H).send({ from: ref(d), to: ref(a), rel: 'about' }).expect(200)).body;
    expect(again).toEqual({ status: 'unchanged', id: made.id });
    await agent.post('/admin/api/links').set(H).send({ from: ref(a), to: ref(d), rel: 'Not Valid' }).expect(400);
    expect(rows()).toHaveLength(before + 1);
    expect(graph.overview(conn).edges.some((e) => e.id === made.id && e.note === 'x')).toBe(true);
    await agent.delete(`/admin/api/links/${made.id}`).set(H).send({ confirm: true }).expect(200);
    const after = rows();
    expect(after).toHaveLength(before + 2);
    expect(after.slice(-2).map((r) => [r.actor, r.action])).toEqual([['admin', 'link_created'], ['admin', 'link_removed']]);
    expect(graph.overview(conn).edges.some((e) => e.id === made.id)).toBe(false);
});

test('timeline: normTime turns days, months, years, ISO times and week periods into one sortable day, and anything else into null', () => {
    const n = graph.normTime;
    expect(n('2026-11-08')).toBe('2026-11-08');
    expect(n('2026-11-08T03:04:05Z')).toBe('2026-11-08');
    expect(n('2026-11')).toBe('2026-11-01');
    expect(n('2024')).toBe('2024-01-01');
    expect(n('2026-W45')).toBe('2026-11-08'); // the Sunday that closes ISO week 45 of 2026
    expect(n('2026-W01')).toBe('2026-01-04');
    expect(n('2020-W53')).toBe('2021-01-03');
    for (const bad of [null, undefined, '', 'soon', '2026-13-01', '2026-02-30', '2026-W00', '2026-W54', 'x2026-01-01']) expect(n(bad)).toBeNull();
});

test('timeline: nodes carry t (a day or null) in the overview and a neighbourhood; links carry created_at', () => {
    const ref = (dom, id) => ({ domain: dom, id: String(id) });
    const dl = deadlines.create(conn, { title: 'Harbour pass', kind: 'document', due_date: '2026-03-15' }, 't').id;
    const trip = trips.create(conn, { title: 'Dated trip', destination: 'Tampa', kind: 'leisure', start_date: '2026-05-02', end_date: '2026-05-04' }, 't').id;
    const undatedTrip = trips.create(conn, { title: 'Someday trip', kind: 'leisure' }, 't').id;
    digests.put(conn, 'weekly', '2026-W45', { body: 'A week.', actor: 't' });
    digests.put(conn, 'daily', '2026-11-08', { body: 'A day.', actor: 't' });
    const made = [
        links.add(conn, { from: ref('deadlines', dl), to: ref('entities', a), rel: 'for' }, 't'),
        links.add(conn, { from: ref('trips', trip), to: ref('entities', a), rel: 'during' }, 't'),
        links.add(conn, { from: ref('trips', undatedTrip), to: ref('entities', a), rel: 'during' }, 't'),
        links.add(conn, { from: ref('digests', 'weekly/2026-W45'), to: ref('entities', a), rel: 'about' }, 't'),
        links.add(conn, { from: ref('digests', 'daily/2026-11-08'), to: ref('entities', a), rel: 'about' }, 't'),
    ];
    conn.prepare('UPDATE links SET created_at = ? WHERE id = ?').run('2026-04-10T12:00:00.000Z', made[0].id);
    try {
        const t = (g, title) => g.nodes.find((x) => x.title === title).t;
        for (const g of [graph.overview(conn), graph.neighborhood(conn, { domain: 'entities', id: a, depth: 1 })]) {
            expect(t(g, 'Harbour pass')).toBe('2026-03-15');
            expect(t(g, 'Dated trip')).toBe('2026-05-02');
            expect(t(g, 'Someday trip')).toBeNull();
            expect(t(g, 'Weekly digest 2026-W45')).toBe('2026-11-08');
            expect(t(g, 'Daily digest 2026-11-08')).toBe('2026-11-08');
            expect(t(g, 'Ines Calder')).toBeNull(); // entities have no date
            expect(g.nodes.every((x) => x.t === null || /^\d{4}-\d{2}-\d{2}$/.test(x.t))).toBe(true);
            expect(g.edges.every((x) => /^\d{4}-\d{2}-\d{2}T/.test(x.created_at))).toBe(true);
            expect(g.edges.find((x) => x.id === made[0].id).created_at).toBe('2026-04-10T12:00:00.000Z');
            expect(g.nodes).toHaveLength(new Set(g.nodes.map((x) => x.key)).size);
        }
    } finally {
        for (const m of made) links.remove(conn, m.id);
    }
});

test('timeline: the node cap is unchanged and the time fields add no reference or amount text', () => {
    expect(graph.OVERVIEW_CAP).toBe(400);
    expect(graph.overview(conn, { cap: 99999 }).cap).toBe(400);
    expect(JSON.stringify(graph.overview(conn))).not.toMatch(/SECRET-REF-9|12345/);
});
