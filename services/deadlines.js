// Deadlines: dates Atit must not miss: documents, insurance, licences, subscriptions, memberships, bills and
// casual tasks. One domain for admin dates and subscriptions.
//
// MODEL (migration 011)
//   deadlines          one row per item. due_date is a LOCAL date (YYYY-MM-DD, no zone); due_time (HH:MM) is optional.
//                      lead_days and urgent_days are CUSTOM per item (0..730, urgent <= lead; default 14 / 3):
//                      attention starts lead_days before the due date, urgent starts urgent_days before (or when overdue).
//                      Money (amount_cents, currency, cycle, auto_renew, cancel_by) is only for subscription,
//                      membership and bill. trip_id is a plain integer (a flights trip), no foreign key.
//   deadline_revisions every change stores all editable fields as a new revision (rev 1 = as first filed, never
//                      rewritten); restore puts an item back to an earlier revision as a new revision.
//
// STATUS: active (reminds), done (a one-off finished), ended (no more reminders). Overdue = active and due before
// today. "Today" is the date in DIGEST_TZ (default America/Chicago); every function that needs it takes `now`.
//
// DONE: on a repeating item the due date rolls to the next occurrence AFTER the current due date (and not before
// today): yearly +12 months, monthly +1, every_n_months +n, clamped to month end (Jan 31 -> Feb 28). Occurrences are
// counted from the due date being closed (k * step), so a clamp never drifts the day (Jan 31 stays the 31st when it
// can). The item stays active with done_at stamped and the revision note "Done, next due <date>". cancel_by moves by
// the same number of days. On repeat none the item becomes done.
//
// PRIVACY: reference (a document or policy number) is stored, but only ever appears in answers that ask for it:
// shape(row, { reference: true }). Lists, the MCP tool and the briefing never carry it (has_reference instead).
// It is never in audit rows (auditDetail names fields only), errors or stats(). Notes and amounts stay out of
// audit rows and the briefing too.
const { HubError } = require('./errors');
const { today, dayDiff } = require('./briefing');
const validate = require('./lib/validate');
const { needRow, commitRevision, findRevision } = require('./lib/revisions');
const { limitOrDefault, clampOffset } = require('./lib/listing');
const { toId } = validate;

const KINDS = ['document', 'insurance', 'license', 'subscription', 'membership', 'bill', 'task', 'other'];
const MONEY_KINDS = ['subscription', 'membership', 'bill'];
const REPEATS = ['none', 'yearly', 'monthly', 'every_n_months'];
const STATUSES = ['active', 'done', 'ended'];
const CYCLES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MONEY_FIELDS = ['amount_cents', 'currency', 'cycle', 'auto_renew', 'cancel_by'];
const FIELDS = ['title', 'kind', 'due_date', 'due_time', 'repeat_kind', 'repeat_n', 'lead_days', 'urgent_days', 'status', 'reference',
    'issuer', ...MONEY_FIELDS, 'trip_id', 'notes'];
const DEFAULT_LEAD = 14;
const DEFAULT_URGENT = 3;
const LIST_MAX = 200;

class DeadlineError extends HubError {
    constructor(status, code, message, extra) {
        super(status, code, message);
        if (extra) this.extra = extra;
    }
}

const bad = (code, message, status = 400, extra) => new DeadlineError(status, code, message, extra);
const REVISIONS = { table: 'deadlines', revTable: 'deadline_revisions', fk: 'deadline_id' };
const stamp = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');

/* ---------- dates ---------- */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

function cleanDate(v, name, { required = false } = {}) {
    if (v == null || v === '') {
        if (required) throw bad('bad_date', `${name} is required, as a date like 2027-03-01.`);
        return null;
    }
    const m = DATE_RE.exec(String(v));
    const ok = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= daysIn(Number(m[1]), Number(m[2])) && Number(m[1]) >= 1900;
    if (!ok) throw bad('bad_date', `${name} must be a date like 2027-03-01.`);
    return String(v);
}

// Adds whole months to a YYYY-MM-DD date; the day is kept when the month has it, else the month's last day.
function addMonths(date, n) {
    const [, y, mo, d] = DATE_RE.exec(date).map(Number);
    const total = y * 12 + (mo - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysIn(ny, nm))).padStart(2, '0')}`;
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const stepOf = (kind, n) => ({ yearly: 12, monthly: 1, every_n_months: n }[kind] || 0);

// The first occurrence after `due` that is not before `todayDate`. Null for repeat none.
function rollDate(due, repeatKind, repeatN, todayDate) {
    const step = stepOf(repeatKind, repeatN);
    if (!step) return null;
    for (let k = 1; k < 100000; k += 1) {
        const next = addMonths(due, k * step);
        if (next >= todayDate && next > due) return next;
    }
    throw bad('bad_repeat', 'This item repeats too often to roll forward.');
}

const daysLeft = (dueDate, now = new Date()) => dayDiff(today(now), dueDate);

// The next date the item is due: the stored due date for an active item, null once done or ended.
const nextDue = (row) => (row.status === 'active' ? row.due_date : null);

function windowOf(row, left) {
    if (row.status !== 'active') return null;
    if (left <= row.urgent_days) return 'urgent';
    if (left <= row.lead_days) return 'attention';
    return 'later';
}

/* ---------- cleaning ---------- */

const text = (v, name, max) => validate.text(bad, v, name, max);
const oneOf = (v, name, list) => validate.oneOf(bad, v, name, list);

function cleanInt(v, name, min, max) {
    const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(`bad_${name}`, `${name} must be a whole number from ${min} to ${max}.`);
    return n;
}

function cleanTime(v) {
    if (v == null || v === '') return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw bad('bad_time', 'due_time must be a time like 14:30.');
    return String(v);
}

function cleanBool(v, name) {
    if (v === true || v === 1 || v === 'true' || v === '1') return 1;
    if (v === false || v === 0 || v === 'false' || v === '0') return 0;
    throw bad(`bad_${name}`, `${name} must be true or false.`);
}

function build(input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k) && k !== 'note') throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const f = {};
    f.title = text(pick('title'), 'title', 120);
    if (!f.title) throw bad('bad_title', 'title is required (1 to 120 characters).');
    const kind = pick('kind');
    f.kind = oneOf(kind == null || kind === '' ? 'other' : kind, 'kind', KINDS);
    f.due_date = cleanDate(pick('due_date'), 'due_date', { required: true });
    f.due_time = cleanTime(pick('due_time'));
    const rk = pick('repeat_kind');
    f.repeat_kind = oneOf(rk == null || rk === '' ? 'none' : rk, 'repeat_kind', REPEATS);
    const rn = pick('repeat_n');
    if (f.repeat_kind === 'every_n_months') {
        if (rn == null || rn === '') throw bad('bad_repeat_n', 'repeat_n (the number of months) is required when repeat_kind is every_n_months.');
        f.repeat_n = cleanInt(rn, 'repeat_n', 1, 600);
    } else if (rn != null && rn !== '') {
        throw bad('bad_repeat_n', 'repeat_n is only for repeat_kind every_n_months.');
    } else f.repeat_n = null;
    const lead = pick('lead_days');
    const urgent = pick('urgent_days');
    f.lead_days = lead == null || lead === '' ? DEFAULT_LEAD : cleanInt(lead, 'lead_days', 0, 730);
    f.urgent_days = urgent == null || urgent === '' ? DEFAULT_URGENT : cleanInt(urgent, 'urgent_days', 0, 730);
    if (f.urgent_days > f.lead_days) throw bad('bad_window', `urgent_days (${f.urgent_days}) cannot be more than lead_days (${f.lead_days}).`);
    const st = pick('status');
    f.status = oneOf(st == null || st === '' ? 'active' : st, 'status', STATUSES);
    f.reference = text(pick('reference'), 'reference', 120);
    f.issuer = text(pick('issuer'), 'issuer', 120);
    const amount = pick('amount_cents');
    f.amount_cents = amount == null || amount === '' ? null : cleanInt(amount, 'amount_cents', 0, 1e12);
    const cur = text(pick('currency'), 'currency', 3);
    if (cur && !/^[A-Za-z]{3}$/.test(cur)) throw bad('bad_currency', 'currency must be a 3-letter code like USD.');
    f.currency = cur ? cur.toUpperCase() : null;
    const cycle = pick('cycle');
    f.cycle = cycle == null || cycle === '' ? null : oneOf(cycle, 'cycle', CYCLES);
    const ar = pick('auto_renew');
    f.auto_renew = ar == null || ar === '' ? null : cleanBool(ar, 'auto_renew');
    f.cancel_by = cleanDate(pick('cancel_by'), 'cancel_by');
    const trip = pick('trip_id');
    f.trip_id = trip == null || trip === '' ? null : (toId(trip) || (() => { throw bad('bad_trip', 'trip_id must be a positive whole number.'); })());
    f.notes = text(pick('notes'), 'notes', 2000);
    if (f.amount_cents != null && !f.currency) throw bad('bad_currency', 'currency is required with amount_cents.');
    if (!MONEY_KINDS.includes(f.kind)) {
        const used = MONEY_FIELDS.filter((k) => f[k] != null);
        if (used.length) throw bad('money_not_allowed', `${used.join(', ')} ${used.length === 1 ? 'is' : 'are'} only for subscription, membership and bill items, not ${f.kind}. Clear ${used.length === 1 ? 'it' : 'them'} or change kind.`);
    }
    return f;
}

const editable = (row) => Object.fromEntries(FIELDS.map((k) => [k, row[k] == null ? null : row[k]]));

const need = (db, id) => needRow(db, 'deadlines', id, () => bad('not_found', `There is no deadline ${String(id).slice(0, 20)}.`, 404));

function write(db, id, f) {
    db.prepare(`UPDATE deadlines SET ${FIELDS.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id });
}

// Stores the item as it is now as its next revision. Every change ends here.
const commit = (db, id, meta) => commitRevision(db, REVISIONS, id, meta, editable);

/* ---------- shape ---------- */

// An item as callers see it. `reference` true (the default, the full service shape) carries the private
// reference; false leaves it out and says has_reference instead. Computed: next_due, days_left, overdue, window.
function shape(row, { reference = true, now = new Date() } = {}) {
    const active = row.status === 'active';
    const left = active ? daysLeft(row.due_date, now) : null;
    const out = {
        id: row.id,
        title: row.title,
        kind: row.kind,
        due_date: row.due_date,
        due_time: row.due_time || null,
        repeat_kind: row.repeat_kind,
        repeat_n: row.repeat_n == null ? null : row.repeat_n,
        lead_days: row.lead_days,
        urgent_days: row.urgent_days,
        status: row.status,
        next_due: nextDue(row),
        days_left: left,
        overdue: active && left < 0,
        window: windowOf(row, left),
        issuer: row.issuer || null,
        amount_cents: row.amount_cents == null ? null : row.amount_cents,
        currency: row.currency || null,
        cycle: row.cycle || null,
        auto_renew: row.auto_renew == null ? null : row.auto_renew === 1,
        cancel_by: row.cancel_by || null,
        trip_id: row.trip_id == null ? null : row.trip_id,
        notes: row.notes || null,
        done_at: row.done_at || null,
        rev: row.current_rev,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    };
    if (reference) out.reference = row.reference || null;
    else if (row.reference) out.has_reference = true;
    return out;
}

/* ---------- reads ---------- */

const cleanLimit = (v, def) => limitOrDefault(v, def, LIST_MAX);

// Filters: kind, status (active by default; 'all' for every status), due_before / due_after (inclusive dates),
// overdue=true, q (a piece of the title). Soonest due date first.
function list(db, { kind, status, due_before: before, due_after: after, overdue, q, limit, offset, reference = false, now = new Date() } = {}) {
    const where = [];
    const args = {};
    if (kind != null && kind !== '') { where.push('kind = @kind'); args.kind = oneOf(kind, 'kind', KINDS); }
    const st = status == null || status === '' ? 'active' : status;
    if (st !== 'all') { where.push('status = @status'); args.status = oneOf(st, 'status', STATUSES); }
    if (before != null && before !== '') { where.push('due_date <= @before'); args.before = cleanDate(before, 'due_before'); }
    if (after != null && after !== '') { where.push('due_date >= @after'); args.after = cleanDate(after, 'due_after'); }
    if (overdue === true || overdue === 'true' || overdue === '1') { where.push("status = 'active' AND due_date < @today"); args.today = today(now); }
    if (typeof q === 'string' && q.trim()) {
        where.push("title LIKE @q ESCAPE '\\'");
        args.q = `%${q.trim().slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM deadlines ${clause}`).get(args).n;
    const off = clampOffset(offset);
    const lim = cleanLimit(limit, 50);
    const rows = db.prepare(`SELECT * FROM deadlines ${clause} ORDER BY due_date ASC, due_time IS NULL, due_time ASC, id ASC LIMIT @lim OFFSET @off`)
        .all({ ...args, lim, off });
    return { total, offset: off, limit: lim, deadlines: rows.map((r) => shape(r, { reference, now })) };
}

// A revision (rev) shows the item as it was then. `reference` defaults to true: the full reader.
function get(db, id, { rev, reference = true, now = new Date() } = {}) {
    const row = need(db, id);
    if (rev == null || rev === '' || Number(rev) === row.current_rev) return { ...shape(row, { reference, now }), revisions: row.current_rev };
    const r = findRevision(db, REVISIONS, row.id, rev);
    if (!r) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
    return { ...shape({ ...row, ...JSON.parse(r.snapshot), current_rev: r.rev, updated_at: r.at, updated_by: r.actor }, { reference, now }), revisions: row.current_rev };
}

// Newest first; what changed is read with get(id, { rev }). Revision rows carry no field values.
function history(db, id) {
    const row = need(db, id);
    return db.prepare('SELECT rev, source, actor, note, at FROM deadline_revisions WHERE deadline_id = ? ORDER BY rev DESC').all(row.id)
        .map((r) => ({ ...r, current: r.rev === row.current_rev }));
}

// Active items that are overdue or due within `days` days (default 60), soonest first.
function upcoming(db, { days = 60, limit, reference = false, now = new Date() } = {}) {
    const horizon = Math.min(Math.max(Number.isFinite(Number(days)) ? Math.trunc(Number(days)) : 60, 0), 3650);
    const last = addDays(today(now), horizon);
    const rows = db.prepare("SELECT * FROM deadlines WHERE status = 'active' AND due_date <= ? ORDER BY due_date ASC, due_time IS NULL, due_time ASC, id ASC LIMIT ?")
        .all(last, cleanLimit(limit, LIST_MAX));
    return rows.map((r) => shape(r, { reference, now }));
}

// The overview tile: a plain total of items, whatever their status.
function stats(db) {
    const r = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM deadlines').get();
    return { records: r.n, label: 'deadlines', lastChange: r.last || null };
}

/* ---------- writes ---------- */

// What an audit row may say: id, title, revision, and field NAMES (never values, never the reference).
const auditDetail = (result) => {
    const out = { id: result.id, title: result.title, rev: result.rev };
    if (result.fields) out.fields = result.fields;
    if (result.next_due) out.next_due = result.next_due;
    return out;
};

function create(db, input, actor) {
    const f = build(input);
    return db.transaction(() => {
        const at = stamp();
        const id = Number(db.prepare(`INSERT INTO deadlines (${FIELDS.join(', ')}, current_rev, created_at, updated_at, updated_by)
            VALUES (${FIELDS.map((k) => `@${k}`).join(', ')}, 0, @at, @at, @actor)`).run({ ...f, at, actor: who(actor) }).lastInsertRowid);
        return { status: 'created', id, title: f.title, rev: commit(db, id, { source: 'create', actor }) };
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
        if (!changed.length) return { status: 'unchanged', id: row.id, title: row.title, rev: row.current_rev };
        write(db, row.id, f);
        // Back to active from done: it is no longer "done at" anything.
        if (row.status === 'done' && f.status === 'active') db.prepare('UPDATE deadlines SET done_at = NULL WHERE id = ?').run(row.id);
        const rev = commit(db, row.id, { source: 'edit', actor, note: given.note ? String(given.note).slice(0, 200) : null });
        return { status: 'updated', id: row.id, title: f.title, rev, fields: changed };
    })();
}

// Marks the item done. A repeating item rolls to its next due date and stays active; a one-off becomes done.
function done(db, id, actor, { now = new Date() } = {}) {
    return db.transaction(() => {
        const row = need(db, id);
        if (row.status !== 'active') throw bad('not_active', `This deadline is ${row.status}, so it cannot be marked done. Edit its status back to active first.`, 409);
        const at = now.toISOString();
        if (row.repeat_kind === 'none') {
            db.prepare("UPDATE deadlines SET status = 'done', done_at = ? WHERE id = ?").run(at, row.id);
            return { status: 'done', id: row.id, title: row.title, rev: commit(db, row.id, { source: 'done', actor, note: 'Done' }), fields: ['status'] };
        }
        const next = rollDate(row.due_date, row.repeat_kind, row.repeat_n, today(now));
        const gap = row.cancel_by ? dayDiff(row.due_date, row.cancel_by) : null;
        db.prepare('UPDATE deadlines SET due_date = ?, cancel_by = ?, done_at = ? WHERE id = ?')
            .run(next, gap == null ? null : addDays(next, gap), at, row.id);
        const rev = commit(db, row.id, { source: 'done', actor, note: `Done, next due ${next}` });
        return { status: 'rolled', id: row.id, title: row.title, rev, next_due: next, fields: gap == null ? ['due_date'] : ['due_date', 'cancel_by'] };
    })();
}

// No more reminders, nothing deleted.
function end(db, id, actor) {
    return db.transaction(() => {
        const row = need(db, id);
        if (row.status === 'ended') return { status: 'unchanged', id: row.id, title: row.title, rev: row.current_rev };
        db.prepare("UPDATE deadlines SET status = 'ended' WHERE id = ?").run(row.id);
        return { status: 'ended', id: row.id, title: row.title, rev: commit(db, row.id, { source: 'end', actor, note: 'Ended' }), fields: ['status'] };
    })();
}

// Puts the item back to how it was at `rev`, as a new revision.
function restore(db, id, rev, actor) {
    return db.transaction(() => {
        const row = need(db, id);
        const old = findRevision(db, REVISIONS, row.id, rev);
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const was = build(JSON.parse(old.snapshot));
        const now = editable(row);
        const changed = FIELDS.filter((k) => was[k] !== now[k]);
        if (!changed.length) return { status: 'unchanged', id: row.id, title: row.title, rev: row.current_rev };
        write(db, row.id, was);
        if (row.status === 'done' && was.status === 'active') db.prepare('UPDATE deadlines SET done_at = NULL WHERE id = ?').run(row.id);
        return { status: 'updated', id: row.id, title: was.title, rev: commit(db, row.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` }), fields: changed };
    })();
}

module.exports = {
    DeadlineError, KINDS, MONEY_KINDS, REPEATS, STATUSES, CYCLES, FIELDS, MONEY_FIELDS, DEFAULT_LEAD, DEFAULT_URGENT, LIST_MAX,
    shape, nextDue, daysLeft, windowOf, addMonths, addDays, rollDate,
    list, get, history, upcoming, stats, create, update, done, end, restore, auditDetail,
};
