// Preferences: plain facts about how Atit likes things, grouped by area. Context for agents, not attention, so there
// is no briefing hook.
//
// MODEL (migration 012)
//   preferences          one row per (area, key). key is a slug like airline_seat (lowercase letters, digits and
//                        underscores; spaces and dashes typed by a person become underscores). value is plain text.
//   preference_revisions every change stores area, key, value and notes as a new revision (rev 1 = as first filed,
//                        never rewritten); restore puts an item back to an earlier revision as a new revision.
//
// UNSET is a soft remove: removed_at is stamped, the item leaves lists and keeps its history. Restore (any revision, by
// default the current one) brings it back. Setting the same area and key again also revives it. Nothing is deleted.
//
// PRIVACY: the hub holds facts, not secrets. Keys that name a password-like thing and values (and notes) that look like
// a key, a token or a long number are refused with the same sentence. Audit rows carry id, area and key, never values.
const { HubError } = require('./errors');
const validate = require('./lib/validate');
const { needRow, commitRevision, findRevision } = require('./lib/revisions');
const { limitOrDefault, clampOffset } = require('./lib/listing');
const { needConfirm, count } = require('./lib/remove');
const { toId } = validate;

const AREAS = ['travel', 'communication', 'work', 'food', 'health', 'devices', 'home', 'other'];
const FIELDS = ['area', 'key', 'value', 'notes'];
const LIST_MAX = 200;
const VAULT_SENTENCE = 'Keep passwords, numbers and keys in the vault, not here.';
const KEY_WORDS_BANNED = ['password', 'passcode', 'passwd', 'secret', 'token', 'pin', 'ssn', 'card', 'cards'];
const KEY_SUBSTRINGS_BANNED = ['password', 'passcode', 'passwd', 'secret', 'token'];

class PreferenceError extends HubError {
    constructor(status, code, message, extra) {
        super(status, code, message);
        if (extra) this.extra = extra;
    }
}

const bad = (code, message, status = 400, extra) => new PreferenceError(status, code, message, extra);
const REVISIONS = { table: 'preferences', revTable: 'preference_revisions', fk: 'preference_id' };
const stamp = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');

/* ---------- cleaning ---------- */

const text = (v, name, max) => validate.text(bad, v, name, max, { collapse: true, field: true });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Does a piece of text look like a secret or a number an agent should not hold? Emails are fine.
function looksSecret(s) {
    if (/\d(?:[ -]?\d){7,}/.test(s)) return true;                       // 8+ digits, spaces or dashes between
    if (/(^|[^a-z0-9])pak_/i.test(s) || /(^|[^a-z0-9])sk-/i.test(s)) return true;
    if (/(^|[^a-z0-9])AKIA[0-9A-Z]{4,}/.test(s)) return true;
    return s.split(/\s+/).some((tok) => tok.length >= 24 && !EMAIL_RE.test(tok) && /[a-z]/i.test(tok) && /\d/.test(tok));
}

function cleanKey(v) {
    const raw = text(v, 'key', 80);
    if (!raw) throw bad('bad_key', 'key is required (1 to 60 characters, like airline_seat).', 400, { field: 'key' });
    const key = raw.toLowerCase().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!/^[a-z0-9_]{1,60}$/.test(key)) throw bad('bad_key', 'key may have only letters, numbers and underscores, up to 60 characters (like airline_seat).', 400, { field: 'key' });
    const words = key.split('_');
    if (words.some((w) => KEY_WORDS_BANNED.includes(w)) || KEY_SUBSTRINGS_BANNED.some((w) => key.includes(w))) {
        throw bad('secret_like', `That key names something secret. ${VAULT_SENTENCE}`, 400, { field: 'key' });
    }
    return key;
}

function build(input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k) && k !== 'note') throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const f = {};
    const area = pick('area');
    if (!AREAS.includes(area)) throw bad('bad_area', `area must be one of: ${AREAS.join(', ')}.`, 400, { field: 'area' });
    f.area = area;
    f.key = cleanKey(pick('key'));
    f.value = text(pick('value'), 'value', 500);
    if (!f.value) throw bad('bad_value', 'value is required (1 to 500 characters).', 400, { field: 'value' });
    f.notes = text(pick('notes'), 'notes', 300);
    if (looksSecret(f.value)) throw bad('secret_like', `That value looks like a password, number or key. ${VAULT_SENTENCE}`, 400, { field: 'value' });
    if (f.notes && looksSecret(f.notes)) throw bad('secret_like', `Those notes look like a password, number or key. ${VAULT_SENTENCE}`, 400, { field: 'notes' });
    return f;
}

const editable = (row) => Object.fromEntries(FIELDS.map((k) => [k, row[k] == null ? null : row[k]]));

const need = (db, id) => needRow(db, 'preferences', id, () => bad('not_found', `There is no preference ${String(id).slice(0, 20)}.`, 404));

const findRow = (db, area, key) => db.prepare('SELECT * FROM preferences WHERE area = ? AND key = ?').get(area, key);

function write(db, id, f) {
    try {
        db.prepare(`UPDATE preferences SET ${FIELDS.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id });
    } catch (err) {
        if (/UNIQUE/.test(String(err.message))) {
            const other = findRow(db, f.area, f.key);
            throw bad('exists', `There is already a preference ${f.key.replace(/_/g, ' ')} in ${f.area}.`, 409, { id: other ? other.id : undefined });
        }
        throw err;
    }
}

// Stores the item as it is now as its next revision. Every change ends here.
const commit = (db, id, meta) => commitRevision(db, REVISIONS, id, meta, editable);

/* ---------- shape and reads ---------- */

function shape(row) {
    return {
        id: row.id,
        area: row.area,
        key: row.key,
        value: row.value,
        notes: row.notes || null,
        removed: !!row.removed_at,
        removed_at: row.removed_at || null,
        rev: row.current_rev,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    };
}

const cleanLimit = (v, def) => limitOrDefault(v, def, LIST_MAX);

// Filters: area, q (a piece of the key, value or notes), removed (true = only removed items; default only live ones).
function list(db, { area, q, removed, limit, offset } = {}) {
    const where = [];
    const args = {};
    if (area != null && area !== '') {
        if (!AREAS.includes(area)) throw bad('bad_area', `area must be one of: ${AREAS.join(', ')}.`, 400, { field: 'area' });
        where.push('area = @area');
        args.area = area;
    }
    where.push(removed === true || removed === 'true' || removed === '1' ? 'removed_at IS NOT NULL' : 'removed_at IS NULL');
    if (typeof q === 'string' && q.trim()) {
        const esc = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const term = q.trim().slice(0, 80);
        where.push("(key LIKE @q ESCAPE '\\' OR key LIKE @qk ESCAPE '\\' OR value LIKE @q ESCAPE '\\' OR notes LIKE @q ESCAPE '\\')");
        args.q = esc(term);
        args.qk = esc(term.toLowerCase().replace(/[\s-]+/g, '_'));
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM preferences ${clause}`).get(args).n;
    const off = clampOffset(offset);
    const lim = cleanLimit(limit, LIST_MAX);
    const order = `CASE area ${AREAS.map((a, i) => `WHEN '${a}' THEN ${i}`).join(' ')} END`;
    const rows = db.prepare(`SELECT * FROM preferences ${clause} ORDER BY ${order}, key ASC, id ASC LIMIT @lim OFFSET @off`).all({ ...args, lim, off });
    return { total, offset: off, limit: lim, preferences: rows.map(shape) };
}

// A revision (rev) shows the item as it was then.
function get(db, id, { rev } = {}) {
    const row = need(db, id);
    if (rev == null || rev === '' || Number(rev) === row.current_rev) return { ...shape(row), revisions: row.current_rev };
    const r = findRevision(db, REVISIONS, row.id, rev);
    if (!r) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
    return { ...shape({ ...row, ...JSON.parse(r.snapshot), current_rev: r.rev, updated_at: r.at, updated_by: r.actor }), revisions: row.current_rev };
}

// By area and key (a removed item is found too, flagged removed).
function getByKey(db, area, key) {
    if (!AREAS.includes(area)) throw bad('bad_area', `area must be one of: ${AREAS.join(', ')}.`, 400, { field: 'area' });
    const k = cleanKeyLoose(key);
    const row = findRow(db, area, k);
    if (!row) throw bad('not_found', `There is no preference ${k} in ${area}.`, 404);
    return { ...shape(row), revisions: row.current_rev };
}

// For lookups: same slug rules as cleanKey but no secret check (looking up never stores anything).
function cleanKeyLoose(v) {
    const raw = text(v, 'key', 80);
    if (!raw) throw bad('bad_key', 'key is required.', 400, { field: 'key' });
    return raw.toLowerCase().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// Newest first; what changed is read with get(id, { rev }). Revision rows carry no field values.
function history(db, id) {
    const row = need(db, id);
    return db.prepare('SELECT rev, source, actor, note, at FROM preference_revisions WHERE preference_id = ? ORDER BY rev DESC').all(row.id)
        .map((r) => ({ ...r, current: r.rev === row.current_rev }));
}

// The overview tile: live preferences only.
function stats(db) {
    const r = db.prepare('SELECT COUNT(*) AS n FROM preferences WHERE removed_at IS NULL').get();
    const last = db.prepare('SELECT MAX(updated_at) AS last FROM preferences').get().last;
    return { records: r.n, label: 'preferences', lastChange: last || null };
}

/* ---------- writes ---------- */

// What an audit row may say: id, area and key. Never the value or the notes.
const auditDetail = (result) => ({ id: result.id, area: result.area, key: result.key });

// Brings a removed row back with new content (used by create and set).
function revive(db, row, f, actor) {
    write(db, row.id, f);
    db.prepare('UPDATE preferences SET removed_at = NULL WHERE id = ?').run(row.id);
    return commit(db, row.id, { source: 'create', actor, note: 'Added again after it was removed' });
}

function create(db, input, actor) {
    const f = build(input);
    return db.transaction(() => {
        const old = findRow(db, f.area, f.key);
        if (old && !old.removed_at) throw bad('exists', `There is already a preference ${f.key.replace(/_/g, ' ')} in ${f.area}.`, 409, { id: old.id });
        if (old) return { status: 'created', id: old.id, area: f.area, key: f.key, rev: revive(db, old, f, actor) };
        const at = stamp();
        const id = Number(db.prepare(`INSERT INTO preferences (${FIELDS.join(', ')}, current_rev, created_at, updated_at, updated_by)
            VALUES (${FIELDS.map((k) => `@${k}`).join(', ')}, 0, @at, @at, @actor)`).run({ ...f, at, actor: who(actor) }).lastInsertRowid);
        return { status: 'created', id, area: f.area, key: f.key, rev: commit(db, id, { source: 'create', actor }) };
    })();
}

function update(db, id, input, actor) {
    const given = input || {};
    if (!Object.keys(given).some((k) => FIELDS.includes(k))) throw bad('bad_request', `Send at least one of: ${FIELDS.join(', ')}.`);
    return db.transaction(() => {
        const row = need(db, id);
        const f = build(given, row);
        const was = editable(row);
        const changed = FIELDS.filter((k) => f[k] !== was[k]);
        if (!changed.length) return { status: 'unchanged', id: row.id, area: row.area, key: row.key, rev: row.current_rev };
        write(db, row.id, f);
        const rev = commit(db, row.id, { source: 'edit', actor, note: given.note ? String(given.note).slice(0, 200) : null });
        return { status: 'updated', id: row.id, area: f.area, key: f.key, rev, fields: changed };
    })();
}

// Upsert by area and key: creates, or changes the value (and notes, when sent) of the live item, or brings a removed one back.
function set(db, input, actor) {
    const given = input || {};
    const area = given.area;
    if (!AREAS.includes(area)) throw bad('bad_area', `area must be one of: ${AREAS.join(', ')}.`, 400, { field: 'area' });
    const key = cleanKey(given.key);
    const row = findRow(db, area, key);
    if (!row || row.removed_at) return create(db, { ...given, key }, actor);
    const fields = { value: given.value };
    if (given.notes !== undefined) fields.notes = given.notes;
    if (given.note !== undefined) fields.note = given.note;
    return update(db, row.id, fields, actor);
}

// Soft remove: hidden from lists, history kept.
function unset(db, id, actor) {
    return db.transaction(() => {
        const row = need(db, id);
        if (row.removed_at) return { status: 'unchanged', id: row.id, area: row.area, key: row.key, rev: row.current_rev };
        db.prepare('UPDATE preferences SET removed_at = ? WHERE id = ?').run(stamp(), row.id);
        return { status: 'unset', id: row.id, area: row.area, key: row.key, rev: commit(db, row.id, { source: 'unset', actor, note: 'Removed' }) };
    })();
}

function unsetByKey(db, area, key, actor) {
    const item = getByKey(db, area, key);
    return unset(db, item.id, actor);
}

// Puts the item back to how it was at `rev` (default: as it is now) and makes it live again.
function restore(db, id, rev, actor) {
    return db.transaction(() => {
        const row = need(db, id);
        const target = rev == null || rev === '' ? row.current_rev : toId(rev);
        const old = target && findRevision(db, REVISIONS, row.id, target);
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const was = build(JSON.parse(old.snapshot));
        const now = editable(row);
        const changed = FIELDS.filter((k) => was[k] !== now[k]);
        const wasRemoved = !!row.removed_at;
        if (!changed.length && !wasRemoved) return { status: 'unchanged', id: row.id, area: row.area, key: row.key, rev: row.current_rev };
        write(db, row.id, was);
        if (wasRemoved) db.prepare('UPDATE preferences SET removed_at = NULL WHERE id = ?').run(row.id);
        const out = { status: 'updated', id: row.id, area: was.area, key: was.key, rev: commit(db, row.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` }), fields: changed };
        if (wasRemoved) out.fields = [...changed, 'removed'];
        return out;
    })();
}

/* ---------- permanent delete (admin only: never on /hub or MCP; the soft unset above stays) ---------- */

// Works on removed and live rows. The item and its revisions go; the value is never in the preview or the audit row.
function removalPreview(db, id) {
    const p = need(db, id);
    return {
        id: p.id, area: p.area, key: p.key, label: `${p.key.replace(/_/g, ' ')} (${p.area})`, removed: Boolean(p.removed_at),
        counts: { revisions: count(db, 'SELECT COUNT(*) AS n FROM preference_revisions WHERE preference_id = ?', p.id) },
    };
}

function remove(db, id, input) {
    needConfirm(bad, input);
    return db.transaction(() => {
        const pre = removalPreview(db, id);
        db.prepare('DELETE FROM preferences WHERE id = ?').run(pre.id);
        return { status: 'deleted', ...pre };
    })();
}

const removedAuditDetail = (r) => ({ id: r.id, area: r.area, key: r.key, ...r.counts });

module.exports = {
    removalPreview, remove, removedAuditDetail,
    PreferenceError, AREAS, FIELDS, LIST_MAX, VAULT_SENTENCE,
    looksSecret, shape, list, get, getByKey, history, stats, create, update, set, unset, unsetByKey, restore, auditDetail,
};
