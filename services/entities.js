// Entities: the people, projects, organizations and topics other records can point at through links. A link to
// "Mira" is a link to the entity, so everything about that person is one click away from any record.
//
// MODEL (migration 022)
//   entities          one row per (kind, name), names compared without regard to case. aliases is a JSON array of up to
//                     10 other names ("MD", "Mira D."); notes is free text.
//   entity_revisions  every change stores kind, name, aliases and notes as a new revision (rev 1 = as first filed, never
//                     rewritten); restore puts an entity back to an earlier revision as a new revision.
//
// PRIVACY: names, aliases and notes are content (a person's name is personal data). They never appear in audit rows or in
// error messages; audit detail is id, kind, rev and field NAMES only. Deleting is permanent and admin-only (never on
// /hub or MCP); the links of a deleted entity go with it through a trigger (migration 022).
const { HubError } = require('./errors');
const validate = require('./lib/validate');
const { needRow, commitRevision, findRevision } = require('./lib/revisions');
const { limitOrDefault, clampOffset } = require('./lib/listing');
const { needConfirm, count } = require('./lib/remove');
const { toId } = validate;

const KINDS = ['person', 'project', 'organization', 'topic', 'other'];
const FIELDS = ['kind', 'name', 'aliases', 'notes'];
const LIST_MAX = 200;
const ALIAS_MAX = 10;
const ALIAS_LEN = 60;

class EntityError extends HubError {
    constructor(status, code, message, extra) {
        super(status, code, message);
        if (extra) this.extra = extra;
    }
}

const bad = (code, message, status = 400, extra) => new EntityError(status, code, message, extra);
const REVISIONS = { table: 'entities', revTable: 'entity_revisions', fk: 'entity_id' };
const stamp = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');

/* ---------- cleaning ---------- */

const text = (v, name, max, o) => validate.text(bad, v, name, max, { field: true, ...o });

// A list of alias names from an array or comma-separated text: tidy, no duplicates (any case), no blanks, no copy of the name.
function cleanAliases(v, name) {
    if (v == null || v === '') return [];
    const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
    if (!parts) throw bad('bad_aliases', 'aliases must be a list of names.', 400, { field: 'aliases' });
    const out = [];
    for (const p of parts) {
        const a = text(p, 'each alias', ALIAS_LEN, { collapse: true });
        if (!a) continue;
        if (name && a.toLowerCase() === name.toLowerCase()) continue;
        if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
    }
    if (out.length > ALIAS_MAX) throw bad('bad_aliases', `At most ${ALIAS_MAX} aliases.`, 400, { field: 'aliases' });
    return out;
}

function build(input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k) && k !== 'note') throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const f = {};
    const kind = pick('kind');
    if (!KINDS.includes(kind)) throw bad('bad_kind', `kind must be one of: ${KINDS.join(', ')}.`, 400, { field: 'kind' });
    f.kind = kind;
    f.name = text(pick('name'), 'name', 120, { collapse: true });
    if (!f.name) throw bad('bad_name', 'name is required (1 to 120 characters).', 400, { field: 'name' });
    const raw = pick('aliases');
    f.aliases = cleanAliases(typeof raw === 'string' && raw.trim().startsWith('[') ? safeJson(raw) : raw, f.name);
    f.notes = text(pick('notes'), 'notes', 2000);
    return f;
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return s; } }

// The editable fields as stored in a revision (aliases as a real array).
const editable = (row) => ({
    kind: row.kind, name: row.name, aliases: parseAliases(row.aliases), notes: row.notes == null ? null : row.notes,
});
const parseAliases = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const same = (k, a, b) => (k === 'aliases' ? JSON.stringify(a) === JSON.stringify(b) : a === b);

const need = (db, id) => needRow(db, 'entities', id, () => bad('not_found', `There is no entity ${String(id).slice(0, 20)}.`, 404));

const linkCount = (db, id) => count(db, `SELECT COUNT(*) AS n FROM links WHERE (from_domain = 'entities' AND from_id = ?) OR (to_domain = 'entities' AND to_id = ?)`, String(id), String(id));

function write(db, id, f) {
    try {
        db.prepare('UPDATE entities SET kind = @kind, name = @name, aliases = @aliases, notes = @notes WHERE id = @id')
            .run({ ...f, aliases: JSON.stringify(f.aliases), id });
    } catch (err) {
        if (/UNIQUE/.test(String(err.message))) {
            const other = db.prepare('SELECT id FROM entities WHERE kind = ? AND name = ? COLLATE NOCASE').get(f.kind, f.name);
            throw bad('exists', `There is already a ${f.kind} with that name.`, 409, { id: other ? other.id : undefined });
        }
        throw err;
    }
}

const commit = (db, id, meta) => commitRevision(db, REVISIONS, id, meta, editable);

/* ---------- shape and reads ---------- */

function shape(row, links) {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        aliases: parseAliases(row.aliases),
        notes: row.notes || null,
        ...(links == null ? {} : { link_count: links }),
        rev: row.current_rev,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    };
}

const cleanLimit = (v, def) => limitOrDefault(v, def, LIST_MAX);

// Filters: kind, q (a piece of the name, an alias or the notes). Each row carries its link count.
function list(db, { kind, q, limit, offset } = {}) {
    const where = [];
    const args = {};
    if (kind != null && kind !== '') {
        if (!KINDS.includes(kind)) throw bad('bad_kind', `kind must be one of: ${KINDS.join(', ')}.`, 400, { field: 'kind' });
        where.push('kind = @kind');
        args.kind = kind;
    }
    if (typeof q === 'string' && q.trim()) {
        args.q = `%${q.trim().slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push("(name LIKE @q ESCAPE '\\' OR aliases LIKE @q ESCAPE '\\' OR notes LIKE @q ESCAPE '\\')");
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM entities ${clause}`).get(args).n;
    const off = clampOffset(offset);
    const lim = cleanLimit(limit, LIST_MAX);
    const order = `CASE kind ${KINDS.map((a, i) => `WHEN '${a}' THEN ${i}`).join(' ')} END`;
    const rows = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM links l WHERE (l.from_domain = 'entities' AND l.from_id = CAST(e.id AS TEXT))
        OR (l.to_domain = 'entities' AND l.to_id = CAST(e.id AS TEXT))) AS link_count FROM (SELECT * FROM entities ${clause}) e
        ORDER BY ${order}, name COLLATE NOCASE, id LIMIT @lim OFFSET @off`).all({ ...args, lim, off });
    return { total, offset: off, limit: lim, entities: rows.map((r) => shape(r, r.link_count)) };
}

// A revision (rev) shows the entity as it was then.
function get(db, id, { rev } = {}) {
    const row = need(db, id);
    const n = linkCount(db, row.id);
    if (rev == null || rev === '' || Number(rev) === row.current_rev) return { ...shape(row, n), revisions: row.current_rev };
    const r = findRevision(db, REVISIONS, row.id, rev);
    if (!r) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
    const snap = JSON.parse(r.snapshot);
    return { ...shape({ ...row, ...snap, aliases: JSON.stringify(snap.aliases || []), current_rev: r.rev, updated_at: r.at, updated_by: r.actor }, n), revisions: row.current_rev };
}

// Names and aliases that equal `name` (any case): "Mira" resolves to its entity, or to several when kinds differ.
function find(db, name, { kind } = {}) {
    const n = text(name, 'name', 120, { collapse: true });
    if (!n) throw bad('bad_name', 'name is required.', 400, { field: 'name' });
    const rows = db.prepare(`SELECT * FROM entities WHERE (name = @n COLLATE NOCASE OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE value = @n COLLATE NOCASE))
        ${kind ? 'AND kind = @kind' : ''} ORDER BY id LIMIT 20`).all({ n, ...(kind ? { kind } : {}) });
    return { count: rows.length, entities: rows.map((r) => shape(r)) };
}

// Newest first; what changed is read with get(id, { rev }). Revision rows carry no field values.
function history(db, id) {
    const row = need(db, id);
    return db.prepare('SELECT rev, source, actor, note, at FROM entity_revisions WHERE entity_id = ? ORDER BY rev DESC').all(row.id)
        .map((r) => ({ ...r, current: r.rev === row.current_rev }));
}

function stats(db) {
    const r = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM entities').get();
    return { records: r.n, label: r.n === 1 ? 'entity' : 'entities', lastChange: r.last || null };
}

/* ---------- writes ---------- */

// What an audit row may say: id, kind, rev and the NAMES of the fields that changed. Never the name, aliases or notes.
const auditDetail = (r) => ({ id: r.id, kind: r.kind, rev: r.rev, ...(r.fields ? { fields: r.fields } : {}) });

function create(db, input, actor) {
    const f = build(input);
    return db.transaction(() => {
        const at = stamp();
        let id;
        try {
            id = Number(db.prepare(`INSERT INTO entities (kind, name, aliases, notes, current_rev, created_at, updated_at, updated_by)
                VALUES (@kind, @name, @aliases, @notes, 0, @at, @at, @actor)`).run({ ...f, aliases: JSON.stringify(f.aliases), at, actor: who(actor) }).lastInsertRowid);
        } catch (err) {
            if (!/UNIQUE/.test(String(err.message))) throw err;
            const other = db.prepare('SELECT id FROM entities WHERE kind = ? AND name = ? COLLATE NOCASE').get(f.kind, f.name);
            throw bad('exists', `There is already a ${f.kind} with that name.`, 409, { id: other ? other.id : undefined });
        }
        return { status: 'created', id, kind: f.kind, rev: commit(db, id, { source: 'create', actor }) };
    })();
}

function update(db, id, input, actor) {
    const given = input || {};
    if (!Object.keys(given).some((k) => FIELDS.includes(k))) throw bad('bad_request', `Send at least one of: ${FIELDS.join(', ')}.`);
    return db.transaction(() => {
        const row = need(db, id);
        const f = build(given, editable(row));
        const was = editable(row);
        const changed = FIELDS.filter((k) => !same(k, f[k], was[k]));
        if (!changed.length) return { status: 'unchanged', id: row.id, kind: row.kind, rev: row.current_rev };
        write(db, row.id, f);
        const rev = commit(db, row.id, { source: 'edit', actor, note: given.note ? String(given.note).slice(0, 200) : null });
        return { status: 'updated', id: row.id, kind: f.kind, rev, fields: changed };
    })();
}

// Puts the entity back to how it was at `rev` (default: as it is now).
function restore(db, id, rev, actor) {
    return db.transaction(() => {
        const row = need(db, id);
        const target = rev == null || rev === '' ? row.current_rev : toId(rev);
        const old = target && findRevision(db, REVISIONS, row.id, target);
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const was = build(JSON.parse(old.snapshot));
        const now = editable(row);
        const changed = FIELDS.filter((k) => !same(k, was[k], now[k]));
        if (!changed.length) return { status: 'unchanged', id: row.id, kind: row.kind, rev: row.current_rev };
        write(db, row.id, was);
        return { status: 'updated', id: row.id, kind: was.kind, rev: commit(db, row.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` }), fields: changed };
    })();
}

/* ---------- permanent delete (admin only: never on /hub or MCP) ---------- */

// The links the entity has (they go with it) and its revisions. The name is only in the preview shown to the person
// at the dashboard; the audit row never has it.
function removalPreview(db, id) {
    const e = need(db, id);
    return {
        id: e.id, kind: e.kind, label: e.name,
        counts: { links: linkCount(db, e.id), revisions: count(db, 'SELECT COUNT(*) AS n FROM entity_revisions WHERE entity_id = ?', e.id) },
    };
}

function remove(db, id, input) {
    needConfirm(bad, input);
    return db.transaction(() => {
        const pre = removalPreview(db, id);
        db.prepare('DELETE FROM entities WHERE id = ?').run(pre.id);
        return { status: 'deleted', ...pre };
    })();
}

const removedAuditDetail = (r) => ({ id: r.id, kind: r.kind, ...r.counts });

module.exports = {
    removalPreview, remove, removedAuditDetail,
    EntityError, KINDS, FIELDS, LIST_MAX, ALIAS_MAX,
    shape, list, get, find, history, stats, create, update, restore, auditDetail,
};
