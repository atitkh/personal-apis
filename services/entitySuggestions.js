// The entities review queue: names a job or an agent saw that no entity claims yet. A person accepts one (it becomes an entity, or
// an alias of an existing one) or dismisses it. Agents can only file suggestions; they never create entities from here.
//
// FILING (suggest) is deterministic: a name that already is an entity name or alias (any kind, any case) is not filed, the
// answer says which entity it is; a name already in the queue (any status, dismissed included) only raises its count.
// PRIVACY: names are content. They never appear in audit rows or error messages; audit detail is ids, kind and counts.
const entities = require('./entities');
const { HubError } = require('./errors');
const validate = require('./lib/validate');
const { needRow } = require('./lib/revisions');
const { needConfirm } = require('./lib/remove');
const { limitOrDefault } = require('./lib/listing');

const STATUSES = ['pending', 'accepted', 'dismissed'];
const LIST_MAX = 200;
const bad = (code, message, status = 400, extra) => {
    const e = new entities.EntityError(status, code, message);
    if (extra) e.extra = extra;
    return e;
};
const stamp = () => new Date().toISOString();
const text = (v, name, max, o) => validate.text(bad, v, name, max, { field: true, ...o });
const need = (db, id) => needRow(db, 'entity_suggestions', id, () => bad('not_found', `There is no suggestion ${String(id).slice(0, 20)}.`, 404));

const shape = (r) => ({
    id: r.id, name: r.name, kind: r.kind, example: r.example || null, count: r.count, status: r.status,
    first_seen: r.first_seen, last_seen: r.last_seen, resolved_entity_id: r.resolved_entity_id || null,
    decided_at: r.decided_at || null, decided_by: r.decided_by || null,
});

// Files a name. input { name, kind?, example? }. Returns { status: 'exists', entity } | 'created' | 'seen', suggestion.
function suggest(db, input, actor) {
    const given = input || {};
    const name = text(given.name, 'name', 120, { collapse: true });
    if (!name) throw bad('bad_name', 'name is required.', 400, { field: 'name' });
    const kind = given.kind == null || given.kind === '' ? 'other' : String(given.kind).toLowerCase();
    if (!entities.KINDS.includes(kind)) throw bad('bad_kind', `kind must be one of ${entities.KINDS.join(', ')}.`, 400, { field: 'kind' });
    const example = given.example == null || given.example === '' ? null : text(given.example, 'example', 200, { collapse: true });
    return db.transaction(() => {
        const known = entities.find(db, name);
        if (known.count) {
            const e = known.entities[0];
            return { status: 'exists', entity: { id: e.id, kind: e.kind, name: e.name } };
        }
        const at = stamp();
        const row = db.prepare('SELECT * FROM entity_suggestions WHERE name = ?').get(name);
        if (row) {
            db.prepare('UPDATE entity_suggestions SET count = count + 1, last_seen = ?, example = COALESCE(example, ?) WHERE id = ?').run(at, example, row.id);
            return { status: 'seen', suggestion: shape(db.prepare('SELECT * FROM entity_suggestions WHERE id = ?').get(row.id)) };
        }
        const id = Number(db.prepare('INSERT INTO entity_suggestions (name, kind, example, count, first_seen, last_seen, status, suggested_by) VALUES (?, ?, ?, 1, ?, ?, \'pending\', ?)')
            .run(name, kind, example, at, at, String(actor || 'unknown')).lastInsertRowid);
        return { status: 'created', suggestion: shape(db.prepare('SELECT * FROM entity_suggestions WHERE id = ?').get(id)) };
    })();
}

function list(db, { status = 'pending', limit } = {}) {
    const n = limitOrDefault(limit, 100, LIST_MAX);
    const rows = status === 'all'
        ? db.prepare('SELECT * FROM entity_suggestions ORDER BY last_seen DESC, id DESC LIMIT ?').all(n)
        : db.prepare('SELECT * FROM entity_suggestions WHERE status = ? ORDER BY last_seen DESC, id DESC LIMIT ?').all(STATUSES.includes(status) ? status : 'pending', n);
    return rows.map(shape);
}

function counts(db) {
    const out = { pending: 0, accepted: 0, dismissed: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM entity_suggestions GROUP BY status').all()) out[r.status] = r.n;
    return out;
}

function decide(db, s, status, entityId, actor) {
    db.prepare('UPDATE entity_suggestions SET status = ?, resolved_entity_id = ?, decided_at = ?, decided_by = ? WHERE id = ?')
        .run(status, entityId || null, stamp(), String(actor || 'unknown'), s.id);
    return db.prepare('SELECT * FROM entity_suggestions WHERE id = ?').get(s.id);
}

// Accepts a suggestion: { entity_id } adds the name as an alias of that entity; otherwise { kind, name?, aliases?, notes? }
// creates an entity (the suggested kind and name unless the person changed them). Not allowed twice.
function accept(db, id, input, actor) {
    const given = input || {};
    return db.transaction(() => {
        const s = need(db, id);
        if (s.status === 'accepted') throw bad('already_accepted', 'That suggestion was already accepted.', 409);
        if (given.entity_id != null) {
            const e = entities.get(db, given.entity_id);
            if (e.name.toLowerCase() !== s.name.toLowerCase() && !e.aliases.some((a) => a.toLowerCase() === s.name.toLowerCase())) {
                entities.update(db, e.id, { aliases: [...e.aliases, s.name], note: 'alias from the suggestions queue' }, actor);
            }
            return { status: 'accepted', suggestion: shape(decide(db, s, 'accepted', e.id, actor)), entity: { id: e.id, kind: e.kind, name: e.name }, alias: true };
        }
        const made = entities.create(db, {
            kind: given.kind || s.kind, name: given.name || s.name, aliases: given.aliases, notes: given.notes,
        }, actor);
        const e = entities.get(db, made.id);
        return { status: 'accepted', suggestion: shape(decide(db, s, 'accepted', e.id, actor)), entity: { id: e.id, kind: e.kind, name: e.name }, alias: false };
    })();
}

function dismiss(db, id, actor) {
    return db.transaction(() => {
        const s = need(db, id);
        if (s.status === 'dismissed') return { status: 'unchanged', suggestion: shape(s) };
        return { status: 'dismissed', suggestion: shape(decide(db, s, 'dismissed', null, actor)) };
    })();
}

function dismissAllPending(db, actor) {
    return db.transaction(() => {
        const rows = db.prepare("SELECT * FROM entity_suggestions WHERE status = 'pending'").all();
        for (const s of rows) decide(db, s, 'dismissed', null, actor);
        return { status: rows.length ? 'dismissed' : 'unchanged', count: rows.length };
    })();
}

function remove(db, id, input) {
    needConfirm(bad, input);
    return db.transaction(() => {
        const s = need(db, id);
        db.prepare('DELETE FROM entity_suggestions WHERE id = ?').run(s.id);
        return { status: 'deleted', id: s.id, suggestion_status: s.status };
    })();
}

function removeWhere(db, status, input) {
    needConfirm(bad, input);
    if (![...STATUSES, 'all'].includes(status)) throw bad('bad_request', 'status must be pending, accepted, dismissed or all.');
    return db.transaction(() => {
        const n = (status === 'all' ? db.prepare('DELETE FROM entity_suggestions').run() : db.prepare('DELETE FROM entity_suggestions WHERE status = ?').run(status)).changes;
        return { status: 'deleted', count: n, suggestion_status: status };
    })();
}

// Audit detail: ids, kind and counts only, never a name.
const auditDetail = (r) => {
    if (r.count != null && r.suggestion == null) return { count: r.count, status: r.suggestion_status };
    const s = r.suggestion || {};
    return { suggestion_id: s.id || r.id, kind: s.kind, entity_id: r.entity ? r.entity.id : undefined, status: s.status || r.suggestion_status };
};

module.exports = { suggest, list, counts, accept, dismiss, dismissAllPending, remove, removeWhere, auditDetail, STATUSES, LIST_MAX };
