// Links between records of any two domains. A link is stored once (from -> to, with a short relation word and an
// optional note) and shown from both ends. Endpoints are { domain, id }; each domain has a describe() that says whether
// the record exists and gives a title (the same safe text search shows: no references, amounts or addresses).
// A caller only sees and makes links between domains it may read (`visible`; null = all).
const domains = require('./domains');
const { HubError } = require('./errors');

class LinkError extends HubError {}
const bad = (code, message, status = 400) => new LinkError(status, code, message);

const REL_RE = /^[a-z][a-z0-9_-]{0,29}$/;
const LIST_MAX = 100;
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// domain -> (db, id string) -> { title, date?, kind? } | null
const DESCRIBE = {
    digests(db, id) {
        const m = /^(daily|weekly)\/(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2})$/.exec(id);
        if (!m) return null;
        const r = db.prepare('SELECT kind, period FROM digests WHERE kind = ? AND period = ?').get(m[1], m[2]);
        return r ? { title: `${r.kind === 'weekly' ? 'Weekly' : 'Daily'} digest ${r.period}`, date: r.kind === 'daily' ? r.period : undefined, kind: r.kind } : null;
    },
    deadlines: (db, id) => { const r = db.prepare('SELECT title, due_date, kind FROM deadlines WHERE id = ?').get(id); return r && { title: r.title, date: r.due_date, kind: r.kind }; },
    preferences: (db, id) => { const r = db.prepare('SELECT area, "key" AS k FROM preferences WHERE id = ? AND removed_at IS NULL').get(id); return r && { title: `${r.area}: ${r.k}`, kind: r.area }; },
    places: (db, id) => { const r = db.prepare('SELECT label, kind FROM places WHERE id = ?').get(id); return r && { title: r.label, kind: r.kind }; },
    flights: (db, id) => { const r = db.prepare('SELECT airline_iata, flight_number, origin_iata, dest_iata, dep_local_date FROM flights WHERE id = ?').get(id); return r && { title: `${r.airline_iata} ${r.flight_number} ${r.origin_iata} to ${r.dest_iata}`, date: r.dep_local_date }; },
    trips: (db, id) => { const r = db.prepare('SELECT title, start_date, kind FROM trips WHERE id = ?').get(id); return r && { title: r.title, date: r.start_date || undefined, kind: r.kind }; },
    lifelog: (db, id) => { const r = db.prepare('SELECT title, local_date, kind FROM lifelog_episodes WHERE id = ?').get(id); return r && { title: r.title, date: r.local_date, kind: r.kind }; },
    entities: (db, id) => { const r = db.prepare('SELECT name, kind FROM entities WHERE id = ?').get(id); return r && { title: r.name, kind: r.kind }; },
    // Titles only, never the body. A note in the trash does not exist for links.
    notes: (db, id) => { const r = db.prepare('SELECT title, kind, updated_at FROM notes WHERE id = ? AND removed_at IS NULL').get(id); return r && { title: r.title, kind: r.kind, date: r.updated_at.slice(0, 10) }; },
    portfolio(db, id) {
        const path = require('path');
        const { readJson } = require('../routes/portfolio/freshJson');
        const data = readJson(path.join(__dirname, '..', 'routes', 'portfolio', 'atit', 'atit.json'));
        const e = (Array.isArray(data.portfolio) ? data.portfolio : []).find((x) => String(x.id) === id);
        return e ? { title: e.title || '', date: e.date ? String(e.date) : undefined } : null;
    },
};
// A domain added later can add itself here with register().
const register = (name, fn) => { DESCRIBE[name] = fn; };
const linkable = () => Object.keys(DESCRIBE).filter((n) => domains.exists(n));

function endpoint(db, ref, what) {
    if (!ref || typeof ref !== 'object') throw bad('bad_request', `${what} must be { domain, id }.`);
    const domain = String(ref.domain || '');
    if (!DESCRIBE[domain] || !domains.exists(domain)) throw bad('bad_domain', `${what}: domain must be one of ${linkable().join(', ')}.`);
    const id = String(ref.id == null ? '' : ref.id).trim();
    if (!id || id.length > 40) throw bad('bad_request', `${what}: give the record id.`);
    let d = null;
    try { d = DESCRIBE[domain](db, id); } catch (e) { d = null; }
    if (!d) throw bad('not_found', `${what}: there is no ${domain} record ${id.slice(0, 40)}.`, 404);
    return { domain, id, ...d, title: clip(d.title, 140) };
}

const sees = (visible, domain) => !visible || visible.includes(domain);

// A link from a to b (both must be readable by the caller). Same pair and relation, in either direction, is a duplicate.
function add(db, input, actor, { visible = null } = {}) {
    const given = input || {};
    const a = endpoint(db, given.from, 'from');
    const b = endpoint(db, given.to, 'to');
    if (a.domain === b.domain && a.id === b.id) throw bad('bad_request', 'A record cannot be linked to itself.');
    for (const e of [a, b]) if (!sees(visible, e.domain)) throw bad('not_allowed', `This key cannot read ${e.domain}, so it cannot link it.`, 403);
    const rel = given.rel == null || given.rel === '' ? 'related' : String(given.rel).trim().toLowerCase();
    if (!REL_RE.test(rel)) throw bad('bad_rel', 'rel is a short lowercase word such as for, about, during or related.');
    const note = given.note == null || given.note === '' ? null : clip(given.note, 200);
    return db.transaction(() => {
        const dup = db.prepare(`SELECT id FROM links WHERE rel = ? AND ((from_domain = ? AND from_id = ? AND to_domain = ? AND to_id = ?)
            OR (from_domain = ? AND from_id = ? AND to_domain = ? AND to_id = ?))`).get(rel, a.domain, a.id, b.domain, b.id, b.domain, b.id, a.domain, a.id);
        if (dup) return { status: 'exists', id: dup.id };
        const id = Number(db.prepare('INSERT INTO links (from_domain, from_id, to_domain, to_id, rel, note, created_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(a.domain, a.id, b.domain, b.id, rel, note, new Date().toISOString(), String(actor || 'unknown')).lastInsertRowid);
        return { status: 'created', id, from: `${a.domain}:${a.id}`, to: `${b.domain}:${b.id}`, rel };
    })();
}

// Removes one link; `visible` limits it to links whose two ends the caller can read.
function remove(db, linkId, { visible = null } = {}) {
    const id = Number(linkId);
    const row = Number.isInteger(id) && id > 0 ? db.prepare('SELECT * FROM links WHERE id = ?').get(id) : null;
    if (!row) throw bad('not_found', `There is no link ${String(linkId).slice(0, 20)}.`, 404);
    if (!sees(visible, row.from_domain) || !sees(visible, row.to_domain)) throw bad('not_allowed', 'This key cannot read both ends of that link.', 403);
    db.prepare('DELETE FROM links WHERE id = ?').run(id);
    return { status: 'removed', id, from: `${row.from_domain}:${row.from_id}`, to: `${row.to_domain}:${row.to_id}`, rel: row.rel };
}

// The links of one record, newest first, each with the other end described. Links to domains the caller cannot read
// are counted in `hidden`, not shown.
function listFor(db, domain, id, { visible = null, limit = LIST_MAX } = {}) {
    const self = endpoint(db, { domain, id }, 'record');
    const rows = db.prepare(`SELECT * FROM links WHERE (from_domain = ? AND from_id = ?) OR (to_domain = ? AND to_id = ?) ORDER BY id DESC LIMIT ?`)
        .all(self.domain, self.id, self.domain, self.id, Math.min(Math.max(Number(limit) || LIST_MAX, 1), LIST_MAX));
    const out = [];
    let hidden = 0;
    for (const r of rows) {
        const mine = r.from_domain === self.domain && r.from_id === self.id;
        const od = mine ? r.to_domain : r.from_domain;
        const oi = mine ? r.to_id : r.from_id;
        if (!sees(visible, od) || !domains.isEnabled(db, od)) { hidden += 1; continue; }
        let d = null;
        try { d = DESCRIBE[od] ? DESCRIBE[od](db, oi) : null; } catch (e) { d = null; }
        if (!d) { hidden += 1; continue; }
        out.push({ link_id: r.id, rel: r.rel, note: r.note, direction: mine ? 'out' : 'in', created_at: r.created_at, other: { domain: od, id: oi, title: clip(d.title, 140), ...(d.date ? { date: d.date } : {}), ...(d.kind ? { kind: d.kind } : {}) } });
    }
    return { record: { domain: self.domain, id: self.id, title: self.title }, links: out, hidden };
}

const stats = (db) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM links').get().n;
    const last = db.prepare('SELECT MAX(created_at) AS at FROM links').get().at;
    return { records: n, label: n === 1 ? 'link' : 'links', lastChange: last };
};

const auditDetail = (r) => ({ id: r.id, from: r.from, to: r.to, rel: r.rel });

module.exports = { add, remove, listFor, stats, auditDetail, register, linkable, LinkError, DESCRIBE, REL_RE, LIST_MAX };
