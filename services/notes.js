// Notes: Atit's personal wiki. Markdown notes that point at other records with [[wikilinks]].
//
// MODEL (migration 024)
//   notes            one row per note: title (<= 160), body (markdown, <= 100000), kind (a free slug: note, daily, inbox,
//                    meeting...), tags (JSON array, <= 20 slugs), pinned, who wrote it first and last. removed_at = in the trash.
//   note_revisions   title, body, kind, tags and pinned as they were after a change. Autosaves (admin editor) that follow
//                    each other within 5 minutes share a revision; a person's explicit Save, and every change by a key or
//                    agent, always files one. Restore puts a note back to an earlier revision as a new revision.
//   note_unresolved  [[Title]] targets that nothing answered to when the note was last saved (the "Missing pages" list).
//
// WIKILINKS: on every save the body is parsed ([[Target]], [[Target|label]], [[domain:id]], [[domain:id|label]]; code
// fences and inline code are ignored). A plain [[Target]] resolves by exact title or alias, any case: a note first (the most
// recently updated when several share the title), else an entity. Every resolved target gets a link row (from this note,
// rel 'mentions', actor = whoever saved) through services/links.js; 'mentions' rows of this note whose target is no longer
// in the text are removed. Rows with another rel and links where the note is the target are never touched. Unresolved
// targets stay plain text and are returned as `unresolved`. Renaming a note or entity does not rewrite other notes' text;
// links are stored by id, so backlinks survive a rename, while a [[Old title]] in text simply stops resolving.
//
// PRIVACY: titles, bodies and tags are content. They never appear in audit rows, errors or logs; audit detail is id, kind,
// rev and field NAMES only. Deleting for good is permanent and admin-only (never on /hub or MCP); links go with it (trigger).
const { HubError } = require('./errors');
const validate = require('./lib/validate');
const wikilinks = require('./lib/wikilinks');
const wikiresolve = require('./lib/wikiresolve');
const { needRow, commitRevision, findRevision } = require('./lib/revisions');
const { limitOrDefault, clampOffset } = require('./lib/listing');
const { needConfirm, count } = require('./lib/remove');
const links = require('./links');
const { toId } = validate;

const FIELDS = ['title', 'body', 'kind', 'tags', 'pinned'];
const LIST_MAX = 200;
const TITLE_MAX = 160;
const BODY_MAX = 100000;
const TAGS_MAX = 20;
const TAG_LEN = 30;
const APPEND_MAX = 20000;
const REVISION_GAP_MS = 5 * 60 * 1000;
const DEFAULT_KIND = 'note';
const KIND_RE = /^[a-z][a-z0-9_-]{0,19}$/;
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;

class NoteError extends HubError {
    constructor(status, code, message, extra) {
        super(status, code, message);
        if (extra) this.extra = extra;
    }
}

const bad = (code, message, status = 400, extra) => new NoteError(status, code, message, extra);
const REVISIONS = { table: 'notes', revTable: 'note_revisions', fk: 'note_id' };
const stamp = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');

/* ---------- cleaning ---------- */

function cleanTitle(v) {
    const t = validate.text(bad, v, 'title', TITLE_MAX, { field: true, collapse: true });
    if (!t) throw bad('bad_title', `title is required (1 to ${TITLE_MAX} characters).`, 400, { field: 'title' });
    return t;
}

function cleanKind(v) {
    if (v == null || v === '') return DEFAULT_KIND;
    const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!KIND_RE.test(k)) throw bad('bad_kind', 'kind is a short lowercase word (letters, digits, - and _), at most 20 characters.', 400, { field: 'kind' });
    return k;
}

// Text or an array of tags: lower case, a leading # and spaces tidied, no duplicates, at most TAGS_MAX.
function cleanTags(v) {
    if (v == null || v === '') return [];
    const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
    if (!parts) throw bad('bad_tags', 'tags must be a list of words.', 400, { field: 'tags' });
    const out = [];
    for (const p of parts) {
        if (typeof p !== 'string') throw bad('bad_tags', 'tags must be a list of words.', 400, { field: 'tags' });
        const t = p.normalize('NFKC').trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-');
        if (!t) continue;
        if (!TAG_RE.test(t)) throw bad('bad_tags', `Each tag is a short lowercase word (letters, digits, - and _), at most ${TAG_LEN} characters.`, 400, { field: 'tags' });
        if (!out.includes(t)) out.push(t);
    }
    if (out.length > TAGS_MAX) throw bad('bad_tags', `At most ${TAGS_MAX} tags.`, 400, { field: 'tags' });
    return out;
}

function cleanBody(v) {
    if (v == null) return '';
    if (typeof v !== 'string') throw bad('bad_body', 'body must be text.', 400, { field: 'body' });
    const s = v.replace(/\r\n?/g, '\n');
    if (s.length > BODY_MAX) throw bad('bad_body', `body is longer than ${BODY_MAX} characters.`, 400, { field: 'body' });
    return s;
}

function cleanPinned(v) {
    if (v === true || v === 1 || v === '1' || v === 'true') return 1;
    if (v === false || v === 0 || v === '0' || v === 'false' || v == null || v === '') return 0;
    throw bad('bad_pinned', 'pinned must be true or false.', 400, { field: 'pinned' });
}

function build(input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k) && k !== 'note') throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    return {
        title: cleanTitle(pick('title')),
        body: cleanBody(pick('body')),
        kind: cleanKind(pick('kind')),
        tags: cleanTags(pick('tags')),
        pinned: cleanPinned(pick('pinned')),
    };
}

const parseTags = (v) => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
const editable = (row) => ({ title: row.title, body: row.body, kind: row.kind, tags: parseTags(row.tags), pinned: row.pinned ? 1 : 0 });
const same = (k, a, b) => (k === 'tags' ? JSON.stringify(a) === JSON.stringify(b) : a === b);
const diff = (a, b) => FIELDS.filter((k) => !same(k, a[k], b[k]));
const snapshotOf = (r) => { const s = JSON.parse(r.snapshot); return { title: s.title, body: s.body == null ? '' : s.body, kind: s.kind || DEFAULT_KIND, tags: s.tags || [], pinned: s.pinned ? 1 : 0 }; };

const need = (db, id, { removed = false } = {}) => {
    const row = needRow(db, 'notes', id, () => bad('not_found', `There is no note ${String(id).slice(0, 20)}.`, 404));
    if (row.removed_at && !removed) throw bad('not_found', `There is no note ${String(id).slice(0, 20)}.`, 404);
    return row;
};

const linkCount = (db, id) => count(db, `SELECT COUNT(*) AS n FROM links WHERE (from_domain = 'notes' AND from_id = ?) OR (to_domain = 'notes' AND to_id = ?)`, String(id), String(id));

/* ---------- shape and reads ---------- */

// A short plain-text line from the start of a body: no markdown marks, wikilinks as their label.
function previewOf(body, n = 160) {
    const t = String(body == null ? '' : body)
        .replace(/^ {0,3}(```|~~~)[^\n]*$/gm, ' ')
        .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^[ \t]*(?:#{1,6}|>|[-*+] \[[ xX]\]|[-*+]|\d+\.)[ \t]+/gm, '')
        .replace(/[*_~`]+/g, '')
        .replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function shape(row, extra) {
    return {
        id: row.id,
        title: row.title,
        kind: row.kind,
        tags: parseTags(row.tags),
        pinned: !!row.pinned,
        chars: row.chars != null ? row.chars : String(row.body == null ? '' : row.body).length,
        rev: row.current_rev,
        created_at: row.created_at,
        created_by: row.created_by,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
        removed: !!row.removed_at,
        ...(extra || {}),
    };
}

const cleanLimit = (v, def) => limitOrDefault(v, def, LIST_MAX);
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

// Filters: kind, tag, q (every word in the title, body or tags), pinned, removed (the trash). Pinned first, then newest.
// Rows carry a preview line and the size of the body, never the body.
function list(db, { kind, tag, q, pinned, removed, limit, offset } = {}) {
    const where = [truthy(removed) ? 'removed_at IS NOT NULL' : 'removed_at IS NULL'];
    const args = {};
    if (kind != null && kind !== '') { where.push('kind = @kind'); args.kind = cleanKind(kind); }
    if (tag != null && tag !== '') { where.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = @tag)'); args.tag = cleanTags([String(tag)])[0] || ''; }
    if (truthy(pinned)) where.push('pinned = 1');
    if (typeof q === 'string' && q.trim()) {
        q.trim().toLowerCase().split(/\s+/).slice(0, 8).forEach((t, i) => {
            args[`q${i}`] = `%${t.slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            where.push(`LOWER(title || ' ' || body || ' ' || tags) LIKE @q${i} ESCAPE '\\'`);
        });
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM notes ${clause}`).get(args).n;
    const off = clampOffset(offset);
    const lim = cleanLimit(limit, LIST_MAX);
    const rows = db.prepare(`SELECT id, title, kind, tags, pinned, current_rev, created_at, created_by, updated_at, updated_by, removed_at,
        substr(body, 1, 600) AS head, length(body) AS chars FROM notes ${clause} ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT @lim OFFSET @off`)
        .all({ ...args, lim, off });
    return { total, offset: off, limit: lim, notes: rows.map((r) => shape(r, { preview: previewOf(r.head) })) };
}

// Kinds and tags in use, with counts (the dashboard's chips), and how many are pinned or in the trash.
function facets(db) {
    return {
        kinds: db.prepare('SELECT kind, COUNT(*) AS count FROM notes WHERE removed_at IS NULL GROUP BY kind ORDER BY count DESC, kind').all(),
        tags: db.prepare(`SELECT j.value AS tag, COUNT(*) AS count FROM notes, json_each(notes.tags) j WHERE removed_at IS NULL
            GROUP BY j.value ORDER BY count DESC, tag LIMIT 200`).all(),
        pinned: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE removed_at IS NULL AND pinned = 1').get().n,
        removed: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE removed_at IS NOT NULL').get().n,
        total: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE removed_at IS NULL').get().n,
    };
}

// A note with its body. `rev` shows it as it was at that revision. `wikilinks` says how each [[target]] in the body resolves now.
function get(db, id, { rev, removed = false, visible = null } = {}) {
    const row = need(db, id, { removed });
    let r = row;
    if (rev != null && rev !== '' && Number(rev) !== row.current_rev) {
        const old = findRevision(db, REVISIONS, row.id, rev);
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const s = snapshotOf(old);
        r = { ...row, ...s, tags: JSON.stringify(s.tags), current_rev: old.rev, updated_at: old.at, updated_by: old.actor };
    }
    return { ...shape(r, { body: r.body, revisions: row.current_rev }), wikilinks: resolveBody(db, r.body, { selfId: row.id, visible }) };
}

// Newest first. Each row names its title and size as of that revision; what changed is read with get(id, { rev }).
function history(db, id, { removed = true } = {}) {
    const row = need(db, id, { removed });
    return db.prepare('SELECT rev, snapshot, source, actor, note, at FROM note_revisions WHERE note_id = ? ORDER BY rev DESC').all(row.id).map((r) => {
        const s = snapshotOf(r);
        return { rev: r.rev, source: r.source, actor: r.actor, note: r.note, at: r.at, title: s.title, chars: s.body.length, current: r.rev === row.current_rev };
    });
}

function stats(db) {
    const r = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM notes WHERE removed_at IS NULL').get();
    return { records: r.n, label: r.n === 1 ? 'note' : 'notes', lastChange: r.last || null };
}

/* ---------- wikilinks ---------- */

// The resolver is shared with digests (services/lib/wikiresolve.js); a note is `self` so it never links to itself.
const noteRef = (selfId) => ({ domain: 'notes', id: String(selfId) });
const { isDomain } = wikiresolve;

// Every wikilink of a body, resolved: { resolved: [{ target, label, domain, id, title, kind, ambiguous? }], unresolved: [target],
// ambiguous: [{ target, candidates, chose }] }. Links to oneself are left out.
function resolveBody(db, body, { selfId, visible = null } = {}) {
    return wikiresolve.resolveBody(db, body, { self: noteRef(selfId), visible });
}

// For the editor: how do these typed targets resolve right now? (no note saved) -> same shape as resolveBody.
function resolveTargets(db, targets, { selfId, visible = null } = {}) {
    return wikiresolve.resolveTargets(db, targets, { self: noteRef(selfId), visible });
}

// Brings the links of a note in line with its text. One transaction (the caller's). Returns what happened.
function syncLinks(db, row, body, actor, { visible = null } = {}) {
    const { res, added, removed, resolved } = wikiresolve.syncMentions(db, noteRef(row.id), body, actor, { visible });
    // Missing pages: only title-form targets (a [[domain:id]] that does not exist is not a page to create).
    db.prepare('DELETE FROM note_unresolved WHERE note_id = ?').run(row.id);
    const ins = db.prepare('INSERT OR IGNORE INTO note_unresolved (note_id, key, target) VALUES (?, ?, ?)');
    const isRef = new Set(wikilinks.parse(body, isDomain).filter((t) => t.ref).map((t) => t.target));
    for (const u of res.unresolved) if (!isRef.has(u)) ins.run(row.id, u.toLowerCase(), u);
    return { added, removed, resolved, unresolved: res.unresolved, ambiguous: res.ambiguous };
}

// A note or entity with this title now exists: notes that were waiting for it link to it.
function resolvePending(db, title, actor) {
    const rows = db.prepare(`SELECT n.* FROM note_unresolved u JOIN notes n ON n.id = u.note_id WHERE u.key = ? AND n.removed_at IS NULL LIMIT 50`).all(String(title).toLowerCase());
    for (const n of rows) syncLinks(db, n, n.body, actor);
}

// Titles used in notes that no note or entity answers to (any more), with how many notes use each. Admin and notes:read.
function missing(db, { limit = 100 } = {}) {
    const rows = db.prepare(`SELECT u.key, MIN(u.target) AS target, COUNT(DISTINCT u.note_id) AS count FROM note_unresolved u
        JOIN notes n ON n.id = u.note_id AND n.removed_at IS NULL GROUP BY u.key ORDER BY count DESC, u.key LIMIT 400`).all();
    const gone = (k) => !db.prepare('SELECT 1 FROM notes WHERE title = ? COLLATE NOCASE AND removed_at IS NULL').get(k)
        && !db.prepare('SELECT 1 FROM entities WHERE name = @n COLLATE NOCASE OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE value = @n COLLATE NOCASE)').get({ n: k });
    const out = [];
    for (const r of rows) {
        if (!gone(r.key)) continue;
        const where = db.prepare(`SELECT n.id, n.title FROM note_unresolved u JOIN notes n ON n.id = u.note_id AND n.removed_at IS NULL
            WHERE u.key = ? ORDER BY n.updated_at DESC LIMIT 5`).all(r.key);
        out.push({ target: r.target, count: r.count, notes: where });
        if (out.length >= Math.min(Math.max(Number(limit) || 100, 1), 200)) break;
    }
    return { count: out.length, missing: out };
}

/* ---------- writes ---------- */

// What an audit row may say: id, kind, rev and the NAMES of the fields that changed. Never the title, body or tags.
const auditDetail = (r) => ({ id: r.id, kind: r.kind, rev: r.rev, ...(r.fields ? { fields: r.fields } : {}) });

const write = (db, id, f, actor) => db.prepare(`UPDATE notes SET title = @title, body = @body, kind = @kind, tags = @tags, pinned = @pinned,
    updated_at = @at, updated_by = @actor WHERE id = @id`).run({ ...f, tags: JSON.stringify(f.tags), at: stamp(), actor: who(actor), id });
const commit = (db, id, meta) => commitRevision(db, REVISIONS, id, meta, editable);
const syncResult = (s) => ({ links: { added: s.added, removed: s.removed, resolved: s.resolved }, unresolved: s.unresolved, ...(s.ambiguous.length ? { ambiguous: s.ambiguous } : {}) });

// opts.visible: the domains the writer may read (null = all); a key only links what it can read.
function create(db, input, actor, opts = {}) {
    const f = build(input);
    return db.transaction(() => {
        const at = stamp();
        const id = Number(db.prepare(`INSERT INTO notes (title, body, kind, tags, pinned, current_rev, created_at, updated_at, created_by, updated_by)
            VALUES (@title, @body, @kind, @tags, @pinned, 0, @at, @at, @actor, @actor)`).run({ ...f, tags: JSON.stringify(f.tags), at, actor: who(actor) }).lastInsertRowid);
        const rev = commit(db, id, { source: 'create', actor });
        const s = syncLinks(db, { id }, f.body, actor, { visible: opts.visible || null });
        resolvePending(db, f.title, actor);
        return { status: 'created', id, kind: f.kind, rev, ...syncResult(s) };
    })();
}

// opts.sync: also re-sync the links when nothing changed. opts.autosave: the admin editor's debounced save (a revision only when the title or body changed and the last revision is
// at least 5 minutes old); anything else files a revision whenever something changed. opts.source names the revision.
function update(db, id, input, actor, opts = {}) {
    const given = input || {};
    if (!Object.keys(given).some((k) => FIELDS.includes(k))) throw bad('bad_request', `Send at least one of: ${FIELDS.join(', ')}.`);
    return db.transaction(() => {
        const row = need(db, id);
        const was = editable(row);
        const f = build(given, was);
        const changed = diff(f, was);
        const last = db.prepare('SELECT snapshot, at FROM note_revisions WHERE note_id = ? AND rev = ?').get(row.id, row.current_rev);
        const snap = last ? snapshotOf(last) : was;
        const dirty = diff(was, snap).length > 0;     // autosaved changes no revision holds yet
        if (!changed.length && (opts.autosave || !dirty)) {
            // opts.sync (the dashboard): bring the links in line with the text anyway, e.g. after a missing page was created
            const s = opts.sync ? syncLinks(db, row, row.body, actor, { visible: opts.visible || null }) : null;
            return { status: 'unchanged', id: row.id, kind: row.kind, rev: row.current_rev, ...(s ? syncResult(s) : {}) };
        }
        if (changed.length) write(db, row.id, f, actor);
        let rev = row.current_rev;
        let revised = false;
        const old = last ? Date.now() - Date.parse(last.at) >= REVISION_GAP_MS : true;
        if (opts.autosave ? (f.title !== snap.title || f.body !== snap.body) && old : true) {
            rev = commit(db, row.id, { source: opts.autosave ? 'autosave' : opts.source || 'edit', actor, note: given.note ? String(given.note).slice(0, 200) : null });
            revised = true;
        }
        const fresh = db.prepare('SELECT * FROM notes WHERE id = ?').get(row.id);
        const s = syncLinks(db, fresh, f.body, actor, { visible: opts.visible || null });
        if (changed.includes('title')) resolvePending(db, f.title, actor);
        return { status: 'updated', id: row.id, kind: f.kind, rev, revised, fields: changed, ...syncResult(s) };
    })();
}

// Adds text at the end of a note (a blank line between) and files a revision. For agents capturing into a note.
function append(db, id, input, actor, opts = {}) {
    const given = input || {};
    const t = typeof given.text === 'string' ? given.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!t) throw bad('bad_request', 'text is required.', 400, { field: 'text' });
    if (t.length > APPEND_MAX) throw bad('bad_body', `text is longer than ${APPEND_MAX} characters.`, 400, { field: 'text' });
    return db.transaction(() => {
        const row = need(db, id);
        const base = row.body.replace(/\s+$/, '');
        return update(db, row.id, { body: base ? `${base}\n\n${t}` : t, ...(given.note ? { note: given.note } : {}) }, actor, { ...opts, source: 'append' });
    })();
}

// Puts the note back to how it was at `rev`. Autosaved changes no revision holds yet are filed first, so nothing is lost.
function restore(db, id, rev, actor, opts = {}) {
    return db.transaction(() => {
        const row = need(db, id);
        const target = rev == null || rev === '' ? row.current_rev : toId(rev);
        const old = target && findRevision(db, REVISIONS, row.id, target);
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const last = db.prepare('SELECT snapshot FROM note_revisions WHERE note_id = ? AND rev = ?').get(row.id, row.current_rev);
        let now = editable(row);
        let current = row.current_rev;
        if (last && diff(now, snapshotOf(last)).length) current = commit(db, row.id, { source: 'autosave', actor, note: 'Before restore' });
        const was = build(snapshotOf(old));
        const changed = diff(was, now);
        if (!changed.length) return { status: current !== row.current_rev ? 'updated' : 'unchanged', id: row.id, kind: row.kind, rev: current };
        write(db, row.id, was, actor);
        const newRev = commit(db, row.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` });
        const s = syncLinks(db, db.prepare('SELECT * FROM notes WHERE id = ?').get(row.id), was.body, actor, { visible: opts.visible || null });
        return { status: 'updated', id: row.id, kind: was.kind, rev: newRev, fields: changed, ...syncResult(s) };
    })();
}

/* ---------- the trash (admin only) and permanent delete (admin only: never on /hub or MCP) ---------- */

function trash(db, id, actor) {
    return db.transaction(() => {
        const row = need(db, id, { removed: true });
        if (row.removed_at) return { status: 'unchanged', id: row.id, kind: row.kind, rev: row.current_rev };
        db.prepare('UPDATE notes SET removed_at = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(stamp(), stamp(), who(actor), row.id);
        return { status: 'removed', id: row.id, kind: row.kind, rev: row.current_rev };
    })();
}

function untrash(db, id, actor) {
    return db.transaction(() => {
        const row = need(db, id, { removed: true });
        if (!row.removed_at) return { status: 'unchanged', id: row.id, kind: row.kind, rev: row.current_rev };
        db.prepare('UPDATE notes SET removed_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run(stamp(), who(actor), row.id);
        const s = syncLinks(db, db.prepare('SELECT * FROM notes WHERE id = ?').get(row.id), row.body, actor);
        return { status: 'restored', id: row.id, kind: row.kind, rev: row.current_rev, ...syncResult(s) };
    })();
}

// The links the note has (they go with it) and its revisions. The title is only in the preview shown at the dashboard.
function removalPreview(db, id) {
    const n = need(db, id, { removed: true });
    return {
        id: n.id, kind: n.kind, label: n.title,
        counts: { links: linkCount(db, n.id), revisions: count(db, 'SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = ?', n.id) },
    };
}

function remove(db, id, input) {
    needConfirm(bad, input);
    return db.transaction(() => {
        const pre = removalPreview(db, id);
        db.prepare('DELETE FROM notes WHERE id = ?').run(pre.id);
        return { status: 'deleted', ...pre };
    })();
}

const removedAuditDetail = (r) => ({ id: r.id, kind: r.kind, ...r.counts });

module.exports = {
    removalPreview, remove, removedAuditDetail, trash, untrash,
    NoteError, FIELDS, LIST_MAX, TITLE_MAX, BODY_MAX, TAGS_MAX, APPEND_MAX, REVISION_GAP_MS, DEFAULT_KIND,
    shape, previewOf, list, facets, get, history, stats, create, update, append, restore, auditDetail,
    resolveBody, resolveTargets, resolvePending, syncLinks, missing,
};
