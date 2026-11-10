// Flights: Atit's flight history and upcoming flights, with trips as a light grouping and a Passport (stats).
//
// MODEL (migration 007)
//   flights           one row per flight. Times are stored as UTC ISO strings. A time sent without an offset
//                     ("2027-03-01T10:05") is local to the airport (origin for departures, destination for
//                     arrivals) and needs that airport's zone. Derived on every write, never sent by callers:
//                     dep_tz / arr_tz (airports.tz), dep_local_date (the dedupe date) and distance_km
//                     (haversine between the airports, null when either is not in the airports table).
//   flight_revisions  every change stores all editable fields as a new revision (rev 1 = as first filed, never
//                     rewritten); restore puts a flight back to an earlier revision as a new revision.
//   trips             title, start_date, end_date, notes. flights.trip_id links to one (or none).
//   airports          static seed (db/seed.js). airlines: optional names by IATA code.
//   flight_settings   home_airport (an IATA code), set by hand.
//
// DEDUPE: airline_iata + flight_number + local departure date + origin_iata is one flight, and so is
// source + source_key. A second filing answers 409 "duplicate" with the existing id.
// Nothing is deleted: a flight that did not happen gets status cancelled (a real delete is for later, admin only).
//
// PRIVACY: booking_ref is stored, but only ever appears in answers to keys with flights:read. It is never in
// audit rows (auditDetail), error messages, stats() or overview(), and no error message echoes a value.
const { HubError } = require('./errors');

// Stored `status` has three values, but 'scheduled' means AUTOMATIC: the effective status (what every answer
// shows as `status`) is cancelled if stored cancelled; completed if stored completed or the flight has landed
// (actual_arr, else sched_arr, else sched_dep, is before now, UTC); otherwise scheduled. `status_override` is
// null (automatic) or the stored completed/cancelled. Inputs also accept 'auto' (stored as 'scheduled').
const STATUSES = ['scheduled', 'completed', 'cancelled'];
const STATUS_INPUTS = ['auto', ...STATUSES];
const SOURCES = ['manual', 'gmail', 'calendar', 'feed'];
const FIELDS = ['trip_id', 'airline_iata', 'airline_name', 'flight_number', 'origin_iata', 'dest_iata', 'sched_dep', 'sched_arr',
    'actual_dep', 'actual_arr', 'aircraft_type', 'cabin', 'seat', 'booking_ref', 'status', 'source', 'source_key', 'notes'];
const SETTINGS = ['home_airport'];
const MAX_NOTES = 2000;
const MAX_FLIGHT_HOURS = 30;
const EARTH_RADIUS_KM = 6371.0088;

class FlightError extends HubError {
    constructor(status, code, message, extra) {
        super(status, code, message);
        if (extra) this.extra = extra;
    }
}

const bad = (code, message, status = 400, extra) => new FlightError(status, code, message, extra);
const now = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');

/* ---------- geometry and time ---------- */

const rad = (deg) => (deg * Math.PI) / 180;
function haversineKm(lat1, lon1, lat2, lon2) {
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const formatters = new Map();
function partsIn(ms, tz) {
    const key = tz || 'UTC';
    if (!formatters.has(key)) {
        formatters.set(key, new Intl.DateTimeFormat('en-US', {
            timeZone: key, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }));
    }
    const p = Object.fromEntries(formatters.get(key).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return p;
}

// Milliseconds the zone is ahead of UTC at that instant.
function offsetMs(ms, tz) {
    const p = partsIn(ms, tz);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// "2027-03-01T10:05" as wall-clock time in tz, as a UTC instant (ms).
function localToUtc(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    let utc = guess - offsetMs(guess, tz);
    utc = guess - offsetMs(utc, tz);
    return utc;
}

// "YYYY-MM-DDTHH:MM" as the clock reads in tz.
function localIso(iso, tz) {
    if (!iso) return null;
    const p = partsIn(Date.parse(iso), tz);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const localDate = (iso, tz) => localIso(iso, tz).slice(0, 10);

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

// A time from a caller, as a UTC ISO string. `tz` is the zone a time without an offset is read in.
function cleanTime(v, name, tz, { required = false } = {}) {
    if (v == null || v === '') {
        if (required) throw bad('bad_request', `${name} is required.`);
        return null;
    }
    const s = String(v).trim();
    let ms;
    if (ZONED_RE.test(s)) ms = Date.parse(s.replace(' ', 'T'));
    else {
        const m = LOCAL_RE.exec(s);
        if (!m) throw bad('bad_time', `${name} must be an ISO date and time, for example 2027-03-01T10:05Z or 2027-03-01T10:05 (airport time).`);
        if (!tz) throw bad('bad_time', `${name} has no UTC offset and the airport's time zone is not known; send it with Z or an offset.`);
        ms = localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
    }
    if (!Number.isFinite(ms)) throw bad('bad_time', `${name} is not a valid date and time.`);
    return new Date(ms).toISOString();
}

/* ---------- cleaning ---------- */

function toId(v) {
    const id = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function text(v, name, max, { upper = false } = {}) {
    if (v == null) return null;
    if (typeof v !== 'string' && typeof v !== 'number') throw bad('bad_request', `${name} must be text.`);
    const s = String(v).normalize('NFKC').trim();
    if (!s) return null;
    if (s.length > max) throw bad('bad_request', `${name} is longer than ${max} characters.`);
    return upper ? s.toUpperCase() : s;
}

function cleanAirline(v) {
    const s = text(v, 'airline_iata', 3, { upper: true });
    if (!s || !/^[A-Z0-9]{2,3}$/.test(s)) throw bad('bad_airline', 'airline_iata must be a 2-letter IATA (or 3-letter ICAO) airline code, for example AA.');
    return s;
}

// "AA 0123", "aa123" and "123" are the same flight number for AA: 123.
function cleanFlightNumber(v, airline) {
    let s = text(v, 'flight_number', 12, { upper: true });
    if (s) s = s.replace(/\s+/g, '');
    if (s && airline && s.startsWith(airline) && /^\d/.test(s.slice(airline.length))) s = s.slice(airline.length);
    if (!s || !/^\d{1,5}[A-Z]?$/.test(s)) throw bad('bad_flight_number', 'flight_number must be digits (with an optional letter), for example 1234.');
    return s.replace(/^0+(?=\d)/, '');
}

function cleanIata(v, name) {
    const s = text(v, name, 3, { upper: true });
    if (!s || !/^[A-Z]{3}$/.test(s)) throw bad('bad_airport', `${name} must be a 3-letter IATA airport code, for example LIT.`);
    return s;
}

function cleanBookingRef(v) {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(v.trim())) throw bad('bad_booking_ref', 'booking_ref must be up to 20 letters or digits.');
    return v.trim().toUpperCase();
}

function oneOf(v, name, list) {
    if (!list.includes(v)) throw bad(`bad_${name}`, `${name} must be one of: ${list.join(', ')}.`);
    return v;
}

function cleanStatus(v) {
    const s = oneOf(v == null || v === '' ? 'auto' : v, 'status', STATUS_INPUTS);
    return s === 'auto' ? 'scheduled' : s;
}

// The one place the effective status is worked out (see the top of the file). `at` is a Date, ISO string or ms.
function effectiveStatus(row, at = new Date()) {
    if (row.status === 'cancelled') return 'cancelled';
    if (row.status === 'completed') return 'completed';
    const end = row.actual_arr || row.sched_arr || row.sched_dep;
    return end && Date.parse(end) < new Date(at).getTime() ? 'completed' : 'scheduled';
}

// The same rule in SQL; `p` is the placeholder (@now or ?) for now (ISO, UTC). Times are stored as ISO UTC strings,
// so they compare as text.
const effectiveSql = (p) => `(CASE WHEN status = 'cancelled' THEN 'cancelled'
    WHEN status = 'completed' OR COALESCE(actual_arr, sched_arr, sched_dep) < ${p} THEN 'completed' ELSE 'scheduled' END)`;

const airport = (db, iata) => (iata ? db.prepare('SELECT * FROM airports WHERE iata = ?').get(iata) || null : null);

function cleanTrip(db, v) {
    if (v == null || v === '') return null;
    const id = toId(v);
    if (!id || !db.prepare('SELECT 1 FROM trips WHERE id = ?').get(id)) throw bad('no_trip', `There is no trip ${String(v).slice(0, 20)}.`, 404);
    return id;
}

// The complete, valid editable fields from `input` laid over `current` (a stored flight, for edits), plus the
// derived ones. Times not sent stay as stored (UTC), so changing an airport never shifts them.
function build(db, input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!FIELDS.includes(k) && k !== 'note') throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const f = {};
    f.airline_iata = cleanAirline(pick('airline_iata'));
    f.flight_number = cleanFlightNumber(pick('flight_number'), f.airline_iata);
    f.airline_name = text(pick('airline_name'), 'airline_name', 80);
    f.origin_iata = cleanIata(pick('origin_iata'), 'origin_iata');
    f.dest_iata = cleanIata(pick('dest_iata'), 'dest_iata');
    if (f.origin_iata === f.dest_iata) throw bad('bad_airport', 'origin_iata and dest_iata are the same airport.');
    const from = airport(db, f.origin_iata);
    const to = airport(db, f.dest_iata);
    const depTz = from ? from.tz : null;
    const arrTz = to ? to.tz : null;
    f.sched_dep = cleanTime(pick('sched_dep'), 'sched_dep', depTz, { required: true });
    f.sched_arr = cleanTime(pick('sched_arr'), 'sched_arr', arrTz);
    f.actual_dep = cleanTime(pick('actual_dep'), 'actual_dep', depTz);
    f.actual_arr = cleanTime(pick('actual_arr'), 'actual_arr', arrTz);
    for (const [dep, arr] of [['sched_dep', 'sched_arr'], ['actual_dep', 'actual_arr']]) {
        if (f[dep] && f[arr]) {
            const hours = (Date.parse(f[arr]) - Date.parse(f[dep])) / 3600000;
            if (hours <= 0) throw bad('bad_time', `${arr} must be after ${dep}.`);
            if (hours > MAX_FLIGHT_HOURS) throw bad('bad_time', `${arr} is more than ${MAX_FLIGHT_HOURS} hours after ${dep}.`);
        }
    }
    f.aircraft_type = text(pick('aircraft_type'), 'aircraft_type', 40);
    f.cabin = text(pick('cabin'), 'cabin', 30);
    f.seat = text(pick('seat'), 'seat', 8, { upper: true });
    f.booking_ref = cleanBookingRef(pick('booking_ref'));
    f.status = cleanStatus(pick('status'));
    f.source = oneOf(pick('source') == null ? 'manual' : pick('source'), 'source', SOURCES);
    f.source_key = text(pick('source_key'), 'source_key', 128);
    f.notes = text(pick('notes'), 'notes', MAX_NOTES);
    f.trip_id = cleanTrip(db, pick('trip_id'));

    const derived = {
        dep_tz: depTz,
        arr_tz: arrTz,
        dep_local_date: localDate(f.sched_dep, depTz),
        distance_km: from && to ? Math.round(haversineKm(from.lat, from.lon, to.lat, to.lon) * 10) / 10 : null,
    };
    return { fields: f, derived };
}

/* ---------- rows ---------- */

const editable = (row) => Object.fromEntries(FIELDS.map((k) => [k, row[k] == null ? null : row[k]]));
const label = (f) => `${f.airline_iata} ${f.flight_number} ${f.origin_iata}-${f.dest_iata} ${f.dep_local_date}`;

function need(db, id) {
    const row = toId(id) && db.prepare('SELECT * FROM flights WHERE id = ?').get(toId(id));
    if (!row) throw bad('not_found', `There is no flight ${String(id).slice(0, 20)}.`, 404);
    return row;
}

// Another flight that is this one (same key or same source key), or null.
function twin(db, f, derived, exceptId = 0) {
    const same = db.prepare('SELECT id FROM flights WHERE airline_iata = ? AND flight_number = ? AND dep_local_date = ? AND origin_iata = ? AND id != ?')
        .get(f.airline_iata, f.flight_number, derived.dep_local_date, f.origin_iata, exceptId);
    if (same) return same.id;
    if (f.source_key) {
        const keyed = db.prepare('SELECT id FROM flights WHERE source = ? AND source_key = ? AND id != ?').get(f.source, f.source_key, exceptId);
        if (keyed) return keyed.id;
    }
    return null;
}

function noTwin(db, f, derived, exceptId) {
    const id = twin(db, f, derived, exceptId);
    if (id) throw bad('duplicate', `This flight is already filed as flight ${id}.`, 409, { id });
}

function write(db, id, f, d) {
    db.prepare(`UPDATE flights SET ${FIELDS.map((k) => `${k} = @${k}`).join(', ')},
        dep_tz = @dep_tz, arr_tz = @arr_tz, dep_local_date = @dep_local_date, distance_km = @distance_km WHERE id = @id`)
        .run({ ...f, ...d, id });
}

// Stores the flight as it is now as its next revision. Every change ends here.
function commit(db, id, { source, actor, note }) {
    const row = db.prepare('SELECT * FROM flights WHERE id = ?').get(id);
    const rev = row.current_rev + 1;
    const at = now();
    db.prepare('INSERT INTO flight_revisions (flight_id, rev, snapshot, source, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, rev, JSON.stringify(editable(row)), source, who(actor), note || null, at);
    db.prepare('UPDATE flights SET current_rev = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(rev, at, who(actor), id);
    return rev;
}

function shape(row, airlines, at) {
    const out = { id: row.id, ...editable(row) };
    out.status = effectiveStatus(row, at);
    out.status_override = row.status === 'scheduled' ? null : row.status;
    if (!out.airline_name && airlines) out.airline_name = airlines.get(row.airline_iata) || null;
    return {
        ...out,
        dep_tz: row.dep_tz,
        arr_tz: row.arr_tz,
        dep_local: localIso(row.sched_dep, row.dep_tz),
        arr_local: localIso(row.sched_arr, row.arr_tz),
        dep_local_date: row.dep_local_date,
        distance_km: row.distance_km,
        rev: row.current_rev,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    };
}

const airlineNames = (db) => new Map(db.prepare('SELECT iata, name FROM airlines').all().map((a) => [a.iata, a.name]));

/* ---------- reading ---------- */

function cleanYear(v) {
    if (v == null || v === '') return null;
    if (!/^\d{4}$/.test(String(v))) throw bad('bad_year', 'year must be four digits, for example 2026.');
    return String(v);
}

// Newest departure first. Filters: year (local departure year), airport (either end), airline, trip, status.
function list(db, { year, airport: ap, airline, trip, status, limit, offset, now: at = new Date() } = {}) {
    const where = [];
    const args = [];
    const nowIso = new Date(at).toISOString();
    const y = cleanYear(year);
    if (y) { where.push('substr(dep_local_date, 1, 4) = ?'); args.push(y); }
    if (ap != null && ap !== '') { const c = cleanIata(ap, 'airport'); where.push('(origin_iata = ? OR dest_iata = ?)'); args.push(c, c); }
    if (airline != null && airline !== '') { where.push('airline_iata = ?'); args.push(cleanAirline(airline)); }
    if (trip != null && trip !== '') {
        const t = toId(trip);
        if (!t) throw bad('bad_request', 'trip must be a trip id.');
        where.push('trip_id = ?'); args.push(t);
    }
    if (status != null && status !== '') { where.push(`${effectiveSql('?')} = ?`); args.push(nowIso, oneOf(status, 'status', STATUSES)); }
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const skip = Math.max(parseInt(offset, 10) || 0, 0);
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM flights ${cond}`).get(...args).n;
    const names = airlineNames(db);
    const rows = db.prepare(`SELECT * FROM flights ${cond} ORDER BY sched_dep DESC, id DESC LIMIT ? OFFSET ?`).all(...args, n, skip);
    return { flights: rows.map((r) => shape(r, names, nowIso)), total, limit: n, offset: skip };
}

// One flight. `rev` gives it as it was at that revision.
function get(db, id, { rev, now: at = new Date() } = {}) {
    const row = need(db, id);
    const names = airlineNames(db);
    if (rev == null || rev === '' || Number(rev) === row.current_rev) return { ...shape(row, names, at), revisions: row.current_rev };
    const r = db.prepare('SELECT * FROM flight_revisions WHERE flight_id = ? AND rev = ?').get(row.id, toId(rev));
    if (!r) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
    const old = JSON.parse(r.snapshot);
    return { ...shape({ ...row, ...old, current_rev: r.rev, updated_at: r.at, updated_by: r.actor }, names, at), revisions: row.current_rev };
}

// Newest first; what changed is read with get(id, { rev }).
function history(db, id) {
    const row = need(db, id);
    return db.prepare('SELECT rev, source, actor, note, at FROM flight_revisions WHERE flight_id = ? ORDER BY rev DESC').all(row.id)
        .map((r) => ({ ...r, current: r.rev === row.current_rev }));
}

// Flights whose effective status is scheduled (not cancelled, not completed, not landed; in the air counts), soonest first.
function upcoming(db, { now: at = new Date(), limit } = {}) {
    const iso = new Date(at).toISOString();
    const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 50);
    const names = airlineNames(db);
    return db.prepare(`SELECT * FROM flights WHERE ${effectiveSql('@iso')} = 'scheduled'
            AND (sched_dep >= @iso OR (sched_arr IS NOT NULL AND sched_arr > @iso)) ORDER BY sched_dep, id LIMIT @n`)
        .all({ iso, n }).map((r) => shape(r, names, iso));
}

// For the dashboard tile and hub_overview: counts and the last change, nothing about any one flight.
function overview(db) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM flights').get().n;
    const last = db.prepare('SELECT MAX(updated_at) AS at FROM flights').get().at;
    return { records: total, label: total === 1 ? 'flight' : 'flights', lastChange: last };
}

/* ---------- stats (the Passport) ----------
   Counts flights that are not cancelled and have departed by `now` (upcoming ones are only counted, under
   `upcoming`). Time in the air comes from the scheduled times. Flights whose airports are not in the
   airports table count as flights but add no distance, country or record; they are listed under `unmatched`.
   Never carries booking references, seats or notes. */

// Flown (the Passport): not cancelled, and departed by @iso or already completed (by hand or by landing).
const FLOWN_SQL = `status != 'cancelled' AND (sched_dep <= @iso OR ${effectiveSql('@iso')} = 'completed')`;

const hoursOf = (r) => (r.sched_dep && r.sched_arr ? (Date.parse(r.sched_arr) - Date.parse(r.sched_dep)) / 3600000 : 0);
const round1 = (n) => Math.round(n * 10) / 10;
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

function stats(db, { year, now: at = new Date() } = {}) {
    const y = cleanYear(year);
    const iso = new Date(at).toISOString();
    const flown = db.prepare(`SELECT * FROM flights WHERE ${FLOWN_SQL} ORDER BY sched_dep`).all({ iso });
    const upcomingCount = db.prepare(`SELECT COUNT(*) AS n FROM flights WHERE ${effectiveSql('@iso')} = 'scheduled' AND sched_dep > @iso`).get({ iso }).n;
    const airports = new Map();
    const known = (code) => {
        if (!airports.has(code)) airports.set(code, airport(db, code));
        return airports.get(code);
    };
    const names = airlineNames(db);

    const perYear = new Map();
    for (const r of flown) {
        const yr = r.dep_local_date.slice(0, 4);
        const p = perYear.get(yr) || { year: yr, flights: 0, distance_km: 0, hours: 0 };
        p.flights += 1;
        p.distance_km += r.distance_km || 0;
        p.hours += hoursOf(r);
        perYear.set(yr, p);
    }

    const rows = y ? flown.filter((r) => r.dep_local_date.startsWith(y)) : flown;
    const visits = new Map();
    const countries = new Set();
    const airlines = new Map();
    const aircraft = new Map();
    const routes = new Map();
    const unmatchedAirports = new Set();
    let unmatchedFlights = 0;
    let distance = 0;
    let hours = 0;
    let longest = null;
    let shortest = null;
    for (const r of rows) {
        hours += hoursOf(r);
        for (const code of [r.origin_iata, r.dest_iata]) {
            visits.set(code, (visits.get(code) || 0) + 1);
            const a = known(code);
            if (a) countries.add(a.country);
            else unmatchedAirports.add(code);
        }
        airlines.set(r.airline_iata, (airlines.get(r.airline_iata) || 0) + 1);
        if (!names.has(r.airline_iata) && r.airline_name) names.set(r.airline_iata, r.airline_name);
        if (r.aircraft_type) aircraft.set(r.aircraft_type, (aircraft.get(r.aircraft_type) || 0) + 1);
        const route = [r.origin_iata, r.dest_iata].sort().join('-');
        routes.set(route, (routes.get(route) || 0) + 1);
        if (r.distance_km == null) { unmatchedFlights += 1; continue; }
        distance += r.distance_km;
        const rec = { id: r.id, route: `${r.origin_iata}-${r.dest_iata}`, airline_iata: r.airline_iata, flight_number: r.flight_number, date: r.dep_local_date, distance_km: r.distance_km };
        if (!longest || r.distance_km > longest.distance_km) longest = rec;
        if (!shortest || r.distance_km < shortest.distance_km) shortest = rec;
    }

    const airportInfo = (code) => {
        const a = known(code);
        return a ? { iata: code, name: a.name, city: a.city, country: a.country } : { iata: code, name: null, city: null, country: null };
    };
    return {
        year: y,
        flights: rows.length,
        distance_km: Math.round(distance),
        hours: round1(hours),
        airports: visits.size,
        countries: countries.size,
        airlines: airlines.size,
        aircraft_types: aircraft.size,
        longest,
        shortest,
        top_airports: top(visits, 10).map(([code, n]) => ({ ...airportInfo(code), visits: n })),
        top_routes: top(routes, 10).map(([route, n]) => ({ route, flights: n })),
        top_airlines: top(airlines, 10).map(([code, n]) => ({ iata: code, name: names.get(code) || null, flights: n })),
        top_aircraft: top(aircraft, 10).map(([type, n]) => ({ type, flights: n })),
        country_list: [...countries].sort(),
        per_year: [...perYear.values()].sort((a, b) => (a.year < b.year ? -1 : 1))
            .map((p) => ({ ...p, distance_km: Math.round(p.distance_km), hours: round1(p.hours) })),
        upcoming: upcomingCount,
        unmatched: { flights: unmatchedFlights, airports: [...unmatchedAirports].sort() },
    };
}

/* ---------- airports and the map ---------- */

// Airports for the dashboard's autocomplete: IATA code first, then code or city prefix, then names. At most 20.
function searchAirports(db, q, { limit } = {}) {
    const term = String(q == null ? '' : q).trim().slice(0, 40);
    if (!term) return [];
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 20);
    const esc = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    return db.prepare(`SELECT iata, icao, name, city, country, lat, lon, tz FROM airports
        WHERE iata = @u OR iata LIKE @p ESCAPE '\\' OR icao LIKE @p ESCAPE '\\' OR city LIKE @p ESCAPE '\\' OR name LIKE @c ESCAPE '\\'
        ORDER BY (iata = @u) DESC, (iata LIKE @p ESCAPE '\\') DESC, (city LIKE @p ESCAPE '\\') DESC, name LIMIT @n`)
        .all({ u: term.toUpperCase(), p: `${esc}%`, c: `%${esc}%`, n });
}

// What the Passport map draws: the airports visited (with coordinates) and the routes between them, direction
// agnostic, for the flights `stats` counts (not cancelled, departed by now, optional year). Airports the hub
// does not know are left out. No flight ids, numbers, dates or booking references.
function mapData(db, { year, now: at = new Date() } = {}) {
    const y = cleanYear(year);
    const iso = new Date(at).toISOString();
    const rows = db.prepare(`SELECT origin_iata, dest_iata, dep_local_date FROM flights WHERE ${FLOWN_SQL}`).all({ iso })
        .filter((r) => !y || r.dep_local_date.startsWith(y));
    const visits = new Map();
    const routes = new Map();
    for (const r of rows) {
        for (const c of [r.origin_iata, r.dest_iata]) visits.set(c, (visits.get(c) || 0) + 1);
        const key = [r.origin_iata, r.dest_iata].sort().join('-');
        routes.set(key, (routes.get(key) || 0) + 1);
    }
    const known = new Map();
    for (const c of visits.keys()) {
        const a = airport(db, c);
        if (a) known.set(c, { iata: c, city: a.city, lat: a.lat, lon: a.lon, visits: visits.get(c) });
    }
    return {
        airports: [...known.values()].sort((a, b) => (a.iata < b.iata ? -1 : 1)),
        routes: [...routes.entries()].map(([k, n]) => ({ a: k.split('-')[0], b: k.split('-')[1], flights: n }))
            .filter((r) => known.has(r.a) && known.has(r.b)).sort((a, b) => b.flights - a.flights || (a.a + a.b < b.a + b.b ? -1 : 1)),
    };
}

/* ---------- writing ----------
   Each returns { status, id, label, rev }; status is created, updated or unchanged. */

function create(db, input, actor) {
    const { fields: f, derived: d } = build(db, input);
    return db.transaction(() => {
        noTwin(db, f, d, 0);
        const at = now();
        const id = Number(db.prepare(`INSERT INTO flights (${FIELDS.join(', ')}, dep_tz, arr_tz, dep_local_date, distance_km, current_rev, created_at, updated_at, updated_by)
            VALUES (${FIELDS.map((k) => `@${k}`).join(', ')}, @dep_tz, @arr_tz, @dep_local_date, @distance_km, 0, @at, @at, @actor)`)
            .run({ ...f, ...d, at, actor: who(actor) }).lastInsertRowid);
        return { status: 'created', id, label: label({ ...f, ...d }), rev: commit(db, id, { source: 'create', actor }) };
    })();
}

// Changes the fields sent; a field sent as null is cleared (required ones refuse that).
function update(db, id, input, actor) {
    const given = input || {};
    if (!Object.keys(given).some((k) => FIELDS.includes(k))) throw bad('bad_request', `Send at least one of: ${FIELDS.join(', ')}.`);
    return db.transaction(() => {
        const row = need(db, id);
        const { fields: f, derived: d } = build(db, given, row);
        const was = editable(row);
        if (FIELDS.every((k) => f[k] === was[k])) return { status: 'unchanged', id: row.id, label: label(row), rev: row.current_rev };
        noTwin(db, f, d, row.id);
        write(db, row.id, f, d);
        const note = given.note ? String(given.note).slice(0, 200) : null;
        return { status: 'updated', id: row.id, label: label({ ...f, ...d }), rev: commit(db, row.id, { source: 'edit', actor, note }) };
    })();
}

// Puts the flight back to how it was at `rev`, as a new revision. Derived fields are worked out again.
function restore(db, id, rev, actor) {
    return db.transaction(() => {
        const row = need(db, id);
        const old = toId(rev) && db.prepare('SELECT * FROM flight_revisions WHERE flight_id = ? AND rev = ?').get(row.id, toId(rev));
        if (!old) throw bad('no_revision', `Revision ${String(rev).slice(0, 10)} does not exist.`, 404);
        const was = JSON.parse(old.snapshot);
        if (JSON.stringify(was) === JSON.stringify(editable(row))) return { status: 'unchanged', id: row.id, label: label(row), rev: row.current_rev };
        // A trip that is gone since then is left out rather than refusing the restore.
        if (was.trip_id && !db.prepare('SELECT 1 FROM trips WHERE id = ?').get(was.trip_id)) was.trip_id = null;
        const { fields: f, derived: d } = build(db, was);
        noTwin(db, f, d, row.id);
        write(db, row.id, f, d);
        return { status: 'updated', id: row.id, label: label({ ...f, ...d }), rev: commit(db, row.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` }) };
    })();
}

// What an audit row may say about a flight change: id, flight number, route and date. Never the booking
// reference, seat or notes.
const auditDetail = (result) => ({ id: result.id, flight: result.label, rev: result.rev });

/* ---------- trips ---------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDate(v, name) {
    if (v == null || v === '') return null;
    if (!DATE_RE.test(String(v)) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad('bad_date', `${name} must be a date like 2027-03-01.`);
    return String(v);
}

function needTrip(db, id) {
    const t = toId(id) && db.prepare('SELECT * FROM trips WHERE id = ?').get(toId(id));
    if (!t) throw bad('no_trip', `There is no trip ${String(id).slice(0, 20)}.`, 404);
    return t;
}

function buildTrip(input, current = {}) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!['title', 'start_date', 'end_date', 'notes'].includes(k)) throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const pick = (k) => (given[k] === undefined ? current[k] : given[k]);
    const t = {
        title: text(pick('title'), 'title', 120),
        start_date: cleanDate(pick('start_date'), 'start_date'),
        end_date: cleanDate(pick('end_date'), 'end_date'),
        notes: text(pick('notes'), 'notes', MAX_NOTES),
    };
    if (!t.title) throw bad('bad_request', 'title is required.');
    if (t.start_date && t.end_date && t.end_date < t.start_date) throw bad('bad_date', 'end_date is before start_date.');
    return t;
}

const shapeTrip = (t, flights) => ({
    id: t.id, title: t.title, start_date: t.start_date, end_date: t.end_date, notes: t.notes,
    flights, created_at: t.created_at, updated_at: t.updated_at, updated_by: t.updated_by,
});

function listTrips(db) {
    const counts = new Map(db.prepare('SELECT trip_id, COUNT(*) AS n FROM flights WHERE trip_id IS NOT NULL GROUP BY trip_id').all().map((r) => [r.trip_id, r.n]));
    return db.prepare('SELECT * FROM trips ORDER BY start_date IS NULL, start_date DESC, id DESC').all().map((t) => shapeTrip(t, counts.get(t.id) || 0));
}

function getTrip(db, id) {
    const t = needTrip(db, id);
    const names = airlineNames(db);
    return shapeTrip(t, db.prepare('SELECT * FROM flights WHERE trip_id = ? ORDER BY sched_dep').all(t.id).map((r) => shape(r, names)));
}

function createTrip(db, input, actor) {
    const t = buildTrip(input);
    const at = now();
    const id = Number(db.prepare('INSERT INTO trips (title, start_date, end_date, notes, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(t.title, t.start_date, t.end_date, t.notes, at, at, who(actor)).lastInsertRowid);
    return { status: 'created', id, title: t.title };
}

function updateTrip(db, id, input, actor) {
    const old = needTrip(db, id);
    if (!input || !Object.keys(input).length) throw bad('bad_request', 'Send at least one of title, start_date, end_date or notes.');
    const t = buildTrip(input, old);
    if (['title', 'start_date', 'end_date', 'notes'].every((k) => t[k] === old[k])) return { status: 'unchanged', id: old.id, title: old.title };
    db.prepare('UPDATE trips SET title = ?, start_date = ?, end_date = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(t.title, t.start_date, t.end_date, t.notes, now(), who(actor), old.id);
    return { status: 'updated', id: old.id, title: t.title };
}

/* ---------- settings ---------- */

function getSettings(db) {
    const rows = new Map(db.prepare('SELECT key, value FROM flight_settings').all().map((r) => [r.key, r.value]));
    return Object.fromEntries(SETTINGS.map((k) => [k, rows.has(k) ? rows.get(k) : null]));
}

// Changes the settings sent (null clears one). home_airport must be an airport the hub knows.
function putSettings(db, input, actor) {
    const given = input || {};
    const keys = Object.keys(given);
    if (!keys.length) throw bad('bad_request', `Send at least one of: ${SETTINGS.join(', ')}.`);
    for (const k of keys) if (!SETTINGS.includes(k)) throw bad('bad_setting', `Unknown setting ${k.slice(0, 40)}; known: ${SETTINGS.join(', ')}.`);
    const values = {};
    if ('home_airport' in given) {
        values.home_airport = given.home_airport == null || given.home_airport === '' ? null : cleanIata(given.home_airport, 'home_airport');
        if (values.home_airport && !airport(db, values.home_airport)) throw bad('bad_airport', `${values.home_airport} is not an airport the hub knows.`);
    }
    const put = db.prepare(`INSERT INTO flight_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    db.transaction(() => { for (const [k, v] of Object.entries(values)) put.run(k, v, now(), who(actor)); })();
    return getSettings(db);
}

/* ---------- candidates: found flights waiting for a person (migration 008) ---------- */
// A job or an agent files a candidate (suggest, flights:suggest); a person accepts it, which creates the flight
// through create() (so the same cleaning and dedupe apply), or dismisses it. One candidate per source key and
// one per flight key, whatever its status, so a dismissed flight found again stays dismissed. Filing something
// that is already a flight or a candidate is not an error: the answer names what exists (200).

const CANDIDATE_STATUSES = ['pending', 'accepted', 'dismissed'];
const CANDIDATE_SOURCES = ['gmail', 'calendar', 'manual'];
const CANDIDATE_FIELDS = ['airline_iata', 'airline_name', 'flight_number', 'origin_iata', 'dest_iata', 'sched_dep', 'sched_arr',
    'booking_ref', 'cabin', 'seat', 'aircraft_type', 'notes'];
const ACCEPT_ALL_MAX = 100;

function cleanConfidence(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw bad('bad_confidence', 'confidence must be a number from 0 to 1.');
    return Math.round(n * 1000) / 1000;
}

function shapeCandidate(row) {
    return {
        id: row.id,
        ...Object.fromEntries(CANDIDATE_FIELDS.map((k) => [k, row[k] == null ? null : row[k]])),
        dep_tz: row.dep_tz,
        arr_tz: row.arr_tz,
        dep_local: localIso(row.sched_dep, row.dep_tz),
        arr_local: localIso(row.sched_arr, row.arr_tz),
        dep_local_date: row.dep_local_date,
        label: label(row),
        source: row.source,
        source_key: row.source_key,
        confidence: row.confidence,
        status: row.status,
        decided_at: row.decided_at,
        decided_by: row.decided_by,
        accepted_flight_id: row.accepted_flight_id,
        created_at: row.created_at,
        created_by: row.created_by,
    };
}

function needCandidate(db, id) {
    const row = toId(id) && db.prepare('SELECT * FROM flight_candidates WHERE id = ?').get(toId(id));
    if (!row) throw bad('not_found', `There is no flight candidate ${String(id).slice(0, 20)}.`, 404);
    return row;
}

// A suggest answer goes to keys that may lack flights:read, so it never carries a booking reference.
const withoutRef = ({ booking_ref: _ref, ...rest }) => rest;

// File a found flight. Answers { status, candidate } where status is filed (new, 201 over REST), exists (it
// is already flight `flight.id`; nothing filed) or already_suggested (the candidate that has it, any status).
function suggest(db, input, actor) {
    const given = input || {};
    for (const k of Object.keys(given)) {
        if (!CANDIDATE_FIELDS.includes(k) && !['source', 'source_key', 'confidence'].includes(k)) throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    const source = oneOf(given.source == null ? 'manual' : given.source, 'source', CANDIDATE_SOURCES);
    const confidence = cleanConfidence(given.confidence);
    const fields = Object.fromEntries(CANDIDATE_FIELDS.filter((k) => given[k] !== undefined).map((k) => [k, given[k]]));
    const { fields: f, derived: d } = build(db, { ...fields, source, source_key: given.source_key });
    return db.transaction(() => {
        const flightId = twin(db, f, d, 0);
        if (flightId) {
            const row = db.prepare('SELECT * FROM flights WHERE id = ?').get(flightId);
            return { status: 'exists', flight: { id: row.id, label: label(row) } };
        }
        const existing = db.prepare('SELECT * FROM flight_candidates WHERE airline_iata = ? AND flight_number = ? AND dep_local_date = ? AND origin_iata = ?')
            .get(f.airline_iata, f.flight_number, d.dep_local_date, f.origin_iata)
            || (f.source_key ? db.prepare('SELECT * FROM flight_candidates WHERE source = ? AND source_key = ?').get(source, f.source_key) : null);
        if (existing) return { status: 'already_suggested', candidate: withoutRef(shapeCandidate(existing)) };
        const id = Number(db.prepare(`INSERT INTO flight_candidates (${CANDIDATE_FIELDS.join(', ')}, dep_tz, arr_tz, dep_local_date, source, source_key,
            confidence, status, created_at, created_by) VALUES (${CANDIDATE_FIELDS.map((k) => `@${k}`).join(', ')}, @dep_tz, @arr_tz, @dep_local_date,
            @source, @source_key, @confidence, 'pending', @at, @actor)`)
            .run({ ...f, ...d, source, confidence, at: now(), actor: who(actor) }).lastInsertRowid);
        return { status: 'filed', candidate: withoutRef(shapeCandidate(db.prepare('SELECT * FROM flight_candidates WHERE id = ?').get(id))) };
    })();
}

function listCandidates(db, { status = 'pending', limit } = {}) {
    const s = status == null || status === '' ? 'pending' : status;
    if (s !== 'all') oneOf(s, 'status', CANDIDATE_STATUSES);
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const rows = s === 'all'
        ? db.prepare('SELECT * FROM flight_candidates ORDER BY sched_dep DESC, id DESC LIMIT ?').all(n)
        : db.prepare('SELECT * FROM flight_candidates WHERE status = ? ORDER BY sched_dep DESC, id DESC LIMIT ?').all(s, n);
    return rows.map(shapeCandidate);
}

function candidateCounts(db) {
    const counts = Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM flight_candidates GROUP BY status').all()) counts[r.status] = r.n;
    return counts;
}

function decide(db, row, status, flightId, actor) {
    db.prepare('UPDATE flight_candidates SET status = ?, accepted_flight_id = ?, decided_at = ?, decided_by = ? WHERE id = ?')
        .run(status, flightId, now(), who(actor), row.id);
    return shapeCandidate(db.prepare('SELECT * FROM flight_candidates WHERE id = ?').get(row.id));
}

// Turn a candidate into a flight through create(). `overrides` are flight fields that replace the found ones
// (a person corrected them); source and source_key always come from the candidate. A flight that already
// exists answers 409 duplicate with its id; the candidate stays as it was.
function acceptCandidate(db, id, overrides, actor) {
    const over = overrides || {};
    for (const k of Object.keys(over)) {
        if (!FIELDS.includes(k) || k === 'source' || k === 'source_key') throw bad('bad_field', `Unknown field ${k.slice(0, 40)}.`);
    }
    return db.transaction(() => {
        const c = needCandidate(db, id);
        if (c.status === 'accepted') throw bad('already_accepted', `Candidate ${c.id} is already accepted as flight ${c.accepted_flight_id}.`, 409, { id: c.accepted_flight_id });
        const found = Object.fromEntries(CANDIDATE_FIELDS.map((k) => [k, c[k]]));
        const flight = create(db, { ...found, ...over, source: c.source, source_key: c.source_key }, actor);
        return { status: 'accepted', candidate: decide(db, c, 'accepted', flight.id, actor), flight };
    })();
}

// Each id on its own: one failing (not found, duplicate, already accepted) does not stop the others.
function acceptAll(db, ids, actor) {
    if (!Array.isArray(ids) || ids.length === 0) throw bad('bad_request', 'Send ids: a list of candidate ids.');
    if (ids.length > ACCEPT_ALL_MAX) throw bad('bad_request', `Send at most ${ACCEPT_ALL_MAX} ids at a time.`);
    const results = ids.map((id) => {
        try {
            const r = acceptCandidate(db, id, null, actor);
            return { id: r.candidate.id, status: 'accepted', flight_id: r.flight.id, label: r.flight.label, rev: r.flight.rev };
        } catch (err) {
            if (!(err instanceof FlightError)) throw err;
            const out = { id: toId(id) || String(id).slice(0, 20), status: 'error', error: err.code, message: err.message };
            if (err.extra && err.extra.id) out.flight_id = err.extra.id;
            return out;
        }
    });
    return { accepted: results.filter((r) => r.status === 'accepted').length, failed: results.filter((r) => r.status !== 'accepted').length, results };
}

function dismissCandidate(db, id, actor) {
    return db.transaction(() => {
        const c = needCandidate(db, id);
        if (c.status === 'accepted') throw bad('already_accepted', `Candidate ${c.id} is already accepted as flight ${c.accepted_flight_id}; cancel the flight instead.`, 409, { id: c.accepted_flight_id });
        if (c.status === 'dismissed') return { status: 'unchanged', candidate: shapeCandidate(c) };
        return { status: 'dismissed', candidate: decide(db, c, 'dismissed', null, actor) };
    })();
}

// What an audit row may say about a candidate: its id, the flight label and the flight it became. Never the
// booking reference, seat or notes.
const candidateAuditDetail = (c, flight) => {
    const out = { id: c.id, flight: c.label };
    if (flight) Object.assign(out, { flight_id: flight.id, rev: flight.rev });
    return out;
};

module.exports = {
    STATUSES, STATUS_INPUTS, SOURCES, FIELDS, SETTINGS, FlightError, effectiveStatus,
    CANDIDATE_STATUSES, CANDIDATE_SOURCES, CANDIDATE_FIELDS, ACCEPT_ALL_MAX,
    suggest, listCandidates, candidateCounts, withoutRef, acceptCandidate, acceptAll, dismissCandidate, candidateAuditDetail,
    haversineKm, localToUtc, localIso,
    list, get, history, upcoming, overview, stats, searchAirports, mapData,
    create, update, restore, auditDetail,
    listTrips, getTrip, createTrip, updateTrip,
    getSettings, putSettings,
};
