// Flight data enrichment: observations from data sources, merged into the flight's enrichable fields.
//
//   observe(db, flightId, source, fields, meta)  stores what one source said (flight_observations). Fields are
//        limited to flights.ENRICHABLE and cleaned like a hand edit; strict (pushed over /hub) refuses a bad
//        field, otherwise (adapters) a bad field is dropped.
//   applyObservations(db, flightId, actor, {now})  per field, the value from the best source (flight_sources.priority,
//        lower wins, sources without a row last, then by name) whose LATEST ok observation has it. Locked fields
//        (flights.locked_fields, set by hand edits) are skipped; a field no source has is left as it is. One
//        revision (source 'enrich', note naming the sources) when something changed, nothing otherwise.
//        A source status of cancelled/canceled is kept in the observation and shows as source_says_cancelled
//        on the flight; it never changes the status.
//   refresh(db, flightId, { force, now, fetch, env })  asks every enabled, configured pull adapter
//        (services/adapters) and merges. Skips a source looked up ok less than 6 h ago and flights that departed
//        over 30 days ago (both unless force); never goes over the source's monthly cap (default 80 calls when
//        the source has no settings row; null cap = none). Every lookup counts one call.
//   listSources / putSources  settings and this month's calls. API keys stay in the environment: only
//        "configured" (true/false) is ever shown.
const flights = require('./flights');
const adapters = require('./adapters');
const { HubError } = require('./errors');

const RECENT_MS = 6 * 3600 * 1000;
const OLD_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_PRIORITY = 100;
const DEFAULT_CAP = 80;
const CANCEL_WORDS = ['cancelled', 'canceled'];

const bad = (code, message, status = 400) => new flights.FlightError(status, code, message);
const iso = (at) => new Date(at == null ? Date.now() : at).toISOString();

/* ---------- observations ---------- */

// Cleaned fields: each one through flights.build on its own (the actual times' pair check waits for the merge).
function cleanFields(db, row, fields, { strict }) {
    if (fields == null) return {};
    if (typeof fields !== 'object' || Array.isArray(fields)) throw bad('bad_request', 'fields must be an object of field names and values.');
    const base = { ...row, actual_dep: null, actual_arr: null };
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
        if (!flights.ENRICHABLE.includes(k)) {
            if (strict) throw bad('bad_field', `A source can only send: ${flights.ENRICHABLE.join(', ')}.`);
            continue;
        }
        if (v == null || v === '') continue;
        try {
            const value = flights.build(db, { [k]: v }, base).fields[k];
            if (value != null) out[k] = value;
        } catch (err) {
            if (strict || !(err instanceof HubError)) throw err;
        }
    }
    return out;
}

function cleanStatusWord(v) {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') throw bad('bad_request', 'source_status must be text.');
    return v.normalize('NFKC').trim().slice(0, 40) || null;
}

function cleanSource(v) {
    if (typeof v !== 'string' || !adapters.sourceNames().includes(v)) {
        throw bad('bad_source', `source must be one of: ${adapters.sourceNames().join(', ')}.`);
    }
    return v;
}

// meta: { ok (default true), source_status, error, actor, at, strict }
function observe(db, flightId, source, fields, meta = {}) {
    const row = flights.need(db, flightId);
    const name = cleanSource(source);
    const ok = meta.ok !== false;
    const clean = ok ? cleanFields(db, row, fields, { strict: Boolean(meta.strict) }) : {};
    const status = cleanStatusWord(meta.source_status);
    const id = Number(db.prepare(`INSERT INTO flight_observations (flight_id, source, fetched_at, ok, fields, source_status, error, actor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, name, iso(meta.at), ok ? 1 : 0, JSON.stringify(clean), status,
        meta.error ? String(meta.error).slice(0, 40) : null, String(meta.actor || 'unknown')).lastInsertRowid);
    return { id, flight_id: row.id, source: name, ok, fields: Object.keys(clean), source_status: status };
}

const latestOk = (db, flightId) => db.prepare(`SELECT * FROM flight_observations WHERE id IN
    (SELECT MAX(id) FROM flight_observations WHERE flight_id = ? AND ok = 1 GROUP BY source)`).all(flightId);

function priorities(db) {
    return new Map(db.prepare('SELECT name, priority FROM flight_sources').all().map((r) => [r.name, r.priority]));
}

// Estimated times and delay for a flight more than this far from departure are not trusted: a provider's
// revised time weeks ahead is usually a schedule revision, not a real delay (seen live 2026-11-11).
const FAR_OUT_MS = 72 * 3600 * 1000;
const FAR_OUT_FIELDS = ['est_dep', 'est_arr', 'delay_min'];

function applyObservations(db, flightId, actor, { now } = {}) {
    return db.transaction(() => {
        const row = flights.need(db, flightId);
        const prio = priorities(db);
        const rank = (name) => (prio.has(name) ? prio.get(name) : Infinity);
        const obs = latestOk(db, row.id).map((o) => ({ source: o.source, fields: JSON.parse(o.fields || '{}') }))
            .sort((a, b) => rank(a.source) - rank(b.source) || (a.source < b.source ? -1 : 1));
        const locked = new Set(flights.lockedOf(row));
        const changes = {};
        const from = {};
        const farOut = Date.parse(row.sched_dep) - Date.parse(iso(now)) > FAR_OUT_MS;
        for (const k of flights.ENRICHABLE) {
            if (locked.has(k)) continue;
            if (farOut && FAR_OUT_FIELDS.includes(k)) {
                // Too early to trust: show nothing, and clear what an earlier refresh stored.
                if (row[k] != null) { changes[k] = null; from[k] = 'far_out'; }
                continue;
            }
            const best = obs.find((o) => o.fields[k] != null);
            if (best && best.fields[k] !== row[k]) {
                changes[k] = best.fields[k];
                from[k] = best.source;
            }
        }
        const base = { id: row.id, label: flights.label(row), rev: row.current_rev };
        if (!Object.keys(changes).length) return { status: 'unchanged', ...base, fields: [], sources: [], from };
        let built;
        try {
            built = flights.build(db, changes, row);
        } catch (err) {
            if (!(err instanceof HubError)) throw err;
            return { status: 'error', ...base, fields: [], sources: [], from: {}, error: err.code };
        }
        flights.write(db, row.id, built.fields, built.derived);
        const sources = [...new Set(Object.values(from))].filter((n) => n !== 'far_out').sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
        const cleared = Object.values(from).includes('far_out');
        const note = [sources.length ? `From ${sources.join(', ')}` : null, cleared ? 'Estimates cleared (more than 72 h before departure)' : null].filter(Boolean).join('. ');
        const rev = flights.commit(db, row.id, { source: 'enrich', actor, note });
        return { status: 'updated', ...base, rev, fields: Object.keys(changes), sources, from };
    })();
}

/* ---------- source settings and usage ---------- */

const monthOf = (at) => iso(at).slice(0, 7);

function settingsOf(db, name) {
    const r = db.prepare('SELECT * FROM flight_sources WHERE name = ?').get(name);
    if (!r) return { enabled: true, priority: DEFAULT_PRIORITY, monthly_cap: DEFAULT_CAP };
    return { enabled: Boolean(r.enabled), priority: r.priority, monthly_cap: r.monthly_cap };
}

const callsOf = (db, name, month) => {
    const r = db.prepare('SELECT calls FROM flight_source_usage WHERE source = ? AND month = ?').get(name, month);
    return r ? r.calls : 0;
};

function countCall(db, name, month) {
    db.prepare(`INSERT INTO flight_source_usage (source, month, calls) VALUES (?, ?, 1)
        ON CONFLICT (source, month) DO UPDATE SET calls = calls + 1`).run(name, month);
}

function listSources(db, { now: at, env = process.env } = {}) {
    const month = monthOf(at);
    const pull = adapters.ADAPTERS.map((a) => ({
        name: a.id, label: a.label, kind: 'pull', fields: a.fields, verified: a.verified !== false,
        ...settingsOf(db, a.id), calls_this_month: callsOf(db, a.id, month), configured: adapters.configured(a, env),
    }));
    const push = adapters.PUSH_SOURCES.map((s) => ({
        name: s.id, label: s.label, kind: 'push', fields: flights.ENRICHABLE, verified: true,
        ...settingsOf(db, s.id), calls_this_month: null, configured: true,
    }));
    return { month, sources: [...pull, ...push].sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : 1)) };
}

function cleanInt(v, name, min, max, { nullable = false } = {}) {
    if (v === null && nullable) return null;
    if (!Number.isInteger(v) || v < min || v > max) throw bad('bad_request', `${name} must be a whole number from ${min} to ${max}${nullable ? ' (or null)' : ''}.`);
    return v;
}

// Body: one source { name, enabled?, priority?, monthly_cap? } or { sources: [ ...those ] }. Returns the names changed.
function putSources(db, input) {
    const body = input || {};
    const list = Array.isArray(body.sources) ? body.sources : [body];
    if (!list.length) throw bad('bad_request', 'Send a source: { name, enabled, priority, monthly_cap }.');
    const changed = [];
    db.transaction(() => {
        for (const s of list) {
            if (!s || typeof s !== 'object') throw bad('bad_request', 'Each source must be an object.');
            for (const k of Object.keys(s)) {
                if (!['name', 'enabled', 'priority', 'monthly_cap'].includes(k)) throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
            }
            const name = cleanSource(s.name);
            const cur = settingsOf(db, name);
            if (s.enabled !== undefined && typeof s.enabled !== 'boolean') throw bad('bad_request', 'enabled must be true or false.');
            const next = {
                enabled: s.enabled === undefined ? cur.enabled : s.enabled,
                priority: s.priority === undefined ? cur.priority : cleanInt(s.priority, 'priority', 0, 1000),
                monthly_cap: s.monthly_cap === undefined ? cur.monthly_cap : cleanInt(s.monthly_cap, 'monthly_cap', 0, 1000000, { nullable: true }),
            };
            db.prepare(`INSERT INTO flight_sources (name, enabled, priority, monthly_cap, updated_at) VALUES (@name, @enabled, @priority, @monthly_cap, @at)
                ON CONFLICT (name) DO UPDATE SET enabled = @enabled, priority = @priority, monthly_cap = @monthly_cap, updated_at = @at`)
                .run({ name, ...next, enabled: next.enabled ? 1 : 0, at: iso() });
            changed.push(name);
        }
    })();
    return changed;
}

/* ---------- refresh ---------- */

const ago = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min ago` : `${Math.round(ms / 3600000)} h ago`);

// Returns { status, id, label, rev, fields, sources, results: [{ source, result, detail }] }.
async function refresh(db, flightId, { force = false, now: at, fetch, env = process.env, actor = 'unknown', list = adapters.ADAPTERS } = {}) {
    const row = flights.need(db, flightId);
    const nowMs = at == null ? Date.now() : new Date(at).getTime();
    const month = monthOf(nowMs);
    const flight = {
        airline_iata: row.airline_iata, flight_number: row.flight_number, dep_local_date: row.dep_local_date,
        origin_iata: row.origin_iata, dest_iata: row.dest_iata, sched_dep: row.sched_dep, sched_arr: row.sched_arr,
    };
    const old = Date.parse(row.sched_dep) < nowMs - OLD_MS;
    const results = [];
    const okSources = [];
    for (const adapter of list) {
        const s = settingsOf(db, adapter.id);
        if (!s.enabled) continue;
        const done = (result, detail) => results.push({ source: adapter.id, result, detail });
        if (!adapters.configured(adapter, env)) { done('not_configured', `${adapter.keyEnv} is not set`); continue; }
        if (old && !force) { done('skipped_old', 'departed over 30 days ago'); continue; }
        if (!force) {
            const last = db.prepare('SELECT fetched_at FROM flight_observations WHERE flight_id = ? AND source = ? AND ok = 1 ORDER BY id DESC LIMIT 1')
                .get(row.id, adapter.id);
            const age = last ? nowMs - Date.parse(last.fetched_at) : Infinity;
            if (age < RECENT_MS) { done('skipped_recent', `looked up ${ago(age)}`); continue; }
        }
        const calls = callsOf(db, adapter.id, month);
        if (s.monthly_cap != null && calls >= s.monthly_cap) { done('cap_reached', `${calls} of ${s.monthly_cap} calls this month`); continue; }
        countCall(db, adapter.id, month);
        let r;
        try {
            r = await adapter.lookup(flight, { fetch, now: new Date(nowMs), env });
        } catch (err) {
            r = { ok: false, fields: {}, source_status: null, error: 'adapter_failed' };
        }
        r = r || { ok: false, error: 'adapter_failed' };
        observe(db, row.id, adapter.id, r.fields, { ok: Boolean(r.ok), source_status: r.source_status, error: r.error, actor, at: nowMs });
        if (r.ok) okSources.push({ source: adapter.id, status: r.source_status });
        else done('error', String(r.error || 'failed').slice(0, 40));
    }
    const lookedUp = okSources.length + results.filter((x) => x.result === 'error').length;
    let merged = { status: 'unchanged', id: row.id, label: flights.label(row), rev: row.current_rev, fields: [], sources: [], from: {} };
    if (okSources.length) merged = applyObservations(db, row.id, actor, { now: nowMs });
    for (const o of okSources) {
        const mine = Object.keys(merged.from).filter((k) => merged.from[k] === o.source);
        if (mine.length) results.push({ source: o.source, result: 'updated', detail: mine.join(', ') });
        else if (merged.status === 'error') results.push({ source: o.source, result: 'error', detail: merged.error });
        else results.push({ source: o.source, result: 'unchanged', detail: o.status ? `status ${o.status}` : 'nothing new' });
    }
    const { from: _from, ...out } = merged;
    return { ...out, status: merged.status === 'updated' ? 'updated' : 'unchanged', results, looked_up: lookedUp };
}

module.exports = {
    RECENT_MS, OLD_MS, DEFAULT_CAP, DEFAULT_PRIORITY, CANCEL_WORDS,
    observe, applyObservations, refresh, listSources, putSources, settingsOf, monthOf,
};
