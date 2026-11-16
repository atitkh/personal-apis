// Unified search across the hub's domains. One adapter per domain; each searches only text that is safe to show an
// agent: titles, labels, notes, destinations. Never booking references, reference or document numbers, amounts,
// street addresses or rule values, coordinates. A result is { domain, id, title, snippet, date?, kind? }.
//
// Keyword matching: every word of the query must appear (case-insensitive substring) somewhere in a record's text.
// Digests use their own full-text index. Lifelog contributes episodes only (raw observations stay in the lifelog tool).
// `domains` limits where to look; `visible` is the list of domains the caller may read (null = all enabled ones).
const domains = require('./domains');
const { HubError } = require('./errors');

const MAX_Q = 200;
const MAX_TERMS = 8;
const DEFAULT_PER = 5;
const MAX_PER = 20;
const TITLE_CHARS = 140;
const SNIPPET_CHARS = 180;
const SEMANTIC_ONLY_MAX = 5;   // results that matched by meaning only, across all domains; keyword matches are never cut

class SearchError extends HubError {
    constructor(message) {
        super(400, 'bad_query', message);
        this.name = 'SearchError';
    }
}

const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function termsOf(q) {
    const text = String(q == null ? '' : q).slice(0, MAX_Q);
    const terms = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))].slice(0, MAX_TERMS);
    if (!terms.length) throw new SearchError('Give at least one word to search for.');
    return terms;
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// SQL: every term must appear in the concatenation of `cols` (NULL columns count as empty).
function where(cols, terms) {
    const hay = cols.map((c) => `COALESCE(${c}, '')`).join(` || ' ' || `);
    return {
        sql: terms.map(() => `LOWER(${hay}) LIKE ? ESCAPE '\\'`).join(' AND '),
        args: terms.map((t) => `%${escapeLike(t)}%`),
    };
}

// A short piece of `text` around the first matching term.
function snippetOf(text, terms, n = SNIPPET_CHARS) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const low = t.toLowerCase();
    let at = -1;
    for (const w of terms) {
        const i = low.indexOf(w);
        if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) return clip(t, n);
    const start = Math.max(0, at - Math.floor(n / 4));
    const piece = t.slice(start, start + n);
    return `${start > 0 ? '…' : ''}${piece}${start + n < t.length ? '…' : ''}`;
}

/* ---------- adapters: (db, terms, limit) -> results ---------- */

const ADAPTERS = {
    digests(db, terms, limit) {
        const digests = require('./digests');
        const rows = digests.search(db, terms.join(' '), { limit });
        return rows.map((r) => ({
            id: `${r.kind}/${r.period}`,
            title: `${r.kind === 'weekly' ? 'Weekly' : 'Daily'} digest ${r.period}`,
            snippet: clip(r.snippet, SNIPPET_CHARS),
            date: r.kind === 'daily' ? r.period : undefined,
            kind: r.kind,
        }));
    },

    deadlines(db, terms, limit) {
        const w = where(['title', 'kind', 'issuer', 'notes'], terms);
        return db.prepare(`SELECT id, title, kind, due_date, status, issuer, notes FROM deadlines WHERE ${w.sql}
            ORDER BY (status = 'active') DESC, due_date LIMIT ?`).all(...w.args, limit).map((r) => ({
            id: r.id,
            title: clip(r.title, TITLE_CHARS),
            snippet: snippetOf([r.issuer, r.notes].filter(Boolean).join(' · ') || `${r.kind}, ${r.status}`, terms),
            date: r.due_date,
            kind: r.kind,
        }));
    },

    // Name, aliases, kind and notes: what a person types to find someone. Names are content, so only this safe text.
    entities(db, terms, limit) {
        const w = where(['kind', 'name', 'aliases', 'notes'], terms);
        return db.prepare(`SELECT id, kind, name, aliases, notes FROM entities WHERE ${w.sql} ORDER BY kind, name COLLATE NOCASE LIMIT ?`)
            .all(...w.args, limit).map((r) => {
                let al = [];
                try { al = JSON.parse(r.aliases); } catch (e) { al = []; }
                return { id: r.id, title: clip(r.name, TITLE_CHARS), snippet: snippetOf([al.join(', '), r.notes].filter(Boolean).join(' · ') || r.kind, terms), kind: r.kind };
            });
    },

    // Title, kind, tags and body; the snippet is the part of the body around the match (digests do the same).
    notes(db, terms, limit) {
        const w = where(['title', 'kind', 'tags', 'body'], terms);
        return db.prepare(`SELECT id, title, kind, body, updated_at FROM notes WHERE removed_at IS NULL AND ${w.sql}
            ORDER BY pinned DESC, updated_at DESC LIMIT ?`).all(...w.args, limit).map((r) => ({
            id: r.id,
            title: clip(r.title, TITLE_CHARS),
            snippet: snippetOf(r.body, terms) || clip(r.kind, 40),
            date: r.updated_at.slice(0, 10),
            kind: r.kind,
        }));
    },

    preferences(db, terms, limit) {
        const w = where(['area', '"key"', 'value', 'notes'], terms);
        return db.prepare(`SELECT id, area, "key", value, notes FROM preferences WHERE removed_at IS NULL AND ${w.sql}
            ORDER BY area, "key" LIMIT ?`).all(...w.args, limit).map((r) => ({
            id: r.id,
            title: clip(`${r.area}: ${r.key}`, TITLE_CHARS),
            snippet: snippetOf([r.value, r.notes].filter(Boolean).join(' · '), terms),
            kind: r.area,
        }));
    },

    places(db, terms, limit) {
        const w = where(['label', 'kind', 'notes'], terms);
        return db.prepare(`SELECT id, label, kind, notes FROM places WHERE ${w.sql} ORDER BY label LIMIT ?`)
            .all(...w.args, limit).map((r) => ({
                id: r.id,
                title: clip(r.label, TITLE_CHARS),
                snippet: snippetOf(r.notes || r.kind, terms),
                kind: r.kind,
            }));
    },

    flights(db, terms, limit) {
        const cols = ['f.airline_name', 'f.airline_iata', "f.airline_iata || f.flight_number", 'f.origin_iata', 'f.dest_iata',
            'o.city', 'o.name', 'd.city', 'd.name', 'f.notes'];
        const w = where(cols, terms);
        return db.prepare(`SELECT f.id, f.airline_iata, f.flight_number, f.origin_iata, f.dest_iata, f.dep_local_date, f.notes,
                o.city AS oc, d.city AS dc
            FROM flights f LEFT JOIN airports o ON o.iata = f.origin_iata LEFT JOIN airports d ON d.iata = f.dest_iata
            WHERE ${w.sql} ORDER BY f.sched_dep DESC LIMIT ?`).all(...w.args, limit).map((r) => ({
            id: r.id,
            title: `${r.airline_iata} ${r.flight_number} ${r.origin_iata} to ${r.dest_iata}`,
            snippet: snippetOf([r.oc && r.dc ? `${r.oc} to ${r.dc}` : null, r.notes].filter(Boolean).join(' · '), terms),
            date: r.dep_local_date,
        }));
    },

    trips(db, terms, limit) {
        const cols = ['t.title', 't.destination', 't.kind', 't.notes',
            "(SELECT GROUP_CONCAT(i.title || ' ' || COALESCE(i.place, '') || ' ' || COALESCE(i.notes, ''), ' ') FROM trip_items i WHERE i.trip_id = t.id)"];
        const w = where(cols, terms);
        return db.prepare(`SELECT t.id, t.title, t.destination, t.kind, t.start_date, t.notes FROM trips t WHERE ${w.sql}
            ORDER BY t.start_date IS NULL, t.start_date DESC LIMIT ?`).all(...w.args, limit).map((r) => ({
            id: r.id,
            title: clip(r.title, TITLE_CHARS),
            snippet: snippetOf([r.destination, r.notes].filter(Boolean).join(' · ') || r.kind, terms),
            date: r.start_date || undefined,
            kind: r.kind,
        }));
    },

    lifelog(db, terms, limit) {
        const w = where(['title', 'detail', 'place', 'kind'], terms);
        return db.prepare(`SELECT id, kind, title, detail, local_date FROM lifelog_episodes WHERE status = 'active' AND ${w.sql}
            ORDER BY start_at DESC LIMIT ?`).all(...w.args, limit).map((r) => ({
            id: r.id,
            title: clip(r.title, TITLE_CHARS),
            snippet: snippetOf(r.detail || r.kind, terms),
            date: r.local_date,
            kind: r.kind,
        }));
    },

    portfolio(db, terms, limit) {
        const { readJson } = require('../routes/portfolio/freshJson');
        const path = require('path');
        const data = readJson(path.join(__dirname, '..', 'routes', 'portfolio', 'atit', 'atit.json'));
        const entries = Array.isArray(data.portfolio) ? data.portfolio : [];
        const out = [];
        for (const e of entries) {
            const text = [e.title, e.description, [].concat(e.mainCategory || []).join(' '), [].concat(e.categories || []).join(' ')].join(' ').toLowerCase();
            if (!terms.every((t) => text.includes(t))) continue;
            out.push({
                id: e.id,
                title: clip(e.title || '', TITLE_CHARS),
                snippet: snippetOf(e.description || '', terms),
                date: e.date ? String(e.date) : undefined,
                kind: [].concat(e.mainCategory || [])[0] || undefined,
            });
            if (out.length >= limit) break;
        }
        return out;
    },
};

const clampPer = (v) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PER) : DEFAULT_PER;
};

// Searches. Returns { query, terms, groups: [{ domain, title, count, results }], total }.
function search(db, q, { domains: only, visible = null, perDomain } = {}) {
    const terms = termsOf(q);
    const per = clampPer(perDomain);
    const asked = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
    const groups = [];
    let total = 0;
    for (const name of domains.names()) {
        if (!ADAPTERS[name]) continue;
        if (visible && !visible.includes(name)) continue;
        if (asked && !asked.has(name)) continue;
        if (!domains.isEnabled(db, name)) continue;
        let results = [];
        try {
            results = ADAPTERS[name](db, terms, per).map((r) => ({ domain: name, ...r, title: clip(r.title, TITLE_CHARS) }));
        } catch (err) {
            if (err && err.name === 'SearchError') throw err;
            console.error(`search in ${name} failed:`, err.message);
        }
        if (!results.length) continue;
        total += results.length;
        groups.push({ domain: name, title: domains.REGISTRY[name].title, count: results.length, results });
    }
    return { query: String(q).slice(0, MAX_Q), terms, groups, total };
}

// Keyword results, plus semantic matches when semantic search is on (embeddings endpoint). The two lists are merged per
// domain by reciprocal rank; `match` says keyword, semantic or both. If the endpoint fails, keyword results are returned
// with semantic: false and a short reason. mode 'keyword' skips the endpoint.
async function searchHybrid(db, q, opts = {}) {
    const base = search(db, q, opts);
    const embeddings = require('./embeddings');
    const cfg = embeddings.config(db);
    if (opts.mode === 'keyword' || !cfg.enabled) return { ...base, semantic: false };
    let sem;
    try {
        sem = await embeddings.query(db, q, { visible: opts.visible, domains: opts.domains, per: clampPer(opts.perDomain), fetchImpl: opts.fetchImpl });
    } catch (err) {
        return { ...base, semantic: false, semantic_error: String(err.message).slice(0, 160) };
    }
    const per = clampPer(opts.perDomain);
    const byDomain = new Map(base.groups.map((g) => [g.domain, g]));
    for (const [domain, hits] of Object.entries(sem)) {
        if (!byDomain.has(domain)) byDomain.set(domain, { domain, title: domains.REGISTRY[domain].title, count: 0, results: [] });
    }
    let groups = [];
    let total = 0;
    const semScore = new Map(); // `${domain}:${id}` -> cosine, to rank semantic-only hits across domains
    for (const name of domains.names()) {
        const g = byDomain.get(name);
        if (!g) continue;
        const scores = new Map();
        const items = new Map();
        const bump = (r, rank, via) => {
            const key = String(r.id);
            scores.set(key, (scores.get(key) || 0) + 1 / (60 + rank));
            const have = items.get(key);
            if (have) { have.match = 'both'; if (!have.snippet && r.snippet) have.snippet = r.snippet; } else { const { score, ...rest } = r; items.set(key, { ...rest, domain: name, match: via }); }
        };
        g.results.forEach((r, i) => bump(r, i, 'keyword'));
        (sem[name] || []).forEach((r, i) => { semScore.set(`${name}:${r.id}`, r.score); bump(r, i, 'semantic'); });
        const results = [...items.entries()].sort((a, b) => scores.get(b[0]) - scores.get(a[0])).map(([, r]) => r).slice(0, per);
        if (!results.length) continue;
        total += results.length;
        groups.push({ domain: name, title: g.title, count: results.length, results });
    }
    // Keep only the best few semantic-only hits overall; anything that also matched the words stays.
    const only = [];
    for (const g of groups) for (const r of g.results) if (r.match === 'semantic') only.push({ r, s: semScore.get(`${g.domain}:${r.id}`) || 0 });
    if (only.length > SEMANTIC_ONLY_MAX) {
        const drop = new Set(only.sort((x, y) => y.s - x.s).slice(SEMANTIC_ONLY_MAX).map((x) => x.r));
        for (const g of groups) { g.results = g.results.filter((r) => !drop.has(r)); g.count = g.results.length; }
        groups = groups.filter((g) => g.count);
        total = groups.reduce((n, g) => n + g.count, 0);
    }
    return { query: base.query, terms: base.terms, groups, total, semantic: true };
}

module.exports = { search, searchHybrid, termsOf, snippetOf, where, SearchError, ADAPTERS, DEFAULT_PER, MAX_PER, MAX_Q };
