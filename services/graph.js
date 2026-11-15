// A read-only view of the links table as a graph, for the dashboard: the neighbourhood of one record out to 1 or 2 hops, the
// most connected records, and the records that have no link yet. Nothing here writes. Node titles are the same safe text that
// links and search show (links.DESCRIBE): never references, amounts or addresses.
const links = require('./links');
const domains = require('./domains');
const { HubError } = require('./errors');

const NODE_CAP = 80;      // the focused view stops growing at this many nodes
const PER_NODE_CAP = 25;  // one record contributes at most this many neighbours per hop (busy ones are summarised)
const UNLINKED_MAX = 100;
const OVERVIEW_CAP = 400; // the whole-graph overview keeps the most connected records up to this many

const bad = (code, message, status = 400) => new HubError(status, code, message);
const key = (d, i) => `${d}:${i}`;
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function describe(db, domain, id) {
    if (!links.DESCRIBE[domain] || !domains.exists(domain) || !domains.isEnabled(db, domain)) return null;
    try { return links.DESCRIBE[domain](db, String(id)); } catch (e) { return null; }
}

const node = (domain, id, d) => ({ key: key(domain, id), domain, id: String(id), title: clip(d.title, 80), kind: d.kind || null, date: d.date || null });

// The records within `depth` hops of one record. Busy records show PER_NODE_CAP neighbours and say how many they hid.
function neighborhood(db, { domain, id, depth = 1 } = {}) {
    const hops = Math.min(Math.max(Number(depth) || 1, 1), 2);
    const d0 = describe(db, domain, id);
    if (!d0) throw bad('not_found', `There is no ${String(domain).slice(0, 20)} record ${String(id).slice(0, 40)}.`, 404);
    const nodes = new Map([[key(domain, id), { ...node(domain, id, d0), depth: 0, hidden: 0 }]]);
    const edges = new Map();
    let frontier = [key(domain, id)];
    let truncated = false;
    const q = db.prepare('SELECT * FROM links WHERE (from_domain = ? AND from_id = ?) OR (to_domain = ? AND to_id = ?) ORDER BY id DESC');
    for (let level = 1; level <= hops; level += 1) {
        const next = [];
        for (const k of frontier) {
            const n = nodes.get(k);
            let shown = 0;
            for (const r of q.all(n.domain, n.id, n.domain, n.id)) {
                const mine = r.from_domain === n.domain && r.from_id === n.id;
                const od = mine ? r.to_domain : r.from_domain;
                const oi = mine ? r.to_id : r.from_id;
                const ok = key(od, oi);
                const seen = nodes.has(ok);
                if (!seen) {
                    if (shown >= PER_NODE_CAP || nodes.size >= NODE_CAP) { n.hidden += 1; truncated = true; continue; }
                    const d = describe(db, od, oi);
                    if (!d) { n.hidden += 1; continue; }
                    nodes.set(ok, { ...node(od, oi, d), depth: level, hidden: 0 });
                    next.push(ok);
                    shown += 1;
                }
                edges.set(r.id, { id: r.id, from: key(r.from_domain, r.from_id), to: key(r.to_domain, r.to_id), rel: r.rel });
            }
        }
        frontier = next;
    }
    // Edges between two shown nodes are all kept (a record linked to two neighbours shows a triangle), so add the ones not
    // reached through the walk.
    const have = [...nodes.keys()];
    const stmt = db.prepare('SELECT * FROM links WHERE (from_domain = ? AND from_id = ?) OR (to_domain = ? AND to_id = ?)');
    for (const k of have) {
        const n = nodes.get(k);
        for (const r of stmt.all(n.domain, n.id, n.domain, n.id)) {
            if (nodes.has(key(r.from_domain, r.from_id)) && nodes.has(key(r.to_domain, r.to_id))) {
                edges.set(r.id, { id: r.id, from: key(r.from_domain, r.from_id), to: key(r.to_domain, r.to_id), rel: r.rel });
            }
        }
    }
    const deg = new Map();
    for (const e of edges.values()) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
    for (const [k, n] of nodes) n.degree = deg.get(k) || 0;
    return { center: key(domain, id), depth: hops, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

// Every record that has at least one link, in the enabled domains, with the links between them. At most `cap` records: the
// most connected ones are kept and `leftOut` says how many more there are (never silently dropped). `domains` counts what is
// shown and what exists per domain, for the legend. Records that no longer exist are skipped.
function overview(db, { cap = OVERVIEW_CAP } = {}) {
    const limit = Math.min(Math.max(Math.floor(Number(cap)) || OVERVIEW_CAP, 1), OVERVIEW_CAP);
    const on = new Map();
    const enabled = (d) => { if (!on.has(d)) on.set(d, Boolean(links.DESCRIBE[d]) && domains.exists(d) && domains.isEnabled(db, d)); return on.get(d); };
    const deg = new Map();
    const rows = db.prepare('SELECT id, from_domain, from_id, to_domain, to_id, rel FROM links').all()
        .filter((r) => enabled(r.from_domain) && enabled(r.to_domain));
    for (const r of rows) {
        for (const k of [key(r.from_domain, r.from_id), key(r.to_domain, r.to_id)]) deg.set(k, (deg.get(k) || 0) + 1);
    }
    const order = [...deg.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const nodes = new Map();
    const total = {};
    let leftOut = 0;
    for (const [k, n] of order) {
        const at = k.indexOf(':');
        const domain = k.slice(0, at);
        const id = k.slice(at + 1);
        if (nodes.size >= limit) { leftOut += 1; total[domain] = (total[domain] || 0) + 1; continue; }
        const d = describe(db, domain, id);
        if (!d) continue;
        nodes.set(k, { ...node(domain, id, d), degree: n });
        total[domain] = (total[domain] || 0) + 1;
    }
    const counts = {};
    for (const n of nodes.values()) (counts[n.domain] || (counts[n.domain] = { shown: 0, total: 0 })).shown += 1;
    for (const [d, t] of Object.entries(total)) (counts[d] || (counts[d] = { shown: 0, total: 0 })).total = t;
    const edges = rows.filter((r) => nodes.has(key(r.from_domain, r.from_id)) && nodes.has(key(r.to_domain, r.to_id)))
        .map((r) => ({ id: r.id, from: key(r.from_domain, r.from_id), to: key(r.to_domain, r.to_id), rel: r.rel }));
    return { nodes: [...nodes.values()], edges, shown: nodes.size, leftOut, cap: limit, domains: counts };
}

// The records with the most links: good places to start looking from (digests and episodes are many and thinly linked, so left out).
function hubs(db, { limit = 12 } = {}) {
    const rows = db.prepare(`SELECT d, i, COUNT(*) AS n FROM (
            SELECT from_domain AS d, from_id AS i FROM links UNION ALL SELECT to_domain AS d, to_id AS i FROM links)
        WHERE d NOT IN ('digests', 'lifelog') GROUP BY d, i ORDER BY n DESC, d, i LIMIT ?`).all(Math.min(Math.max(Number(limit) || 12, 1), 50) * 3);
    const out = [];
    for (const r of rows) {
        const d = describe(db, r.d, r.i);
        if (d) out.push({ ...node(r.d, r.i, d), degree: r.n });
        if (out.length >= limit) break;
    }
    return out;
}

// Listers for the domains that live in the database (portfolio is a file, digests are linked by the nightly job).
const LISTERS = {
    entities: (db) => db.prepare('SELECT id, name AS title, kind FROM entities ORDER BY kind, name').all(),
    trips: (db) => db.prepare('SELECT id, title, kind, start_date AS date FROM trips ORDER BY start_date DESC').all(),
    places: (db) => db.prepare('SELECT id, label AS title, kind FROM places ORDER BY label').all(),
    deadlines: (db) => db.prepare('SELECT id, title, kind, due_date AS date FROM deadlines ORDER BY due_date').all(),
    preferences: (db) => db.prepare('SELECT id, area || \' / \' || "key" AS title, area AS kind FROM preferences WHERE removed_at IS NULL ORDER BY area, "key"').all(),
    lifelog: (db) => db.prepare("SELECT id, title, kind, local_date AS date FROM lifelog_episodes WHERE status = 'active' ORDER BY start_at DESC").all(),
    flights: (db) => db.prepare('SELECT id, airline_iata || flight_number || \' \' || origin_iata || \'-\' || dest_iata AS title, \'flight\' AS kind, dep_local_date AS date FROM flights ORDER BY dep_local_date DESC').all(),
};

// Records with no link, per domain (counts), and the list for one domain.
function unlinked(db, { domain, limit = 50 } = {}) {
    const linked = {};
    for (const r of db.prepare('SELECT d, i FROM (SELECT from_domain AS d, from_id AS i FROM links UNION SELECT to_domain AS d, to_id AS i FROM links)').all()) {
        (linked[r.d] || (linked[r.d] = new Set())).add(String(r.i));
    }
    const counts = {};
    let list = [];
    for (const name of Object.keys(LISTERS)) {
        if (!domains.exists(name) || !domains.isEnabled(db, name)) continue;
        let rows = [];
        try { rows = LISTERS[name](db); } catch (e) { rows = []; }
        const free = rows.filter((r) => !(linked[name] && linked[name].has(String(r.id))));
        counts[name] = { total: rows.length, unlinked: free.length };
        if (name === domain) {
            list = free.slice(0, Math.min(Math.max(Number(limit) || 50, 1), UNLINKED_MAX)).map((r) => ({
                domain: name, id: String(r.id), title: clip(r.title, 100), kind: r.kind || null, date: r.date || null }));
        }
    }
    if (domain && !counts[domain]) throw bad('bad_domain', 'domain must be one of ' + Object.keys(counts).join(', ') + '.');
    return { counts, domain: domain || null, records: list };
}

module.exports = { neighborhood, overview, hubs, unlinked, NODE_CAP, PER_NODE_CAP, OVERVIEW_CAP };
