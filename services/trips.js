// Trips: journeys Atit makes or plans ("Hong Kong, Dec 2026"), with the flights and deadlines that belong to them.
// A domain of its own since migration 017; before that trips were a light grouping owned by services/flights.js,
// whose trip functions (listTrips, getTrip, createTrip, updateTrip, removeTrip, ...) now call this file.
//
// MODEL (migrations 007 and 017)
//   trips           title, destination (free text), kind, start_date / end_date (LOCAL dates, YYYY-MM-DD, both
//                   optional), notes, status_override (null or 'cancelled'), current_rev.
//   trip_revisions  every change stores all editable fields as a new revision (rev 1 = as first filed; trips made
//                   before 017 got their rev 1 from the migration); restore puts a trip back as a new revision.
//   trip_items      a small itinerary: services/tripItems.js. Deleted with their trip.
//   trip_suggestion_dismissed  suggested trips Atit dismissed: services/tripSuggest.js (suggest, accept, dismiss).
//   Links: flights.trip_id (foreign key, SET NULL) and deadlines.trip_id (a plain number, checked by the
//   deadlines service through exists()). A flight belongs to one trip at most.
//
// COMPUTED, never stored (in the hub time zone, every function that needs "today" takes `now`):
//   phase          cancelled (status_override), else upcoming (before the start, or no dates yet), ongoing
//                  (start <= today <= end), past (after the end). A trip with one date only is a one-day trip.
//   days_to_start  upcoming trips with a start date: days until it starts (0 never happens: that is ongoing).
//   days_left      ongoing trips: days until the last day (0 = today is the last day).
//   nights         end - start in days, when both dates are set.
//   flight_count, route (airport codes in departure order), distance_km (flights not cancelled).
//
// PRIVACY: a trip detail lists its flights WITHOUT booking references (has_booking_ref instead) and its deadlines
// with id, title, kind, due date and status only (no reference, no money). Audit rows carry ids and titles; notes
// never. Error messages never echo a submitted value beyond a short id.
const { HubError } = require('./errors');
const { hubTz, todayIn } = require('./lib/tz');
const validate = require('./lib/validate');
const { needRow, commitRevision, findRevision } = require('./lib/revisions');
const { limitOrDefault, clampOffset } = require('./lib/listing');
const { needConfirm, count } = require('./lib/remove');
const { toId } = validate;

const KINDS = ['leisure', 'conference', 'research', 'family', 'work', 'other'];
const PHASES = ['upcoming', 'ongoing', 'past', 'cancelled'];
const OVERRIDES = ['cancelled'];
const FIELDS = ['title', 'destination', 'kind', 'start_date', 'end_date', 'notes', 'status_override'];
// The fields the flights trip routes (/hub/flights/trips, the flights MCP action) have always taken.
const LEGACY_FIELDS = ['title', 'start_date', 'end_date', 'notes'];
const MAX_NOTES = 2000;
const LIST_MAX = 200;

class TripError extends HubError {
    constructor(status, code, message, extra) {
        super(status, code, message);
        if (extra) this.extra = extra;
    }
}

const bad = (code, message, status = 400, extra) => new TripError(status, code, message, extra);
const REVISIONS = { table: 'trips', revTable: 'trip_revisions', fk: 'trip_id' };
const stamp = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');
const flightsSvc = () => require('./flights'); // lazy: flights.js calls this file too

/* ---------- dates ---------- */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

function cleanDate(v, name) {
    if (v == null || v === '') return null;
    const m = DATE_RE.exec(String(v));
    const ok = m && Number(m[1]) >= 1900 && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= daysIn(Number(m[1]), Number(m[2]));
    if (!ok) throw bad('bad_date', `${name} must be a date like 2027-03-01.`);
    return String(v);
}

const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/* ---------- cleaning ---------- */

const text = (v, name, max) => validate.text(bad, v, name, max);
const oneOf = (v, name, list) => validate.oneOf(bad, v, name, list);

// The complete, valid editable fields from `input` laid over `current` (a stored trip, for edits). `note` (why it
// changed) is allowed and goes to the revision.
function build(input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k) && k !== 'note') throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const t = {
        title: text(pick('title'), 'title', 120),
        destination: text(pick('destination'), 'destination', 120),
        kind: null,
        start_date: cleanDate(pick('start_date'), 'start_date'),
        end_date: cleanDate(pick('end_date'), 'end_date'),
        notes: text(pick('notes'), 'notes', MAX_NOTES),
        status_override: null,
    };
    if (!t.title) throw bad('bad_request', 'title is required.');
    const kind = pick('kind');
    t.kind = oneOf(kind == null || kind === '' ? 'other' : kind, 'kind', KINDS);
    const so = pick('status_override');
    t.status_override = so == null || so === '' ? null : oneOf(so, 'status_override', OVERRIDES);
    if (t.start_date && t.end_date && t.end_date < t.start_date) throw bad('bad_date', 'end_date is before start_date.');
    return t;
}

const editable = (row) => Object.fromEntries(FIELDS.map((k) => [k, row[k] == null ? null : row[k]]));

const need = (db, id) => needRow(db, 'trips', id, () => bad('no_trip', `There is no trip ${String(id).slice(0, 20)}.`, 404));

// Whether a trip with this id exists (the flights and deadlines services check their trip_id with it).
const exists = (db, id) => Boolean(toId(id) && db.prepare('SELECT 1 FROM trips WHERE id = ?').get(toId(id)));

function write(db, id, t) {
    db.prepare(`UPDATE trips SET ${FIELDS.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...t, id });
}

// Stores the trip as it is now as its next revision. Every change ends here.
const commit = (db, id, meta) => commitRevision(db, REVISIONS, id, meta, editable);

/* ---------- computed ---------- */

// phase, days_to_start, days_left and nights for a trip row on `today` (YYYY-MM-DD in the hub zone).
function timing(row, today) {
    const start = row.start_date || row.end_date || null;
    const end = row.end_date || row.start_date || null;
    let phase;
    if (row.status_override === 'cancelled') phase = 'cancelled';
    else if (!start || today < start) phase = 'upcoming';
    else if (today > end) phase = 'past';
    else phase = 'ongoing';
    return {
        phase,
        days_to_start: phase === 'upcoming' && start ? dayDiff(today, start) : null,
        days_left: phase === 'ongoing' ? dayDiff(today, end) : null,
        nights: row.start_date && row.end_date ? dayDiff(row.start_date, row.end_date) : null,
    };
}

// Flight figures per trip: count, route (airport codes in departure order) and distance of the flights not cancelled.
function flightFacts(db, ids) {
    const out = new Map(ids.map((id) => [id, { flight_count: 0, route: [], distance_km: 0 }]));
    if (!ids.length) return out;
    const rows = db.prepare(`SELECT trip_id, origin_iata, dest_iata, distance_km, status FROM flights
        WHERE trip_id IN (${ids.map(() => '?').join(', ')}) ORDER BY sched_dep, id`).all(...ids);
    for (const r of rows) {
        const f = out.get(r.trip_id);
        f.flight_count += 1;
        if (r.status === 'cancelled') continue;
        if (f.route[f.route.length - 1] !== r.origin_iata) f.route.push(r.origin_iata);
        f.route.push(r.dest_iata);
        f.distance_km += r.distance_km || 0;
    }
    for (const f of out.values()) f.distance_km = Math.round(f.distance_km);
    return out;
}

const itemCounts = (db) => new Map(db.prepare('SELECT trip_id, COUNT(*) AS n FROM trip_items GROUP BY trip_id').all().map((r) => [r.trip_id, r.n]));

// A trip as callers see it.
function shape(row, today, facts, items = 0) {
    return {
        id: row.id,
        title: row.title,
        destination: row.destination || null,
        kind: row.kind || 'other',
        start_date: row.start_date || null,
        end_date: row.end_date || null,
        notes: row.notes || null,
        status_override: row.status_override || null,
        ...timing(row, today),
        flight_count: facts ? facts.flight_count : 0,
        route: facts ? facts.route : [],
        distance_km: facts ? facts.distance_km : 0,
        item_count: items,
        rev: row.current_rev,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    };
}

/* ---------- reads ---------- */

function cleanYear(v) {
    if (v == null || v === '') return null;
    if (!/^\d{4}$/.test(String(v))) throw bad('bad_year', 'year must be a year like 2026.');
    return String(v);
}

// Filters: phase (upcoming, ongoing, past, cancelled), year (the trip touches that year; undated trips are left
// out), limit / offset. Upcoming and ongoing trips come soonest first; otherwise newest first.
function list(db, { phase, year, limit, offset, now = new Date() } = {}) {
    const ph = phase == null || phase === '' || phase === 'all' ? null : oneOf(phase, 'phase', PHASES);
    const y = cleanYear(year);
    const today = todayIn(hubTz(db), now);
    const soonest = ph === 'upcoming' || ph === 'ongoing';
    let rows = db.prepare(`SELECT * FROM trips ORDER BY COALESCE(start_date, end_date) IS NULL, COALESCE(start_date, end_date) ${soonest ? 'ASC' : 'DESC'}, id ${soonest ? 'ASC' : 'DESC'}`).all();
    if (y) rows = rows.filter((r) => (r.start_date || r.end_date) && (r.start_date || r.end_date) <= `${y}-12-31` && (r.end_date || r.start_date) >= `${y}-01-01`);
    if (ph) rows = rows.filter((r) => timing(r, today).phase === ph);
    const off = clampOffset(offset);
    const lim = limitOrDefault(limit, 50, LIST_MAX);
    const page = rows.slice(off, off + lim);
    const facts = flightFacts(db, page.map((r) => r.id));
    const items = itemCounts(db);
    return { total: rows.length, offset: off, limit: lim, trips: page.map((r) => shape(r, today, facts.get(r.id), items.get(r.id) || 0)) };
}

// The flights of a trip in the flights shape, without the booking reference (has_booking_ref instead).
function flightsOf(db, id) {
    const flights = flightsSvc();
    return flights.tripFlights(db, id).map((f) => {
        const out = flights.withoutRef(f);
        if (f.booking_ref) out.has_booking_ref = true;
        return out;
    });
}

// The deadlines that name this trip: id, title, kind, due date, status and days left. No reference, no money.
function deadlinesOf(db, id, today) {
    return db.prepare('SELECT id, title, kind, due_date, status FROM deadlines WHERE trip_id = ? ORDER BY due_date, id').all(id)
        .map((d) => ({ ...d, days_left: d.status === 'active' ? dayDiff(today, d.due_date) : null }));
}

// One trip with its flights, deadlines and items. A revision (rev) shows the trip's own fields as they were then.
// reference: true puts the items' references in (the caller decides who may ask); otherwise has_reference only.
function get(db, id, { rev, now = new Date(), reference = false } = {}) {
    const row = need(db, id);
    const today = todayIn(hubTz(db), now);
    let base = row;
    if (rev != null && rev !== '' && Number(rev) !== row.current_rev) {
        const r = findRevision(db, REVISIONS, row.id, rev);
        if (!r) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        base = { ...row, ...JSON.parse(r.snapshot), current_rev: r.rev, updated_at: r.at, updated_by: r.actor };
    }
    const items = require('./tripItems').rowsOf(db, row.id);
    return {
        ...shape(base, today, flightFacts(db, [row.id]).get(row.id), items.length),
        revisions: row.current_rev,
        flights: flightsOf(db, row.id),
        deadlines: deadlinesOf(db, row.id, today),
        items: items.map((r) => require('./tripItems').shape(r, { withRef: reference })),
    };
}

// Trips that are ongoing or start within `days` (default 60, 1-365), soonest first. Undated and cancelled trips
// are left out.
function upcoming(db, { days, limit, now = new Date() } = {}) {
    const d = days == null || days === '' ? 60 : Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw bad('bad_days', 'days must be a whole number from 1 to 365.');
    const today = todayIn(hubTz(db), now);
    const rows = db.prepare('SELECT * FROM trips WHERE COALESCE(start_date, end_date) IS NOT NULL ORDER BY COALESCE(start_date, end_date), id').all()
        .filter((r) => {
            const t = timing(r, today);
            return t.phase === 'ongoing' || (t.phase === 'upcoming' && t.days_to_start <= d);
        });
    const page = rows.slice(0, limitOrDefault(limit, 50, LIST_MAX));
    const facts = flightFacts(db, page.map((r) => r.id));
    const items = itemCounts(db);
    return page.map((r) => shape(r, today, facts.get(r.id), items.get(r.id) || 0));
}

// Newest first; what changed is read with get(id, { rev }). Revision rows carry no field values.
function history(db, id) {
    const row = need(db, id);
    return db.prepare('SELECT rev, source, actor, note, at FROM trip_revisions WHERE trip_id = ? ORDER BY rev DESC').all(row.id)
        .map((r) => ({ ...r, current: r.rev === row.current_rev }));
}

// The overview tile: how many trips there are.
function stats(db) {
    const r = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM trips').get();
    return { records: r.n, label: r.n === 1 ? 'trip' : 'trips', lastChange: r.last || null };
}

/* ---------- writes ---------- */

// What an audit row may say: id, title, revision, field NAMES (never values) and, for links, the flight.
const auditDetail = (result) => {
    const out = { id: result.id, title: result.title };
    if (result.rev != null) out.rev = result.rev;
    if (result.fields) out.fields = result.fields;
    if (result.flight_id) { out.flight_id = result.flight_id; out.flight = result.flight; }
    if (result.moved_from) out.moved_from = result.moved_from.id;
    return out;
};

const noteOf = (given) => (given.note ? String(given.note).slice(0, 200) : null);

function create(db, input, actor) {
    const given = input || {};
    const t = build(given);
    return db.transaction(() => {
        const at = stamp();
        const id = Number(db.prepare(`INSERT INTO trips (${FIELDS.join(', ')}, current_rev, created_at, updated_at, updated_by)
            VALUES (${FIELDS.map((k) => `@${k}`).join(', ')}, 0, @at, @at, @actor)`).run({ ...t, at, actor: who(actor) }).lastInsertRowid);
        return { status: 'created', id, title: t.title, rev: commit(db, id, { source: 'create', actor, note: noteOf(given) }) };
    })();
}

// Changes the fields sent; a field sent as null is cleared (title refuses that).
function update(db, id, input, actor) {
    const given = input || {};
    return db.transaction(() => {
        const row = need(db, id);
        if (!Object.keys(given).some((k) => FIELDS.includes(k))) throw bad('bad_request', `Send at least one of: ${FIELDS.join(', ')}.`);
        const t = build(given, row);
        const was = editable(row);
        const changed = FIELDS.filter((k) => t[k] !== was[k]);
        if (!changed.length) return { status: 'unchanged', id: row.id, title: row.title, rev: row.current_rev };
        write(db, row.id, t);
        const rev = commit(db, row.id, { source: 'edit', actor, note: noteOf(given) });
        return { status: 'updated', id: row.id, title: t.title, rev, fields: changed };
    })();
}

// Puts the trip back to how it was at `rev`, as a new revision. Links (flights, deadlines) are not part of a revision.
function restore(db, id, rev, actor) {
    return db.transaction(() => {
        const row = need(db, id);
        const old = findRevision(db, REVISIONS, row.id, rev);
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const was = build(JSON.parse(old.snapshot));
        const cur = editable(row);
        const changed = FIELDS.filter((k) => was[k] !== cur[k]);
        if (!changed.length) return { status: 'unchanged', id: row.id, title: row.title, rev: row.current_rev };
        write(db, row.id, was);
        return { status: 'updated', id: row.id, title: was.title, rev: commit(db, row.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` }), fields: changed };
    })();
}

/* ---------- flight links ---------- */

// The flight row or a 404 in this domain's words.
function needFlight(db, flightId) {
    const f = toId(flightId) && db.prepare('SELECT * FROM flights WHERE id = ?').get(toId(flightId));
    if (!f) throw bad('no_flight', `There is no flight ${String(flightId).slice(0, 20)}.`, 404);
    return f;
}

// Sets a flight's trip and keeps the flight's own history: the change is a flight revision too.
function setFlightTrip(db, flight, tripId, actor, note) {
    const flights = flightsSvc();
    db.prepare('UPDATE flights SET trip_id = ? WHERE id = ?').run(tripId, flight.id);
    flights.commit(db, flight.id, { source: 'edit', actor, note });
}

// Links a flight to this trip. A flight belongs to one trip: one already on another trip is moved, and the answer
// says from where (moved_from { id, title }).
function linkFlight(db, id, flightId, actor) {
    return db.transaction(() => {
        const trip = need(db, id);
        const f = needFlight(db, flightId);
        const flight = flightsSvc().label(f);
        if (f.trip_id === trip.id) return { status: 'unchanged', id: trip.id, title: trip.title, flight_id: f.id, flight, moved_from: null };
        const from = f.trip_id ? db.prepare('SELECT id, title FROM trips WHERE id = ?').get(f.trip_id) || null : null;
        setFlightTrip(db, f, trip.id, actor, from ? `Moved from trip ${from.id} to trip ${trip.id}` : `Linked to trip ${trip.id}`);
        return { status: from ? 'moved' : 'linked', id: trip.id, title: trip.title, flight_id: f.id, flight, moved_from: from };
    })();
}

// Takes a flight off this trip; the flight stays. A flight that is not on this trip is a 409.
function unlinkFlight(db, id, flightId, actor) {
    return db.transaction(() => {
        const trip = need(db, id);
        const f = needFlight(db, flightId);
        if (f.trip_id !== trip.id) throw bad('not_on_trip', `Flight ${f.id} is not on trip ${trip.id}.`, 409);
        setFlightTrip(db, f, null, actor, `Unlinked from trip ${trip.id}`);
        return { status: 'unlinked', id: trip.id, title: trip.title, flight_id: f.id, flight: flightsSvc().label(f) };
    })();
}

/* ---------- permanent delete (admin only: never on /hub or MCP) ---------- */

// What a delete touches: flights and deadlines lose the link (they stay), items and revisions go.
function removalPreview(db, id) {
    const t = need(db, id);
    return {
        id: t.id, label: t.title,
        counts: {
            flights: count(db, 'SELECT COUNT(*) AS n FROM flights WHERE trip_id = ?', t.id),
            deadlines: count(db, 'SELECT COUNT(*) AS n FROM deadlines WHERE trip_id = ?', t.id),
            items: count(db, 'SELECT COUNT(*) AS n FROM trip_items WHERE trip_id = ?', t.id),
        },
    };
}

// Flights that still use the trip block the delete (409 with the count) unless `unassign: true` frees them; the
// flights stay. Deadlines carry the trip as a plain number, so their link is cleared as well. Items go with the trip.
function remove(db, id, input) {
    needConfirm(bad, input);
    return db.transaction(() => {
        const p = removalPreview(db, id);
        if (p.counts.flights > 0 && input.unassign !== true) {
            throw bad('trip_in_use', `Trip ${p.label.slice(0, 60)} still has ${p.counts.flights} flight${p.counts.flights === 1 ? '' : 's'}. Unassign them first, or delete with unassign: true.`, 409, { flights: p.counts.flights });
        }
        db.prepare('UPDATE flights SET trip_id = NULL WHERE trip_id = ?').run(p.id);
        db.prepare('UPDATE deadlines SET trip_id = NULL WHERE trip_id = ?').run(p.id);
        db.prepare('DELETE FROM trips WHERE id = ?').run(p.id);
        return { status: 'deleted', ...p, unassigned: input.unassign === true };
    })();
}

// id, title and the counts: never notes.
const removedAuditDetail = (r) => ({ id: r.id, trip: r.label, ...r.counts, unassigned: r.unassigned });

/* ---------- the shape the flights trip routes have always answered ---------- */

const legacyShape = (t, flights) => ({
    id: t.id, title: t.title, start_date: t.start_date, end_date: t.end_date, notes: t.notes,
    flights, created_at: t.created_at, updated_at: t.updated_at, updated_by: t.updated_by,
});

// Every trip with its flight count, newest start first (undated last).
function listLegacy(db) {
    const counts = new Map(db.prepare('SELECT trip_id, COUNT(*) AS n FROM flights WHERE trip_id IS NOT NULL GROUP BY trip_id').all().map((r) => [r.trip_id, r.n]));
    return db.prepare('SELECT * FROM trips ORDER BY start_date IS NULL, start_date DESC, id DESC').all().map((t) => legacyShape(t, counts.get(t.id) || 0));
}

module.exports = {
    TripError, KINDS, PHASES, FIELDS, LEGACY_FIELDS, LIST_MAX,
    build, need, exists, timing, shape, dayDiff, cleanDate,
    list, get, upcoming, history, stats, create, update, restore, auditDetail,
    linkFlight, unlinkFlight,
    removalPreview, remove, removedAuditDetail,
    legacyShape, listLegacy,
    // Items and suggestions live in their own files; these are the same functions.
    get items() { return require('./tripItems'); },
    suggest: (db, o) => require('./tripSuggest').suggest(db, o),
};
