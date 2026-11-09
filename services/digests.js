// Digests: dated narratives of Atit's days and weeks. Every change adds a revision; revision 1 is never
// touched, so a human edit can always be compared with what was generated.
const PERIOD_RE = {
    daily: /^\d{4}-\d{2}-\d{2}$/,   // 2026-11-08, the local (America/Chicago) date
    weekly: /^\d{4}-W\d{2}$/,       // 2026-W45
};
const MAX_BODY = 64 * 1024;
const MAX_META = 4 * 1024;
const HUMAN = new Set(['edit', 'restore']);
const SOURCES = new Set(['generated', 'import']);

class DigestError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function check(kind, period) {
    if (!Object.prototype.hasOwnProperty.call(PERIOD_RE, kind)) {
        throw new DigestError(400, 'bad_kind', `Kind must be one of: ${Object.keys(PERIOD_RE).join(', ')}.`);
    }
    if (!PERIOD_RE[kind].test(String(period))) {
        throw new DigestError(400, 'bad_period', `A ${kind} period looks like ${kind === 'daily' ? '2026-11-08' : '2026-W45'}.`);
    }
    if (kind === 'daily' && Number.isNaN(Date.parse(`${period}T00:00:00Z`))) {
        throw new DigestError(400, 'bad_period', `${period} is not a real date.`);
    }
}

// Digest files start with "# <date>"; the title is shown from the period, so it is not part of the body.
function cleanBody(body) {
    if (typeof body !== 'string') throw new DigestError(400, 'bad_body', 'A text body is required.');
    const text = body.replace(/\r\n/g, '\n').replace(/^# .*\n+/, '').trim();
    if (!text) throw new DigestError(400, 'bad_body', 'The body is empty.');
    if (Buffer.byteLength(text) > MAX_BODY) throw new DigestError(413, 'too_large', 'The body is over 64 KB.');
    return text;
}

function cleanMeta(meta) {
    if (meta == null) return null;
    const json = JSON.stringify(meta);
    if (typeof meta !== 'object' || Array.isArray(meta)) throw new DigestError(400, 'bad_meta', 'meta must be an object.');
    if (json.length > MAX_META) throw new DigestError(413, 'too_large', 'meta is over 4 KB.');
    return json;
}

const row = (db, kind, period) => db.prepare('SELECT * FROM digests WHERE kind = ? AND period = ?').get(kind, period);
const revision = (db, id, rev) => db.prepare('SELECT * FROM digest_revisions WHERE digest_id = ? AND rev = ?').get(id, rev);

function index(db, id, body) {
    db.prepare('DELETE FROM digest_search WHERE rowid = ?').run(id);
    db.prepare('INSERT INTO digest_search (rowid, body) VALUES (?, ?)').run(id, body);
}

function shape(d, r, revisions) {
    return {
        kind: d.kind,
        period: d.period,
        rev: r.rev,
        body: r.body,
        source: r.source,
        actor: r.actor,
        model: r.model,
        note: r.note,
        meta: r.meta ? JSON.parse(r.meta) : null,
        revisedAt: r.at,
        createdAt: d.created_at,
        revisions,
    };
}

function addRevision(db, d, { body, source, actor, model, note, meta }) {
    const rev = d.current_rev + 1;
    const at = new Date().toISOString();
    db.prepare('INSERT INTO digest_revisions (digest_id, rev, body, source, actor, model, note, meta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(d.id, rev, body, source, actor, model || null, note || null, meta, at);
    db.prepare('UPDATE digests SET current_rev = ?, updated_at = ? WHERE id = ?').run(rev, at, d.id);
    index(db, d.id, body);
    return rev;
}

// The nightly job and the importer. Safe to repeat. A revision made by a human is never replaced by
// generated text unless force is set.
function put(db, kind, period, { body, source = 'generated', actor, model, meta, force = false }) {
    check(kind, period);
    if (!SOURCES.has(source)) throw new DigestError(400, 'bad_source', 'source must be generated or import.');
    const text = cleanBody(body);
    const metaJson = cleanMeta(meta);

    return db.transaction(() => {
        const existing = row(db, kind, period);
        if (!existing) {
            const at = new Date().toISOString();
            const id = Number(db.prepare('INSERT INTO digests (kind, period, current_rev, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
                .run(kind, period, at, at).lastInsertRowid);
            db.prepare('INSERT INTO digest_revisions (digest_id, rev, body, source, actor, model, note, meta, at) VALUES (?, 1, ?, ?, ?, ?, NULL, ?, ?)')
                .run(id, text, source, actor, model || null, metaJson, at);
            index(db, id, text);
            return { status: 'created', rev: 1 };
        }
        const current = revision(db, existing.id, existing.current_rev);
        if (current.body === text) return { status: 'unchanged', rev: current.rev };
        if (HUMAN.has(current.source) && !force) {
            throw new DigestError(409, 'edited', `The ${kind} digest for ${period} has been edited by hand. Send force to replace it.`);
        }
        return { status: 'updated', rev: addRevision(db, existing, { body: text, source, actor, model, meta: metaJson }) };
    })();
}

// A human edit.
function edit(db, kind, period, { body, actor, note }) {
    check(kind, period);
    const text = cleanBody(body);
    return db.transaction(() => {
        const d = row(db, kind, period);
        if (!d) throw new DigestError(404, 'not_found', `No ${kind} digest for ${period}.`);
        const current = revision(db, d.id, d.current_rev);
        if (current.body === text) return { status: 'unchanged', rev: current.rev };
        return { status: 'updated', rev: addRevision(db, d, { body: text, source: 'edit', actor, note: note ? String(note).slice(0, 200) : null }) };
    })();
}

function restore(db, kind, period, rev, actor) {
    check(kind, period);
    return db.transaction(() => {
        const d = row(db, kind, period);
        if (!d) throw new DigestError(404, 'not_found', `No ${kind} digest for ${period}.`);
        const old = revision(db, d.id, Number(rev));
        if (!old) throw new DigestError(404, 'no_revision', `Revision ${rev} does not exist.`);
        const current = revision(db, d.id, d.current_rev);
        if (current.body === old.body) return { status: 'unchanged', rev: current.rev };
        return { status: 'updated', rev: addRevision(db, d, { body: old.body, source: 'restore', actor, note: `Restored revision ${old.rev}` }) };
    })();
}

function get(db, kind, period, { rev } = {}) {
    check(kind, period);
    const d = row(db, kind, period);
    if (!d) throw new DigestError(404, 'not_found', `No ${kind} digest for ${period}.`);
    const wanted = rev == null || rev === '' ? d.current_rev : Number(rev);
    const r = revision(db, d.id, wanted);
    if (!r) throw new DigestError(404, 'no_revision', `Revision ${rev} does not exist.`);
    return shape(d, r, d.current_rev);
}

function latest(db, kind) {
    check(kind, kind === 'daily' ? '2000-01-01' : '2000-W01');
    const d = db.prepare('SELECT * FROM digests WHERE kind = ? ORDER BY period DESC LIMIT 1').get(kind);
    if (!d) throw new DigestError(404, 'not_found', `There is no ${kind} digest yet.`);
    return shape(d, revision(db, d.id, d.current_rev), d.current_rev);
}

function revisions(db, kind, period) {
    check(kind, period);
    const d = row(db, kind, period);
    if (!d) throw new DigestError(404, 'not_found', `No ${kind} digest for ${period}.`);
    return db.prepare('SELECT rev, source, actor, model, note, at, length(body) AS chars FROM digest_revisions WHERE digest_id = ? ORDER BY rev DESC').all(d.id)
        .map((r) => ({ ...r, current: r.rev === d.current_rev }));
}

// Newest first. Without a body, so lists stay small.
function list(db, { kind, from, to, limit = 50, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (kind) { check(kind, kind === 'daily' ? '2000-01-01' : '2000-W01'); where.push('d.kind = ?'); args.push(kind); }
    if (from) { where.push('d.period >= ?'); args.push(String(from)); }
    if (to) { where.push('d.period <= ?'); args.push(String(to)); }
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const o = Math.max(parseInt(offset, 10) || 0, 0);
    const sql = `SELECT d.kind, d.period, d.current_rev AS rev, r.source, r.actor, r.model, r.meta, r.at AS revisedAt, length(r.body) AS chars
                 FROM digests d JOIN digest_revisions r ON r.digest_id = d.id AND r.rev = d.current_rev
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.period DESC, d.kind LIMIT ? OFFSET ?`;
    return db.prepare(sql).all(...args, n, o).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
}

// The newest `count` digests of a kind with their text, for agents and the weekly review.
function recent(db, kind, count = 7) {
    const items = list(db, { kind, limit: Math.min(Math.max(parseInt(count, 10) || 7, 1), 31) });
    return items.map((i) => get(db, i.kind, i.period));
}

// Every digest of a kind in [from, to] with its text, oldest first.
function range(db, kind, from, to) {
    return list(db, { kind, from, to, limit: 500 }).reverse().map((i) => get(db, i.kind, i.period));
}

function search(db, q, { kind, limit = 20 } = {}) {
    const terms = String(q || '').match(/[\p{L}\p{N}]+/gu) || [];
    if (terms.length === 0) throw new DigestError(400, 'bad_query', 'Give at least one word to search for.');
    const match = terms.map((t) => `"${t}"`).join(' ');
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const sql = `SELECT d.kind, d.period, snippet(digest_search, 0, '[', ']', '…', 14) AS snippet
                 FROM digest_search JOIN digests d ON d.id = digest_search.rowid
                 WHERE digest_search MATCH ? ${kind ? 'AND d.kind = ?' : ''} ORDER BY rank LIMIT ?`;
    return db.prepare(sql).all(...(kind ? [match, kind, n] : [match, n]));
}

function stats(db) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM digests').get().n;
    const last = db.prepare('SELECT MAX(updated_at) AS at FROM digests').get().at;
    return { records: total, label: total === 1 ? 'digest' : 'digests', lastChange: last };
}

module.exports = { DigestError, put, edit, restore, get, latest, revisions, list, recent, range, search, stats, PERIOD_RE };
