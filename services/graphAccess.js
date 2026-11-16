// The graph for an agent key: the same data as the dashboard's Graph page (services/graph.js), cut down to the domains the
// key can read. A record in a domain the key cannot read is not shown, and nothing is reached through one: a neighbour that
// is only connected via a hidden record is dropped too. Hidden things are counted, never named. Read only.
const graph = require('./graph');
const { HubError } = require('./errors');

const NEIGHBOR_LIMIT = 60;

const seen = (visible, domain) => visible == null || visible.includes(domain);

// A record and what it is linked to, out to 1 or 2 steps, as a flat list with the way each neighbour relates.
function neighbors(db, { domain, id, depth = 1 } = {}, { visible = null } = {}) {
    if (!seen(visible, domain)) throw new HubError(403, 'not_allowed', `This key cannot read ${String(domain).slice(0, 20)}.`);
    const g = graph.neighborhood(db, { domain, id, depth });
    const shown = new Map(g.nodes.filter((n) => seen(visible, n.domain)).map((n) => [n.key, n]));
    const edges = g.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
    // Keep only what is still connected to the record through readable records.
    const adj = new Map();
    for (const e of edges) {
        (adj.get(e.from) || adj.set(e.from, []).get(e.from)).push(e.to);
        (adj.get(e.to) || adj.set(e.to, []).get(e.to)).push(e.from);
    }
    const reach = new Set([g.center]);
    for (const q = [g.center]; q.length;) for (const k of adj.get(q.shift()) || []) if (!reach.has(k)) { reach.add(k); q.push(k); }
    const keep = [...shown.values()].filter((n) => reach.has(n.key));
    const hidden = g.nodes.length - keep.length;
    const title = new Map(keep.map((n) => [n.key, n.title]));
    const rows = keep.filter((n) => n.key !== g.center).slice(0, NEIGHBOR_LIMIT).map((n) => ({
        domain: n.domain, id: n.id, title: n.title, kind: n.kind, date: n.date, steps: n.depth, links: n.degree }));
    return {
        record: { domain, id: String(id), title: title.get(g.center) },
        depth: g.depth,
        neighbors: rows,
        links: edges.filter((e) => reach.has(e.from) && reach.has(e.to)).map((e) => ({
            from: e.from, to: e.to, rel: e.rel, note: e.note || null, from_title: title.get(e.from), to_title: title.get(e.to) })),
        hidden,
        truncated: g.truncated || keep.length - 1 > NEIGHBOR_LIMIT,
    };
}

// The most connected records the key can read.
function hubs(db, { limit = 12 } = {}, { visible = null } = {}) {
    const max = Math.min(Math.max(Number(limit) || 12, 1), 50);
    const all = graph.hubs(db, { limit: 50 });
    return all.filter((n) => seen(visible, n.domain)).slice(0, max)
        .map((n) => ({ domain: n.domain, id: n.id, title: n.title, kind: n.kind, date: n.date, links: n.degree }));
}

// Records with no link yet: counts per readable domain, and the list for one of them.
function unlinked(db, { domain, limit = 50 } = {}, { visible = null } = {}) {
    if (domain && !seen(visible, domain)) throw new HubError(403, 'not_allowed', `This key cannot read ${String(domain).slice(0, 20)}.`);
    const r = graph.unlinked(db, { domain, limit });
    const counts = {};
    for (const [d, c] of Object.entries(r.counts)) if (seen(visible, d)) counts[d] = c;
    return { counts, domain: r.domain, records: r.records.filter((x) => seen(visible, x.domain)) };
}

module.exports = { neighbors, hubs, unlinked, NEIGHBOR_LIMIT };
