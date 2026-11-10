// MCP tool for the flights domain. Reuses services/flights.js, so cleaning, dedupe and revisions behave exactly
// as through /hub/flights. Agents may read, file found flights (suggest) and, in write mode with flights:edit,
// add and edit flights; cancelling a flight is an edit (status cancelled). Deleting, restoring and accepting or
// dismissing found flights stay with a person (admin API).
// booking_ref: left out of every answer by default. `get` includes it only for a key with flights:read that
// passes include_booking_ref=true. The audit row (mcp_call) never holds arguments or results.
const flights = require('../../flights');
const { ToolError, clip } = require('../util');

const LIST_MAX = 50;
const NOTES_CHARS = 300;
const EDIT_FIELDS = ['trip_id', 'airline_iata', 'airline_name', 'flight_number', 'origin_iata', 'dest_iata', 'sched_dep', 'sched_arr',
    'actual_dep', 'actual_arr', 'aircraft_type', 'cabin', 'seat', 'booking_ref', 'status', 'notes'];

function need(value, what, action) {
    if (value == null || value === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`);
    return value;
}

// A flight for an agent: no booking reference unless asked for, notes cut in lists.
function flight(f, { notesMax = NOTES_CHARS, withRef = false } = {}) {
    const { booking_ref: ref, source_key: _key, created_at: _c, updated_by: _u, ...out } = f;
    if (withRef) out.booking_ref = ref;
    else if (ref) out.has_booking_ref = true;
    if (notesMax) {
        const n = clip(out.notes, notesMax);
        out.notes = n.text;
        if (n.truncated) out.notesTruncated = true;
    }
    return out;
}

function candidate(c) {
    const { booking_ref: ref, source_key: _key, ...out } = c;
    if (ref) out.has_booking_ref = true;
    const n = clip(out.notes, NOTES_CHARS);
    out.notes = n.text;
    return out;
}

const pick = (args, names) => Object.fromEntries(names.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

module.exports = {
    domain: 'flights',
    readScope: 'flights:read',
    // Notes and found flights come from email, the calendar and agents, so results are marked as data.
    untrusted: true,
    description: "Atit's flights: past and upcoming flights, trips that group them, and the Passport (distance, hours, airports, countries, airlines). "
        + 'Times: sched_dep/sched_arr/actual_* are UTC (ISO with Z); dep_local/arr_local are the same times as the airport clock reads (origin for departure, destination for arrival), with dep_tz/arr_tz. '
        + 'When adding or suggesting, a time with Z or an offset is taken as given; one without an offset is read as the airport\'s local time. '
        + 'status is worked out from the times (scheduled before landing, completed after), unless status_override says completed or cancelled was set by hand. '
        + 'Booking references are left out (has_booking_ref says one is stored).',
    actions: {
        list: { scope: 'flights:read', describe: `list: flights, newest departure first (optional year, airport, airline, trip_id, status; limit 1-${LIST_MAX}, offset)` },
        get: { scope: 'flights:read', describe: 'get: one flight (id); include_booking_ref=true adds its booking reference' },
        upcoming: { scope: 'flights:read', describe: 'upcoming: scheduled flights (not cancelled, not completed) that have not landed yet, soonest first (limit 1-20)' },
        stats: { scope: 'flights:read', describe: 'stats: the Passport for flights flown so far (optional year): distance, hours, airports, countries, airlines, routes, per year' },
        trips: { scope: 'flights:read', describe: 'trips: the trips with how many flights each has' },
        candidates: { scope: 'flights:read', describe: `candidates: found flights in the review queue (status pending (default), accepted, dismissed or all; limit 1-${LIST_MAX})` },
        suggest: { scope: 'flights:suggest', write: true, describe: 'suggest: file a found flight for Atit to review (airline_iata, flight_number, origin_iata, dest_iata, sched_dep; optional sched_arr, airline_name, cabin, seat, aircraft_type, booking_ref, notes, source gmail/calendar/manual, source_key, confidence 0-1). Already a flight or already filed: says so and files nothing' },
        add: { scope: 'flights:edit', write: true, describe: 'add: file a flight directly (same fields as suggest, plus trip_id, status). Prefer suggest for flights you found yourself' },
        edit: { scope: 'flights:edit', write: true, describe: 'edit: change one flight (id; only the fields sent change, null clears; status cancelled for a flight that did not happen; optional note = why). Every change is kept as a revision' },
    },

    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        const code = (n) => z.string().max(n);
        if (has('list')) {
            shape.year = z.string().regex(/^\d{4}$/).optional().describe('list/stats: a year, like 2026');
            shape.airport = code(3).optional().describe('list: flights from or to this IATA airport');
            shape.offset = z.number().int().min(0).optional().describe('list: skip this many');
        } else if (has('stats')) shape.year = z.string().regex(/^\d{4}$/).optional().describe('stats: a year, like 2026');
        if (has('list', 'upcoming', 'candidates')) shape.limit = z.number().int().min(1).max(LIST_MAX).optional().describe('list/upcoming/candidates: how many');
        if (has('list', 'add', 'edit')) shape.status = z.string().max(20).optional().describe('list: filter by effective status (scheduled, completed, cancelled); add/edit: auto (default: scheduled until it has landed, then completed), completed or cancelled; candidates: pending, accepted, dismissed or all');
        else if (has('candidates')) shape.status = z.string().max(20).optional().describe('candidates: pending, accepted, dismissed or all');
        if (has('get', 'edit')) shape.id = z.number().int().positive().optional().describe('get/edit: the flight id');
        if (has('get')) shape.include_booking_ref = z.boolean().optional().describe('get: true to include the booking reference');
        if (has('list', 'suggest', 'add', 'edit')) shape.airline_iata = code(3).optional().describe('the airline code, like AA (list: filter)');
        if (has('suggest', 'add', 'edit')) {
            shape.flight_number = z.union([code(12), z.number()]).optional().describe('the number, like 1234 (AA1234 works too)');
            shape.origin_iata = code(3).optional().describe('departure airport, IATA, like LIT');
            shape.dest_iata = code(3).optional().describe('arrival airport, IATA, like DFW');
            shape.sched_dep = code(40).optional().describe('scheduled departure: 2027-03-01T10:05Z (UTC) or 2027-03-01T10:05 (origin airport time)');
            shape.sched_arr = code(40).nullable().optional().describe('scheduled arrival: UTC with Z, or destination airport time');
            shape.airline_name = code(80).nullable().optional();
            shape.aircraft_type = code(40).nullable().optional().describe('like A321 or Boeing 737-800');
            shape.cabin = code(30).nullable().optional().describe('like economy');
            shape.seat = code(8).nullable().optional().describe('like 14C');
            shape.booking_ref = code(20).nullable().optional().describe('the booking reference (stored privately)');
            shape.notes = z.string().max(2000).nullable().optional();
        }
        if (has('suggest')) {
            shape.source = z.enum(flights.CANDIDATE_SOURCES).optional().describe('suggest: where it was found (default manual)');
            shape.source_key = code(128).optional().describe('suggest: a stable id from the source (hashed), so a re-scan files nothing twice');
            shape.confidence = z.number().min(0).max(1).optional().describe('suggest: how sure the reading is, 0-1');
        }
        if (has('edit')) {
            shape.actual_dep = code(40).nullable().optional().describe('edit: actual departure, as sched_dep');
            shape.actual_arr = code(40).nullable().optional().describe('edit: actual arrival, as sched_arr');
            shape.note = z.string().max(200).optional().describe('edit: why it changed');
        }
        if (has('list', 'add', 'edit')) shape.trip_id = z.number().int().positive().nullable().optional().describe('list: flights of this trip; add/edit: the trip (edit: null takes it out)');
        return shape;
    },

    run(action, args, { db, key }) {
        switch (action) {
        case 'list': {
            const r = flights.list(db, {
                year: args.year, airport: args.airport, airline: args.airline_iata, trip: args.trip_id, status: args.status,
                limit: args.limit || LIST_MAX, offset: args.offset,
            });
            return { count: r.flights.length, total: r.total, offset: r.offset, flights: r.flights.map((f) => flight(f)) };
        }
        case 'get': {
            // include_booking_ref is only offered with flights:read (the tool's read scope), checked by the registry.
            const f = flights.get(db, need(args.id, 'an id', action));
            return flight(f, { notesMax: 0, withRef: args.include_booking_ref === true });
        }
        case 'upcoming':
            return { flights: flights.upcoming(db, { limit: Math.min(args.limit || 5, 20) }).map((f) => flight(f)) };
        case 'stats':
            return flights.stats(db, { year: args.year });
        case 'trips':
            return { trips: flights.listTrips(db) };
        case 'candidates': {
            const status = args.status || 'pending';
            return { status, counts: flights.candidateCounts(db), candidates: flights.listCandidates(db, { status, limit: args.limit || LIST_MAX }).map(candidate) };
        }
        case 'suggest': {
            const r = flights.suggest(db, pick(args, [...flights.CANDIDATE_FIELDS, 'source', 'source_key', 'confidence']), key.name);
            return r.candidate ? { status: r.status, candidate: candidate(r.candidate) } : r;
        }
        case 'add':
            return flights.create(db, { ...pick(args, EDIT_FIELDS), source: 'manual' }, key.name);
        case 'edit': {
            const id = need(args.id, 'an id', action);
            const fields = pick(args, [...EDIT_FIELDS, 'note']);
            if (!Object.keys(fields).some((k) => k !== 'note')) throw new ToolError('bad_request', 'The edit action needs at least one field to change.');
            return flights.update(db, id, fields, key.name);
        }
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
