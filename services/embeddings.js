// Semantic search: embeddings from any OpenAI-compatible endpoint (Ollama /v1, llama.cpp, vLLM, LM Studio, OpenAI ...),
// stored next to the records and compared by cosine similarity. Optional and off by default. The text sent out is the
// same safe text keyword search reads (titles, notes, destinations; never references, amounts, addresses or
// raw lifelog lines). Lifelog episodes are embedded only when `include_lifelog` is switched on.
//
// Settings live in hub_settings under embeddings.*: enabled, base_url, model, include_lifelog, api_key (write-only:
// no function here ever returns it), last_error. The index is rebuilt by a background tick (every five minutes and
// right after a settings change): new or changed records are embedded in small batches, records that are gone are
// dropped, and a changed model drops every old vector. If the endpoint is unreachable, search falls back to keywords.
const crypto = require('crypto');
const domains = require('./domains');
const { HubError } = require('./errors');

const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 45 * 1000;
const BATCH = 16;
const PER_TICK = 160;
const TIMEOUT_MS = 30 * 1000;        // indexing batches: a cold model can be slow
const QUERY_TIMEOUT_MS = 8 * 1000;   // live search: give up early so the keyword results still come back in time
const TEXT_CHARS = 2000;
const SNIPPET_CHARS = 180;
// Tuned for nomic-embed-text: unrelated records score ~0.48 (p90 0.56, p99 0.65), related ones 0.9+. Other models need other numbers.
const MIN_SCORE = 0.55;      // cosine below this is noise
const BAND = 0.10;           // keep results within this of the best one

class EmbeddingError extends HubError {
    constructor(message, code = 'bad_embeddings', status = 400) {
        super(status, code, message);
        this.name = 'EmbeddingError';
    }
}

/* ---------- settings ---------- */

const KEYS = ['enabled', 'base_url', 'model', 'include_lifelog'];
const row = (conn, k) => { const r = conn.prepare('SELECT value FROM hub_settings WHERE key = ?').get(`embeddings.${k}`); return r ? r.value : undefined; };
const put = (conn, k, v) => {
    if (v == null) conn.prepare('DELETE FROM hub_settings WHERE key = ?').run(`embeddings.${k}`);
    else conn.prepare('INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(`embeddings.${k}`, String(v), new Date().toISOString());
};

function parseUrl(v) {
    if (typeof v !== 'string' || !v.trim() || v.length > 300) throw new EmbeddingError('Enter the embeddings address (http or https).', 'bad_embeddings');
    let u;
    try { u = new URL(v.trim()); } catch (e) { throw new EmbeddingError('That is not a web address.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EmbeddingError('The address must start with http:// or https://.');
    if (u.username || u.password) throw new EmbeddingError('Put the key in the key field, not in the address.');
    return u.toString().replace(/\/+$/, '');
}

const hostOf = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch (e) { return ''; } };
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

function config(conn) {
    return {
        enabled: bool(row(conn, 'enabled')),
        base_url: row(conn, 'base_url') || null,
        model: row(conn, 'model') || '',
        include_lifelog: bool(row(conn, 'include_lifelog')),
        has_api_key: Boolean(row(conn, 'api_key')),
    };
}

// What the dashboard may see: the host, not the full address (it may hold a path or token).
const publicConfig = (conn) => { const c = config(conn); return { ...c, base_url: c.base_url ? hostOf(c.base_url) + new URL(c.base_url).pathname.replace(/\/+$/, '') : null }; };

function saveConfig(conn, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EmbeddingError('Send an object of settings.');
    const changed = [];
    const set = (k, v) => { put(conn, k, v); changed.push(k); };
    for (const k of Object.keys(body)) if (![...KEYS, 'api_key'].includes(k)) throw new EmbeddingError(`Unknown setting ${String(k).slice(0, 40)}.`);
    if ('base_url' in body) set('base_url', body.base_url === null || body.base_url === '' ? null : parseUrl(body.base_url));
    if ('model' in body) {
        const m = body.model == null ? '' : String(body.model).trim();
        if (m.length > 120 || /[\r\n\0]/.test(m)) throw new EmbeddingError('The model name is not usable.');
        set('model', m || null);
    }
    if ('api_key' in body) {
        const k = body.api_key;
        if (k !== null && k !== '' && (typeof k !== 'string' || k.length > 500 || /[\r\n\0]/.test(k))) throw new EmbeddingError('The key is not usable (one line).');
        set('api_key', k === null || k === '' ? null : k);
    }
    if ('include_lifelog' in body) set('include_lifelog', bool(body.include_lifelog) ? 1 : null);
    if ('enabled' in body) {
        const on = bool(body.enabled);
        const c = config(conn);
        if (on && (!c.base_url || !c.model)) throw new EmbeddingError('Set the address and the model name before turning semantic search on.');
        set('enabled', on ? 1 : null);
    }
    return changed;
}

/* ---------- the endpoint ---------- */

const fetchNow = (...a) => globalThis.fetch(...a);

// Embeds `inputs` (strings). Returns an array of unit-length Float32Arrays. Errors name the host only.
async function embed(conn, inputs, { fetchImpl = fetchNow, timeoutMs = TIMEOUT_MS } = {}) {
    const c = config(conn);
    if (!c.base_url || !c.model) throw new EmbeddingError('Semantic search is not set up (address and model).', 'not_configured');
    const url = /\/embeddings$/.test(c.base_url) ? c.base_url : `${c.base_url}/embeddings`;
    const headers = { 'Content-Type': 'application/json' };
    const key = row(conn, 'api_key');
    if (key) headers.Authorization = `Bearer ${key}`;
    const where = hostOf(c.base_url);
    let res;
    try {
        res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ model: c.model, input: inputs }), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        throw new EmbeddingError(`${where} ${err && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached'}.`, 'unreachable', 502);
    }
    if (res.status < 200 || res.status >= 300) throw new EmbeddingError(`${where} answered HTTP ${res.status}.`, 'endpoint_error', 502);
    let data;
    try { data = await res.json(); } catch (e) { throw new EmbeddingError(`${where} did not answer with JSON.`, 'endpoint_error', 502); }
    const list = data && Array.isArray(data.data) ? [...data.data].sort((a, b) => (a.index || 0) - (b.index || 0)) : null;
    if (!list || list.length !== inputs.length || list.some((d) => !Array.isArray(d.embedding) || !d.embedding.length)) {
        throw new EmbeddingError(`${where} answered, but not with embeddings for this model.`, 'endpoint_error', 502);
    }
    return list.map((d) => {
        const v = Float32Array.from(d.embedding);
        let n = 0;
        for (const x of v) n += x * x;
        n = Math.sqrt(n) || 1;
        for (let i = 0; i < v.length; i++) v[i] /= n;
        return v;
    });
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/* ---------- what gets embedded: the same safe text as keyword search ---------- */

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Each source yields { id, title, text, snippet?, date?, kind? }.
const SOURCES = {
    digests(db) {
        const digests = require('./digests');
        const out = [];
        for (const kind of ['daily', 'weekly']) {
            for (const i of digests.list(db, { kind, limit: 500 })) {
                let body = '';
                try { body = digests.get(db, kind, i.period, { wikilinks: false }).body || ''; } catch (e) { body = ''; }
                out.push({ id: `${kind}/${i.period}`, title: `${kind === 'weekly' ? 'Weekly' : 'Daily'} digest ${i.period}`, text: body, date: kind === 'daily' ? i.period : undefined, kind });
            }
        }
        return out;
    },
    deadlines: (db) => db.prepare('SELECT id, title, kind, due_date, issuer, notes FROM deadlines').all()
        .map((r) => ({ id: r.id, title: r.title, text: [r.title, r.kind, r.issuer, r.notes].filter(Boolean).join('. '), snippet: r.notes || r.issuer || r.kind, date: r.due_date, kind: r.kind })),
    entities: (db) => db.prepare('SELECT id, kind, name, aliases, notes FROM entities').all().map((r) => {
        let al = [];
        try { al = JSON.parse(r.aliases); } catch (e) { al = []; }
        return { id: r.id, title: r.name, text: [r.name, r.kind, al.join(', '), r.notes].filter(Boolean).join('. '), snippet: r.notes || al.join(', ') || r.kind, kind: r.kind };
    }),
    // The body is clipped to TEXT_CHARS when indexed, like every other source.
    notes: (db) => db.prepare('SELECT id, title, kind, body FROM notes WHERE removed_at IS NULL').all()
        .map((r) => ({ id: r.id, title: r.title, text: [r.kind, r.body].filter(Boolean).join('. '), snippet: clip(r.body, 160) || r.kind, kind: r.kind })),
    preferences: (db) => db.prepare('SELECT id, area, "key", value, notes FROM preferences WHERE removed_at IS NULL').all()
        .map((r) => ({ id: r.id, title: `${r.area}: ${r.key}`, text: `${r.area} ${r.key}: ${r.value}. ${r.notes || ''}`, snippet: r.value, kind: r.area })),
    places: (db) => db.prepare('SELECT id, label, kind, notes FROM places').all()
        .map((r) => ({ id: r.id, title: r.label, text: [r.label, r.kind, r.notes].filter(Boolean).join('. '), snippet: r.notes || r.kind, kind: r.kind })),
    flights: (db) => db.prepare(`SELECT f.id, f.airline_name, f.airline_iata, f.flight_number, f.origin_iata, f.dest_iata, f.dep_local_date, f.notes, o.city AS oc, d.city AS dc
        FROM flights f LEFT JOIN airports o ON o.iata = f.origin_iata LEFT JOIN airports d ON d.iata = f.dest_iata`).all()
        .map((r) => ({ id: r.id, title: `${r.airline_iata} ${r.flight_number} ${r.origin_iata} to ${r.dest_iata}`,
            text: [r.airline_name, `${r.airline_iata} ${r.flight_number}`, `${r.oc || r.origin_iata} to ${r.dc || r.dest_iata}`, r.notes].filter(Boolean).join('. '), snippet: r.oc && r.dc ? `${r.oc} to ${r.dc}` : '', date: r.dep_local_date })),
    trips: (db) => db.prepare(`SELECT t.id, t.title, t.destination, t.kind, t.start_date, t.notes,
        (SELECT GROUP_CONCAT(i.title || ' ' || COALESCE(i.place, ''), '; ') FROM trip_items i WHERE i.trip_id = t.id) AS items FROM trips t`).all()
        .map((r) => ({ id: r.id, title: r.title, text: [r.title, r.destination, r.kind, r.notes, r.items].filter(Boolean).join('. '), snippet: r.destination || r.notes || r.kind, date: r.start_date || undefined, kind: r.kind })),
    lifelog: (db) => db.prepare("SELECT id, kind, title, detail, place, local_date FROM lifelog_episodes WHERE status = 'active'").all()
        .map((r) => ({ id: r.id, title: r.title, text: [r.kind, r.title, r.detail, r.place].filter(Boolean).join('. '), snippet: r.detail || r.kind, date: r.local_date, kind: r.kind })),
    portfolio() {
        const path = require('path');
        const { readJson } = require('../routes/portfolio/freshJson');
        const data = readJson(path.join(__dirname, '..', 'routes', 'portfolio', 'atit', 'atit.json'));
        return (Array.isArray(data.portfolio) ? data.portfolio : []).map((e) => ({
            id: e.id, title: e.title || '', text: [e.title, e.description, [].concat(e.mainCategory || []).join(' '), [].concat(e.categories || []).join(' ')].filter(Boolean).join('. '),
            snippet: e.description || '', date: e.date ? String(e.date) : undefined, kind: [].concat(e.mainCategory || [])[0] || undefined,
        }));
    },
};

function sourceNames(conn) {
    const c = config(conn);
    return Object.keys(SOURCES).filter((n) => domains.exists(n) && domains.isEnabled(conn, n) && (n !== 'lifelog' || c.include_lifelog));
}

const hash = (model, r) => crypto.createHash('sha1').update(`${model}\n${r.title}\n${r.text}`).digest('hex');
const idOut = (s) => (/^\d+$/.test(s) ? Number(s) : s);

/* ---------- indexing ---------- */

let ticking = false;
const lastRun = { at: null, embedded: 0 };

// One pass over the domains: drops vectors of another model or of records that are gone, embeds new/changed records.
async function tick(conn, { fetchImpl } = {}) {
    const c = config(conn);
    if (!c.enabled || !c.base_url || !c.model) return { skipped: true };
    if (ticking) return { busy: true };
    ticking = true;
    let embedded = 0;
    try {
        const names = sourceNames(conn);
        conn.prepare('DELETE FROM embeddings WHERE model != ?').run(c.model);
        conn.prepare(`DELETE FROM embeddings WHERE domain NOT IN (${names.map(() => '?').join(',') || "''"})`).run(...names);
        let budget = PER_TICK;
        for (const name of names) {
            const records = SOURCES[name](conn).map((r) => ({ ...r, key: String(r.id), text: clip(`${r.title}. ${r.text}`, TEXT_CHARS) }));
            const have = new Map(conn.prepare('SELECT record_id, text_hash FROM embeddings WHERE domain = ?').all(name).map((r) => [r.record_id, r.text_hash]));
            const live = new Set(records.map((r) => r.key));
            for (const id of have.keys()) if (!live.has(id)) conn.prepare('DELETE FROM embeddings WHERE domain = ? AND record_id = ?').run(name, id);
            const todo = records.filter((r) => have.get(r.key) !== hash(c.model, r));
            for (let i = 0; i < todo.length && budget > 0; i += BATCH) {
                const batch = todo.slice(i, i + BATCH).slice(0, budget);
                const vectors = await embed(conn, batch.map((r) => r.text), { fetchImpl });
                const up = conn.prepare(`INSERT INTO embeddings (domain, record_id, model, dim, vector, text_hash, title, snippet, date, kind, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(domain, record_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector, text_hash = excluded.text_hash,
                        title = excluded.title, snippet = excluded.snippet, date = excluded.date, kind = excluded.kind, updated_at = excluded.updated_at`);
                const now = new Date().toISOString();
                conn.transaction(() => batch.forEach((r, j) => up.run(name, r.key, c.model, vectors[j].length, toBlob(vectors[j]), hash(c.model, r),
                    clip(r.title, 140), clip(r.snippet || '', SNIPPET_CHARS), r.date || null, r.kind || null, now)))();
                embedded += batch.length;
                budget -= batch.length;
            }
        }
        put(conn, 'last_error', null);
        lastRun.at = new Date().toISOString();
        lastRun.embedded = embedded;
        return { embedded };
    } catch (err) {
        put(conn, 'last_error', clip(err.message, 200));
        return { error: err.message, embedded };
    } finally {
        ticking = false;
    }
}

// How much of each domain is indexed. total counts what would be embedded now.
function status(conn) {
    const c = config(conn);
    const names = sourceNames(conn);
    const indexed = new Map(conn.prepare('SELECT domain, COUNT(*) AS n FROM embeddings WHERE model = ? GROUP BY domain').all(c.model || '').map((r) => [r.domain, r.n]));
    let total = 0;
    const per = names.map((n) => {
        let t = 0;
        try { t = SOURCES[n](conn).length; } catch (e) { t = 0; }
        total += t;
        return { domain: n, title: domains.REGISTRY[n].title, indexed: Math.min(indexed.get(n) || 0, t), total: t };
    });
    return { enabled: c.enabled, model: c.model || null, domains: per, indexed: per.reduce((a, d) => a + d.indexed, 0), total, last_run: lastRun.at, last_error: row(conn, 'last_error') || null };
}

// Drops every vector (the next tick re-embeds everything).
function reset(conn) {
    return conn.prepare('DELETE FROM embeddings').run().changes;
}

/* ---------- querying ---------- */

// Returns { domain: [ { id, title, snippet, date, kind, score } ] } best first, for the visible domains. Throws EmbeddingError.
async function query(conn, q, { visible = null, domains: only, per = 10, fetchImpl } = {}) {
    const c = config(conn);
    if (!c.enabled || !c.base_url || !c.model) throw new EmbeddingError('Semantic search is off.', 'not_configured');
    const asked = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
    const names = sourceNames(conn).filter((n) => (!visible || visible.includes(n)) && (!asked || asked.has(n)));
    if (!names.length) return {};
    const [qv] = await embed(conn, [clip(q, 500)], { fetchImpl, timeoutMs: QUERY_TIMEOUT_MS });
    const rows = conn.prepare(`SELECT domain, record_id, title, snippet, date, kind, dim, vector FROM embeddings WHERE model = ? AND domain IN (${names.map(() => '?').join(',')})`).all(c.model, ...names);
    const scored = [];
    for (const r of rows) {
        if (r.dim !== qv.length) continue;
        const v = fromBlob(r.vector);
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * qv[i];
        scored.push({ domain: r.domain, id: idOut(r.record_id), title: r.title, snippet: r.snippet, ...(r.date ? { date: r.date } : {}), ...(r.kind ? { kind: r.kind } : {}), score: Math.round(s * 1000) / 1000 });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored.length ? scored[0].score : 0;
    const out = {};
    for (const r of scored) {
        if (r.score < MIN_SCORE || r.score < best - BAND) continue;
        const list = out[r.domain] || (out[r.domain] = []);
        if (list.length < per) list.push(r);
    }
    return out;
}

/* ---------- scheduling ---------- */

let started = false;
function start(getConn) {
    if (started) return;
    started = true;
    start.getConn = getConn;
    const run = () => tick(getConn()).catch((err) => console.error('Embedding tick failed:', err.message));
    setTimeout(run, FIRST_TICK_MS).unref();
    setInterval(run, TICK_MS).unref();
}
// Run an indexing pass soon (after a settings change or a reset).
function poke() {
    if (!started) return;
    setTimeout(() => tick(start.getConn()).catch(() => {}), 500).unref();
}

module.exports = {
    EmbeddingError, config, publicConfig, saveConfig, embed, tick, status, reset, query, start, poke, SOURCES, MIN_SCORE, hostOf,
};
