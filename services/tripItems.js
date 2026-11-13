// Trip items: a small itinerary inside a trip (where Atit stays, a train, a talk, a booking). Table trip_items
// (migration 017), deleted with their trip. Plan decision 4.
//
// FIELDS: kind (stay, ground, activity, booking, other), title, start_date / end_date (LOCAL dates, both optional,
// end not before start; an item outside the trip dates is fine: plans change and a stay may start the night before),
// place (free text), notes, reference (a booking or confirmation number), sort (orders items on the same day).
// Items have no revisions: changes are audited by trip id, item id and title.
//
// PRIVACY: reference is left out of every answer (has_reference instead) unless the caller asks for it with
// include_reference and is allowed to (the routes and the MCP tool decide that). It is never in audit rows, errors
// or the briefing. Error messages never echo a submitted value beyond a short id.
const validate = require('./lib/validate');
const { toId } = validate;

const KINDS = ['stay', 'ground', 'activity', 'booking', 'other'];
const FIELDS = ['kind', 'title', 'start_date', 'end_date', 'place', 'notes', 'reference', 'sort'];
const MAX_NOTES = 2000;
const MAX_SORT = 100000;

const trips = () => require('./trips'); // lazy: trips.js lists items through this file
const bad = (code, message, status = 400) => new (trips().TripError)(status, code, message);
const stamp = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');

const text = (v, name, max) => validate.text(bad, v, name, max);

function cleanSort(v) {
    if (v == null || v === '') return 0;
    const n = typeof v === 'number' ? v : /^-?\d+$/.test(String(v)) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > MAX_SORT) throw bad('bad_sort', `sort must be a whole number from 0 to ${MAX_SORT}.`);
    return n;
}

// The complete, valid fields from `input` laid over `current` (a stored item, for edits).
function build(input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k)) throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const { cleanDate } = trips();
    const kind = pick('kind');
    const it = {
        kind: validate.oneOf(bad, kind == null || kind === '' ? 'other' : kind, 'kind', KINDS),
        title: text(pick('title'), 'title', 120),
        start_date: cleanDate(pick('start_date'), 'start_date'),
        end_date: cleanDate(pick('end_date'), 'end_date'),
        place: text(pick('place'), 'place', 200),
        notes: text(pick('notes'), 'notes', MAX_NOTES),
        reference: text(pick('reference'), 'reference', 120),
        sort: cleanSort(pick('sort')),
    };
    if (!it.title) throw bad('bad_request', 'title is required.');
    if (it.start_date && it.end_date && it.end_date < it.start_date) throw bad('bad_date', 'end_date is before start_date.');
    return it;
}

// An item as callers see it. withRef: the reference itself; otherwise has_reference only.
function shape(row, { withRef = false } = {}) {
    const out = {
        id: row.id,
        trip_id: row.trip_id,
        kind: row.kind,
        title: row.title,
        start_date: row.start_date || null,
        end_date: row.end_date || null,
        place: row.place || null,
        notes: row.notes || null,
        sort: row.sort,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    };
    if (withRef) out.reference = row.reference || null;
    out.has_reference = Boolean(row.reference);
    return out;
}

// Items of one trip (already checked to exist): by start date (undated last), then sort, then id.
function rowsOf(db, tripId) {
    return db.prepare('SELECT * FROM trip_items WHERE trip_id = ? ORDER BY start_date IS NULL, start_date, sort, id').all(tripId);
}

function list(db, tripId, { reference = false } = {}) {
    const t = trips().need(db, tripId);
    return { trip_id: t.id, items: rowsOf(db, t.id).map((r) => shape(r, { withRef: reference })) };
}

// The item row, which must belong to this trip (an item of another trip is a 404 too: the URL names both).
function needItem(db, tripId, itemId) {
    const id = toId(itemId);
    const row = id && db.prepare('SELECT * FROM trip_items WHERE id = ? AND trip_id = ?').get(id, tripId);
    if (!row) throw bad('no_item', `Trip ${tripId} has no item ${String(itemId).slice(0, 20)}.`, 404);
    return row;
}

// Results carry the item without its reference; audit rows use auditDetail below.
const result = (status, tripId, row) => ({ status, id: tripId, item_id: row.id, title: row.title, item: shape(row) });

function add(db, tripId, input, actor) {
    return db.transaction(() => {
        const t = trips().need(db, tripId);
        const it = build(input);
        const at = stamp();
        const id = Number(db.prepare(`INSERT INTO trip_items (trip_id, ${FIELDS.join(', ')}, created_at, updated_at, updated_by)
            VALUES (@trip_id, ${FIELDS.map((k) => `@${k}`).join(', ')}, @at, @at, @actor)`).run({ ...it, trip_id: t.id, at, actor: who(actor) }).lastInsertRowid);
        return result('created', t.id, db.prepare('SELECT * FROM trip_items WHERE id = ?').get(id));
    })();
}

// Changes the fields sent; a field sent as null is cleared (title refuses that, kind falls back to other).
function update(db, tripId, itemId, input, actor) {
    const given = input || {};
    return db.transaction(() => {
        const t = trips().need(db, tripId);
        const row = needItem(db, t.id, itemId);
        if (!Object.keys(given).some((k) => FIELDS.includes(k))) throw bad('bad_request', `Send at least one of: ${FIELDS.join(', ')}.`);
        const it = build(given, row);
        const changed = FIELDS.filter((k) => it[k] !== (row[k] == null ? null : row[k]));
        if (!changed.length) return { ...result('unchanged', t.id, row) };
        db.prepare(`UPDATE trip_items SET ${FIELDS.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @at, updated_by = @actor WHERE id = @id`)
            .run({ ...it, at: stamp(), actor: who(actor), id: row.id });
        return { ...result('updated', t.id, db.prepare('SELECT * FROM trip_items WHERE id = ?').get(row.id)), fields: changed };
    })();
}

function remove(db, tripId, itemId) {
    return db.transaction(() => {
        const t = trips().need(db, tripId);
        const row = needItem(db, t.id, itemId);
        db.prepare('DELETE FROM trip_items WHERE id = ?').run(row.id);
        return { status: 'removed', id: t.id, item_id: row.id, title: row.title };
    })();
}

// What an audit row may say: trip id, item id, item title and field NAMES. Never place, notes or reference.
const auditDetail = (r) => {
    const out = { id: r.id, item_id: r.item_id, title: r.title };
    if (r.fields) out.fields = r.fields;
    return out;
};

module.exports = { KINDS, FIELDS, build, shape, rowsOf, list, add, update, remove, auditDetail };
