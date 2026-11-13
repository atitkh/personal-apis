// Lifelog: what Atit does (ate this, went there, sat, walked, slept), pushed as text by many sources, and the
// episodes made from it. The most sensitive domain: a key with "*" does not reach it (services/apiKeys.js).
//
// MODEL (migration 018)
//   lifelog_observations  raw lines, APPEND-ONLY: { source, at (UTC ISO), end_at?, local_date (hub zone, set at
//                         insert), kind? (slug), text (<= 2000, control characters stripped), place? (free text,
//                         place_id when it resolves), tags? (<= 10 slugs), data? (JSON object <= 2 KB),
//                         confidence? (0..1), dedupe? (unique per source: a retry is skipped), key_id }.
//                         Triggers refuse UPDATE always and DELETE outside forget() (the guard row, see 018).
//   lifelog_episodes      { kind, title, start_at, end_at?, local_date, place?, place_id, detail?, source
//                         ('manual' | 'derived' | a label), confidence?, status (active | cancelled) } with revisions
//                         and restore like trips; linked to observations in lifelog_episode_observations.
//
// WHO MAY PUSH UNDER WHICH SOURCE: source defaults to the key's name; a key may only push under its own name unless
// it also holds lifelog:api-write, so a push-only key cannot pretend to be another source.
//
// FORGET (admin only, never /hub or MCP): every observation in a time range (optionally one source) goes; episodes
// lying fully inside the range go too (with a source: only episodes of that source); episodes overlapping it stay
// and lose the links. Audit rows carry the range, the source label and counts only.
//
// PRIVACY: observation text, episode titles and detail never appear in audit rows, errors or stats. Error messages
// name the field, never the value.
const { HubError } = require('./errors');
const { hubTz, todayIn } = require('./lib/tz');
const validate = require('./lib/validate');
const { needRow, commitRevision, findRevision } = require('./lib/revisions');
const { limitOrDefault, clampOffset } = require('./lib/listing');
const { needConfirm } = require('./lib/remove');
const apiKeys = require('./apiKeys');
const { toId } = validate;

const MAX_BATCH = 100;
const MAX_TEXT = 2000;
const MAX_DATA = 2048;
const MAX_TAGS = 10;
const LIST_MAX = 200;
const MAX_LINK = 200;
const STATUSES = ['active', 'cancelled'];
const OBS_FIELDS = ['source', 'at', 'end_at', 'kind', 'text', 'place', 'tags', 'data', 'confidence', 'dedupe'];
const FIELDS = ['kind', 'title', 'start_at', 'end_at', 'place', 'detail', 'source', 'confidence', 'status'];
const REVISIONS = { table: 'lifelog_episodes', revTable: 'lifelog_episode_revisions', fk: 'episode_id' };

class LifelogError extends HubError {
    constructor(status, code, message, extra) {
        super(status, code, message);
        if (extra) this.extra = extra;
    }
}

const bad = (code, message, status = 400, extra) => new LifelogError(status, code, message, extra);
const stamp = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');
const short = (v) => String(v).slice(0, 20);

/* ---------- cleaning ---------- */

// Control characters out (newline and tab stay), NFKC, trimmed; null when blank; longer than max is an error.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
function plain(v, name, max, { required = false } = {}) {
    if (v == null || v === '') {
        if (required) throw bad('bad_request', `${name} is required.`);
        return null;
    }
    if (typeof v !== 'string' && typeof v !== 'number') throw bad('bad_request', `${name} must be text.`);
    const s = String(v).replace(CONTROL, '').normalize('NFKC').trim();
    if (!s) {
        if (required) throw bad('bad_request', `${name} is required.`);
        return null;
    }
    if (s.length > max) throw bad('too_large', `${name} is longer than ${max} characters.`, 400);
    return s;
}

const SLUG = /^[a-z][a-z0-9_-]{0,39}$/;
function slug(v, name) {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (!SLUG.test(s)) throw bad(`bad_${name}`, `${name} must be a short lowercase word (letters, digits, - or _), like eat.`);
    return s;
}

// A UTC ISO instant from text with Z or an offset (or a number of ms). Stored as toISOString(), so text order is time order.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
function instant(v, name, { required = false } = {}) {
    if (v == null || v === '') {
        if (required) throw bad('bad_time', `${name} is required: a time like 2026-11-13T14:05:00Z.`);
        return null;
    }
    const ms = typeof v === 'number' ? v : ISO.test(String(v).trim()) ? Date.parse(String(v).trim()) : NaN;
    if (!Number.isFinite(ms)) throw bad('bad_time', `${name} must be a time with Z or an offset, like 2026-11-13T14:05:00Z.`);
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    if (y < 1970 || y > 2200) throw bad('bad_time', `${name} is out of range.`);
    return d.toISOString();
}

function notFuture(iso, name, now) {
    if (iso && Date.parse(iso) > now.getTime() + 24 * 3600 * 1000) throw bad('bad_time', `${name} is more than a day in the future.`);
}

function confidence(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw bad('bad_confidence', 'confidence must be a number from 0 to 1.');
    return n;
}

function tags(v) {
    if (v == null) return null;
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
    if (!list) throw bad('bad_tags', 'tags must be a list of short words.');
    const out = [...new Set(list.map((t) => slug(t, 'tag')).filter(Boolean))];
    if (out.length > MAX_TAGS) throw bad('bad_tags', `At most ${MAX_TAGS} tags.`);
    return out.length ? JSON.stringify(out) : null;
}

function data(v) {
    if (v == null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) throw bad('bad_data', 'data must be a JSON object.');
    const json = JSON.stringify(v);
    if (Buffer.byteLength(json) > MAX_DATA) throw bad('too_large', `data is over ${MAX_DATA / 1024} KB.`);
    return json === '{}' ? null : json;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function cleanDate(v, name) {
    const m = DATE_RE.exec(String(v == null ? '' : v));
    const ok = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1
        && Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    if (!ok) throw bad('bad_date', `${name} must be a date like 2026-11-13.`);
    return String(v);
}

const localDate = (db, iso) => todayIn(hubTz(db), new Date(iso));

// The UTC instant at which `date` (YYYY-MM-DD) starts in time zone tz.
function startOfDay(date, tz) {
    const [y, m, d] = date.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    const offsetAt = (ms) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
        return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - ms;
    };
    let t = guess - offsetAt(guess);
    t = guess - offsetAt(t);
    return t;
}

// from / to as inclusive UTC ISO bounds. A bare date means that whole day in the hub zone.
function bounds(db, from, to) {
    const tz = hubTz(db);
    const one = (v, name, end) => {
        if (v == null || v === '') return null;
        if (DATE_RE.test(String(v))) {
            const d = cleanDate(v, name);
            if (!end) return new Date(startOfDay(d, tz)).toISOString();
            const next = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
            return new Date(startOfDay(next, tz) - 1).toISOString();
        }
        return instant(v, name);
    };
    const lo = one(from, 'from', false);
    const hi = one(to, 'to', true);
    if (lo && hi && hi < lo) throw bad('bad_range', 'to is before from.');
    return { lo, hi };
}

// FTS5 query from free words: each word quoted, all must match.
function ftsQuery(q) {
    const terms = String(q || '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
    if (!terms.length) throw bad('bad_query', 'Give at least one word to search for.');
    return terms.slice(0, 12).map((t) => `"${t}"`).join(' ');
}

// A place given as free text (or a places id) and the place it resolves to: a places id that exists, a place label
// that matches exactly (ignoring case), or a zone/radius rule that the places resolver calls exact. No match: null.
function resolvePlace(db, place) {
    if (!place) return { place: null, place_id: null };
    try {
        if (/^\d+$/.test(place)) {
            const p = db.prepare('SELECT id, label FROM places WHERE id = ?').get(Number(place));
            if (p) return { place: p.label, place_id: p.id };
        }
        const byLabel = db.prepare('SELECT id FROM places WHERE lower(label) = lower(?)').get(place);
        if (byLabel) return { place, place_id: byLabel.id };
        const r = require('./places').resolve(db, { zone: place });
        if (r.match && r.confidence === 'exact') return { place, place_id: r.match.id };
    } catch (err) { /* no places table or an odd value: the place stays free text */ }
    return { place, place_id: null };
}

/* ---------- observations ---------- */

// One observation, clean, or a LifelogError. `source` is what the caller may push as (see push).
function cleanObservation(db, item, { defaultSource, anySource, now }) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('bad_request', 'An observation must be an object.');
    for (const k of Object.keys(item)) {
        if (!OBS_FIELDS.includes(k)) throw bad('bad_field', `Unknown field ${String(k).slice(0, 40)}.`);
    }
    const source = plain(item.source, 'source', 60) || defaultSource;
    if (!source) throw bad('bad_request', 'source is required.');
    if (!anySource && source !== defaultSource) throw bad('bad_source', 'This key may only push under its own name as the source.', 403);
    const at = instant(item.at, 'at', { required: true });
    notFuture(at, 'at', now);
    const endAt = instant(item.end_at, 'end_at');
    if (endAt && endAt < at) throw bad('bad_time', 'end_at is before at.');
    const o = {
        source,
        at,
        end_at: endAt,
        local_date: localDate(db, at),
        kind: slug(item.kind, 'kind'),
        text: plain(item.text, 'text', MAX_TEXT, { required: true }),
        tags: tags(item.tags),
        data: data(item.data),
        confidence: confidence(item.confidence),
        dedupe: plain(item.dedupe, 'dedupe', 120),
    };
    return { ...o, ...resolvePlace(db, plain(item.place, 'place', 120)) };
}

const insertObs = (db, o, keyId) => Number(db.prepare(`INSERT INTO lifelog_observations
    (source, at, end_at, local_date, kind, text, place, place_id, tags, data, confidence, dedupe, created_at, key_id)
    VALUES (@source, @at, @end_at, @local_date, @kind, @text, @place, @place_id, @tags, @data, @confidence, @dedupe, @created_at, @key_id)`)
    .run({ ...o, created_at: stamp(), key_id: keyId == null ? null : keyId }).lastInsertRowid);

const isDuplicate = (db, o) => Boolean(o.dedupe && db.prepare('SELECT 1 FROM lifelog_observations WHERE source = ? AND dedupe = ?').get(o.source, o.dedupe));

// A batch of 1..100 observations from an API key { id, name, scopes }. Each is checked on its own; the good ones are
// stored in one transaction; one already stored (same source and dedupe) is skipped and counted.
// -> { accepted, duplicates, rejected: [{ index, code, error }], ids, sources }
function push(db, key, items, { now = new Date(), anySource } = {}) {
    if (!Array.isArray(items) || items.length < 1) throw bad('bad_request', 'Send observations: a list of 1 to 100 observations.');
    if (items.length > MAX_BATCH) throw bad('too_many', `At most ${MAX_BATCH} observations per call; split the batch.`, 413);
    const opts = {
        defaultSource: key && key.name ? String(key.name).slice(0, 60) : null,
        anySource: anySource != null ? anySource : Boolean(key && apiKeys.hasScope(key.scopes || [], 'lifelog:api-write')),
        now,
    };
    const out = { accepted: 0, duplicates: 0, rejected: [], ids: [], sources: [] };
    db.transaction(() => {
        items.forEach((item, index) => {
            let o;
            try {
                o = cleanObservation(db, item, opts);
            } catch (err) {
                if (!(err instanceof LifelogError)) throw err;
                out.rejected.push({ index, code: err.code, error: err.message });
                return;
            }
            if (isDuplicate(db, o)) { out.duplicates += 1; return; }
            out.ids.push(insertObs(db, o, key ? key.id : null));
            out.accepted += 1;
            if (!out.sources.includes(o.source)) out.sources.push(o.source);
        });
    })();
    return out;
}

// One observation from a person at the dashboard (source 'dashboard') or an agent: errors are thrown, not collected.
function addObservation(db, input, { source = 'dashboard', keyId = null, now = new Date() } = {}) {
    const o = cleanObservation(db, { ...(input || {}), source: undefined }, { defaultSource: source, anySource: false, now });
    if (isDuplicate(db, o)) return { status: 'unchanged', id: db.prepare('SELECT id FROM lifelog_observations WHERE source = ? AND dedupe = ?').get(o.source, o.dedupe).id, source: o.source };
    return { status: 'created', id: insertObs(db, o, keyId), source: o.source, local_date: o.local_date };
}

function shapeObs(r) {
    return {
        id: r.id, source: r.source, at: r.at, end_at: r.end_at || null, local_date: r.local_date, kind: r.kind || null,
        text: r.text, place: r.place || null, place_id: r.place_id || null,
        tags: r.tags ? JSON.parse(r.tags) : [], data: r.data ? JSON.parse(r.data) : null,
        confidence: r.confidence == null ? null : r.confidence, dedupe: r.dedupe || null, created_at: r.created_at,
    };
}

// Filters: source, kind, from, to (a time, or a date = that whole day in the hub zone), local_date, q (words, full
// text), limit (<= 200, default 50), offset, order (asc | desc, default desc).
function listObservations(db, { source, kind, from, to, local_date: day, q, limit, offset, order } = {}) {
    const where = [];
    const args = [];
    if (source != null && source !== '') { where.push('o.source = ?'); args.push(plain(source, 'source', 60)); }
    if (kind != null && kind !== '') { where.push('o.kind = ?'); args.push(slug(kind, 'kind')); }
    if (day != null && day !== '') { where.push('o.local_date = ?'); args.push(cleanDate(day, 'local_date')); }
    const { lo, hi } = bounds(db, from, to);
    if (lo) { where.push('o.at >= ?'); args.push(lo); }
    if (hi) { where.push('o.at <= ?'); args.push(hi); }
    let join = '';
    if (q != null && q !== '') {
        join = 'JOIN lifelog_observations_fts f ON f.rowid = o.id';
        where.push('lifelog_observations_fts MATCH ?');
        args.push(ftsQuery(q));
    }
    const dir = order == null || order === '' ? 'DESC' : validate.oneOf(bad, String(order).toLowerCase(), 'order', ['asc', 'desc']).toUpperCase();
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM lifelog_observations o ${join} ${sqlWhere}`).get(...args).n;
    const off = clampOffset(offset);
    const lim = limitOrDefault(limit, 50, LIST_MAX);
    const rows = db.prepare(`SELECT o.* FROM lifelog_observations o ${join} ${sqlWhere} ORDER BY o.at ${dir}, o.id ${dir} LIMIT ? OFFSET ?`).all(...args, lim, off);
    return { total, offset: off, limit: lim, observations: rows.map(shapeObs) };
}

/* ---------- episodes ---------- */

const editable = (row) => Object.fromEntries(FIELDS.map((k) => [k, row[k] == null ? null : row[k]]));

// The complete, valid editable fields from `input` laid over `current` (a stored episode, for edits).
function build(db, input, current = {}, { now = new Date() } = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k) && k !== 'note') throw bad('bad_field', `Unknown field ${String(k).slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const t = {
        kind: slug(pick('kind'), 'kind') || 'other',
        title: plain(pick('title'), 'title', 120, { required: true }),
        start_at: instant(pick('start_at'), 'start_at', { required: true }),
        end_at: instant(pick('end_at'), 'end_at'),
        place: plain(pick('place'), 'place', 120),
        detail: plain(pick('detail'), 'detail', MAX_TEXT),
        source: plain(pick('source'), 'source', 60) || 'manual',
        confidence: confidence(pick('confidence')),
        status: null,
    };
    if (given.start_at !== undefined) notFuture(t.start_at, 'start_at', now);
    if (t.end_at && t.end_at < t.start_at) throw bad('bad_time', 'end_at is before start_at.');
    const st = pick('status');
    t.status = validate.oneOf(bad, st == null || st === '' ? 'active' : st, 'status', STATUSES);
    return t;
}

const needEpisode = (db, id) => needRow(db, 'lifelog_episodes', id, () => bad('no_episode', `There is no episode ${short(id)}.`, 404));

function write(db, id, t) {
    const derived = { local_date: localDate(db, t.start_at), place_id: resolvePlace(db, t.place).place_id };
    db.prepare(`UPDATE lifelog_episodes SET ${FIELDS.map((k) => `${k} = @${k}`).join(', ')}, local_date = @local_date, place_id = @place_id WHERE id = @id`)
        .run({ ...t, ...derived, id });
}

const commit = (db, id, meta) => commitRevision(db, REVISIONS, id, meta, editable);

const linkCounts = (db, ids) => {
    if (!ids.length) return new Map();
    return new Map(db.prepare(`SELECT episode_id, COUNT(*) AS n FROM lifelog_episode_observations
        WHERE episode_id IN (${ids.map(() => '?').join(', ')}) GROUP BY episode_id`).all(...ids).map((r) => [r.episode_id, r.n]));
};

const shapeEpisode = (r, links = 0) => ({
    id: r.id, kind: r.kind, title: r.title, start_at: r.start_at, end_at: r.end_at || null, local_date: r.local_date,
    duration_min: r.end_at ? Math.round((Date.parse(r.end_at) - Date.parse(r.start_at)) / 60000) : null,
    place: r.place || null, place_id: r.place_id || null, detail: r.detail || null, source: r.source,
    confidence: r.confidence == null ? null : r.confidence, status: r.status, observation_count: links,
    rev: r.current_rev, created_at: r.created_at, updated_at: r.updated_at, updated_by: r.updated_by,
});

// Filters: kind, status, source, from, to (on start_at; a date = that whole day in the hub zone), local_date, q
// (words in title, detail, kind), limit (<= 200), offset. Oldest first within a day query, else newest first.
function listEpisodes(db, { kind, status, source, from, to, local_date: day, q, limit, offset, order } = {}) {
    const where = [];
    const args = [];
    if (kind != null && kind !== '') { where.push('e.kind = ?'); args.push(slug(kind, 'kind')); }
    if (status != null && status !== '' && status !== 'all') { where.push('e.status = ?'); args.push(validate.oneOf(bad, status, 'status', STATUSES)); }
    if (source != null && source !== '') { where.push('e.source = ?'); args.push(plain(source, 'source', 60)); }
    if (day != null && day !== '') { where.push('e.local_date = ?'); args.push(cleanDate(day, 'local_date')); }
    const { lo, hi } = bounds(db, from, to);
    if (lo) { where.push('e.start_at >= ?'); args.push(lo); }
    if (hi) { where.push('e.start_at <= ?'); args.push(hi); }
    let join = '';
    if (q != null && q !== '') {
        join = 'JOIN lifelog_episodes_fts f ON f.rowid = e.id';
        where.push('lifelog_episodes_fts MATCH ?');
        args.push(ftsQuery(q));
    }
    const dir = order == null || order === '' ? (day ? 'ASC' : 'DESC') : validate.oneOf(bad, String(order).toLowerCase(), 'order', ['asc', 'desc']).toUpperCase();
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM lifelog_episodes e ${join} ${sqlWhere}`).get(...args).n;
    const off = clampOffset(offset);
    const lim = limitOrDefault(limit, 50, LIST_MAX);
    const rows = db.prepare(`SELECT e.* FROM lifelog_episodes e ${join} ${sqlWhere} ORDER BY e.start_at ${dir}, e.id ${dir} LIMIT ? OFFSET ?`).all(...args, lim, off);
    const links = linkCounts(db, rows.map((r) => r.id));
    return { total, offset: off, limit: lim, episodes: rows.map((r) => shapeEpisode(r, links.get(r.id) || 0)) };
}

// One episode with the observations linked to it (oldest first, at most 200). A revision (rev) shows the episode's
// own fields as they were then; links are not part of a revision.
function getEpisode(db, id, { rev } = {}) {
    const row = needEpisode(db, id);
    let base = row;
    if (rev != null && rev !== '' && Number(rev) !== row.current_rev) {
        const r = findRevision(db, REVISIONS, row.id, rev);
        if (!r) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        base = { ...row, ...JSON.parse(r.snapshot), current_rev: r.rev, updated_at: r.at, updated_by: r.actor };
    }
    const obs = db.prepare(`SELECT o.* FROM lifelog_episode_observations l JOIN lifelog_observations o ON o.id = l.observation_id
        WHERE l.episode_id = ? ORDER BY o.at, o.id LIMIT ${MAX_LINK}`).all(row.id);
    const links = linkCounts(db, [row.id]).get(row.id) || 0;
    return { ...shapeEpisode(base, links), revisions: row.current_rev, observations: obs.map(shapeObs) };
}

function history(db, id) {
    const row = needEpisode(db, id);
    return db.prepare('SELECT rev, source, actor, note, at FROM lifelog_episode_revisions WHERE episode_id = ? ORDER BY rev DESC').all(row.id)
        .map((r) => ({ ...r, current: r.rev === row.current_rev }));
}

const noteOf = (given) => (given.note ? String(given.note).slice(0, 200) : null);

function createEpisode(db, input, actor, { now = new Date() } = {}) {
    const given = input || {};
    const t = build(db, given, {}, { now });
    return db.transaction(() => {
        const at = stamp();
        const id = Number(db.prepare(`INSERT INTO lifelog_episodes (${FIELDS.join(', ')}, local_date, current_rev, created_at, updated_at, updated_by)
            VALUES (${FIELDS.map((k) => `@${k}`).join(', ')}, @local_date, 0, @at, @at, @actor)`)
            .run({ ...t, local_date: localDate(db, t.start_at), at, actor: who(actor) }).lastInsertRowid);
        write(db, id, t); // place_id
        return { status: 'created', id, kind: t.kind, rev: commit(db, id, { source: 'create', actor, note: noteOf(given) }) };
    })();
}

// Changes the fields sent; a field sent as null is cleared (title and start_at refuse that).
function updateEpisode(db, id, input, actor, { now = new Date() } = {}) {
    const given = input || {};
    return db.transaction(() => {
        const row = needEpisode(db, id);
        if (!Object.keys(given).some((k) => FIELDS.includes(k))) throw bad('bad_request', `Send at least one of: ${FIELDS.join(', ')}.`);
        const t = build(db, given, row, { now });
        const was = editable(row);
        const changed = FIELDS.filter((k) => t[k] !== was[k]);
        if (!changed.length) return { status: 'unchanged', id: row.id, kind: row.kind, rev: row.current_rev };
        write(db, row.id, t);
        return { status: 'updated', id: row.id, kind: t.kind, rev: commit(db, row.id, { source: 'edit', actor, note: noteOf(given) }), fields: changed };
    })();
}

function restoreEpisode(db, id, rev, actor) {
    return db.transaction(() => {
        const row = needEpisode(db, id);
        const old = findRevision(db, REVISIONS, row.id, rev);
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const was = build(db, JSON.parse(old.snapshot), {}, { now: new Date(8.64e15) });
        const cur = editable(row);
        const changed = FIELDS.filter((k) => was[k] !== cur[k]);
        if (!changed.length) return { status: 'unchanged', id: row.id, kind: row.kind, rev: row.current_rev };
        write(db, row.id, was);
        return { status: 'updated', id: row.id, kind: was.kind, rev: commit(db, row.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` }), fields: changed };
    })();
}

function cleanIds(v) {
    const list = Array.isArray(v) ? v : v == null ? [] : [v];
    const ids = [...new Set(list.map(toId))];
    if (!list.length || ids.includes(null)) throw bad('bad_request', `observation_ids must be a list of 1 to ${MAX_LINK} observation ids.`);
    if (ids.length > MAX_LINK) throw bad('bad_request', `At most ${MAX_LINK} observation ids per call.`);
    return ids;
}

// Links observations to an episode (ones already linked are left as they are). An unknown id is a 404.
function link(db, id, observationIds, actor) {
    const ids = cleanIds(observationIds);
    return db.transaction(() => {
        const ep = needEpisode(db, id);
        const has = db.prepare('SELECT 1 FROM lifelog_observations WHERE id = ?');
        const missing = ids.find((o) => !has.get(o));
        if (missing) throw bad('no_observation', `There is no observation ${missing}.`, 404);
        const ins = db.prepare('INSERT OR IGNORE INTO lifelog_episode_observations (episode_id, observation_id) VALUES (?, ?)');
        const n = ids.reduce((sum, o) => sum + ins.run(ep.id, o).changes, 0);
        if (n) db.prepare('UPDATE lifelog_episodes SET updated_at = ?, updated_by = ? WHERE id = ?').run(stamp(), who(actor), ep.id);
        return { status: n ? 'linked' : 'unchanged', id: ep.id, kind: ep.kind, linked: n };
    })();
}

// Takes observations off an episode; the observations stay. Ids that are not linked are ignored.
function unlink(db, id, observationIds, actor) {
    const ids = cleanIds(observationIds);
    return db.transaction(() => {
        const ep = needEpisode(db, id);
        const del = db.prepare('DELETE FROM lifelog_episode_observations WHERE episode_id = ? AND observation_id = ?');
        const n = ids.reduce((sum, o) => sum + del.run(ep.id, o).changes, 0);
        if (n) db.prepare('UPDATE lifelog_episodes SET updated_at = ?, updated_by = ? WHERE id = ?').run(stamp(), who(actor), ep.id);
        return { status: n ? 'unlinked' : 'unchanged', id: ep.id, kind: ep.kind, unlinked: n };
    })();
}

/* ---------- day, sources, stats ---------- */

// One local date: its episodes (oldest first) and what was observed: counts by source and by kind, first and last time.
function day(db, date) {
    const d = cleanDate(date, 'date');
    const rows = db.prepare('SELECT * FROM lifelog_episodes WHERE local_date = ? ORDER BY start_at, id').all(d);
    const links = linkCounts(db, rows.map((r) => r.id));
    const span = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM lifelog_observations WHERE local_date = ?').get(d);
    const by = (col) => db.prepare(`SELECT COALESCE(${col}, '') AS k, COUNT(*) AS n FROM lifelog_observations WHERE local_date = ? GROUP BY ${col} ORDER BY n DESC, k`).all(d)
        .map((r) => ({ [col]: r.k || null, count: r.n }));
    return {
        date: d,
        timezone: hubTz(db),
        episodes: rows.map((r) => shapeEpisode(r, links.get(r.id) || 0)),
        observations: { count: span.n, first_at: span.first || null, last_at: span.last || null, by_source: by('source'), by_kind: by('kind') },
    };
}

// The sources, from the rows themselves: label, count, first and last seen.
function sources(db) {
    return db.prepare(`SELECT source AS label, COUNT(*) AS count, MIN(at) AS first_seen, MAX(at) AS last_seen
        FROM lifelog_observations GROUP BY source ORDER BY last_seen DESC, label`).all();
}

// Counts and approximate size (text and data bytes), for the dashboard and the Overview tile. Never content.
function stats(db) {
    const o = db.prepare(`SELECT COUNT(*) AS n, MIN(at) AS oldest, MAX(at) AS newest, MAX(created_at) AS last,
        COALESCE(SUM(length(CAST(text AS BLOB)) + COALESCE(length(data), 0) + COALESCE(length(tags), 0)), 0) AS bytes,
        COUNT(DISTINCT source) AS sources FROM lifelog_observations`).get();
    const e = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM lifelog_episodes').get();
    const links = db.prepare('SELECT COUNT(*) AS n FROM lifelog_episode_observations').get().n;
    const last = [o.last, e.last].filter(Boolean).sort().pop() || null;
    return {
        records: o.n, label: o.n === 1 ? 'observation' : 'observations', lastChange: last,
        observations: o.n, episodes: e.n, links, sources: o.sources,
        approx_bytes: o.bytes, oldest: o.oldest || null, newest: o.newest || null,
    };
}

/* ---------- forget a time range (admin only: never /hub or MCP) ---------- */

function forgetPlan(db, input) {
    const given = input || {};
    if (given.from == null || given.from === '' || given.to == null || given.to === '') throw bad('bad_range', 'Send from and to (dates or times).');
    const { lo, hi } = bounds(db, given.from, given.to);
    const source = given.source == null || given.source === '' ? null : plain(given.source, 'source', 60);
    const obsWhere = `at >= @lo AND at <= @hi${source ? ' AND source = @source' : ''}`;
    const epWhere = `start_at >= @lo AND COALESCE(end_at, start_at) <= @hi${source ? ' AND source = @source' : ''}`;
    const p = { lo, hi, source };
    const n = (sql) => db.prepare(sql).get(p).n;
    return {
        p, obsWhere, epWhere,
        preview: {
            from: lo, to: hi, source,
            counts: {
                observations: n(`SELECT COUNT(*) AS n FROM lifelog_observations WHERE ${obsWhere}`),
                episodes: n(`SELECT COUNT(*) AS n FROM lifelog_episodes WHERE ${epWhere}`),
                links: n(`SELECT COUNT(*) AS n FROM lifelog_episode_observations WHERE observation_id IN (SELECT id FROM lifelog_observations WHERE ${obsWhere})
                    OR episode_id IN (SELECT id FROM lifelog_episodes WHERE ${epWhere})`),
            },
        },
    };
}

// What forget would remove: { from, to (the UTC bounds), source, counts: { observations, episodes, links } }.
const forgetPreview = (db, input) => forgetPlan(db, input).preview;

// Body { from, to, source?, confirm: true }. One transaction: guard row in, episodes fully inside out, observations
// out (their links go with them), guard row out.
function forget(db, input) {
    needConfirm(bad, input);
    return db.transaction(() => {
        const { p, obsWhere, epWhere, preview } = forgetPlan(db, input);
        db.prepare('INSERT INTO lifelog_forget_guard (id, at) VALUES (1, ?)').run(stamp());
        db.prepare(`DELETE FROM lifelog_episodes WHERE ${epWhere}`).run(p);
        db.prepare(`DELETE FROM lifelog_observations WHERE ${obsWhere}`).run(p);
        db.prepare('DELETE FROM lifelog_forget_guard').run();
        return { status: 'forgotten', ...preview };
    })();
}

/* ---------- audit details: ids, kinds, counts, field names; never text, titles or detail ---------- */

const auditDetail = (r) => {
    const out = { id: r.id };
    if (r.kind) out.kind = r.kind;
    if (r.rev != null) out.rev = r.rev;
    if (r.fields) out.fields = r.fields;
    if (r.linked != null) out.linked = r.linked;
    if (r.unlinked != null) out.unlinked = r.unlinked;
    if (r.source) out.source = r.source;
    return out;
};
const pushAuditDetail = (r) => ({ sources: r.sources.slice(0, 10), accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected.length });
const forgetAuditDetail = (r) => ({ from: r.from, to: r.to, ...(r.source ? { source: r.source } : {}), ...r.counts });

module.exports = {
    LifelogError, MAX_BATCH, LIST_MAX, FIELDS, STATUSES,
    push, addObservation, listObservations,
    listEpisodes, getEpisode, history, createEpisode, updateEpisode, restoreEpisode, link, unlink,
    day, sources, stats, forgetPreview, forget,
    auditDetail, pushAuditDetail, forgetAuditDetail,
    bounds, startOfDay,
};
