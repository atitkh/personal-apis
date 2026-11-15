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
