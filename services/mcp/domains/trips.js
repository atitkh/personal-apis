// MCP tool for the trips domain. Reuses services/trips.js (and tripItems.js, tripSuggest.js), so validation,
// revisions and links behave exactly as through /hub/trips. Agents may read (list, get, upcoming, suggest) and, in
// write mode with trips:agent-write, add and edit trips, link and unlink flights and add, edit and remove items.
// Deleting a trip, restoring an older version and accepting or dismissing a suggested trip stay with a person.
// Item references (booking numbers): left out of every answer; has_reference says one is stored. `get` includes
// them only when the key has trips:read (the tool's read scope, checked by the registry) and passes
// include_reference=true. Flights come without booking references. The audit row (mcp_call) never holds arguments
// or results.
const trips = require('../../trips');
const items = require('../../tripItems');
const suggestions = require('../../tripSuggest');
const { ToolError, clip } = require('../util');

const LIST_MAX = 50;
const NOTES_CHARS = 300;
const TRIP_FIELDS = ['title', 'destination', 'kind', 'start_date', 'end_date', 'notes', 'status_override'];
const ITEM_FIELDS = ['item_kind', 'item_title', 'start_date', 'end_date', 'place', 'notes', 'reference', 'sort'];

function need(value, what, action) {
    if (value == null || value === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`);
    return value;
}

// Notes cut to NOTES_CHARS (lists only), with notesTruncated when they were longer.
function cut(obj) {
    const n = clip(obj.notes, NOTES_CHARS);
    const out = { ...obj, notes: n.text };
    if (n.truncated) out.notesTruncated = true;
    return out;
}

// A trip for an agent: no bookkeeping fields. Lists cut the notes.
function trip(t, { full = false } = {}) {
    const { created_at: _c, updated_by: _u, ...out } = t;
    return full ? out : cut(out);
}

const pick = (args, names) => Object.fromEntries(names.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

// Item arguments use item_kind / item_title so they do not clash with the trip's own kind and title.
function itemFields(args) {
    const out = pick(args, ITEM_FIELDS);
    if ('item_kind' in out) { out.kind = out.item_kind; delete out.item_kind; }
    if ('item_title' in out) { out.title = out.item_title; delete out.item_title; }
    return out;
}

module.exports = {
    domain: 'trips',
    readScope: 'trips:read',
    // Titles, notes and places are free text written by people and agents, so results are marked as data.
    untrusted: true,
    description: "Atit's trips: journeys he made or plans (a title, a destination, a kind), with the flights and deadlines that belong to them and a small itinerary of items (stays, ground transport, activities, bookings). "
        + 'Dates are LOCAL dates (YYYY-MM-DD, no time zone; "today" is Chicago time); a trip with one date is a one-day trip. '
        + 'phase is upcoming, ongoing, past or cancelled, worked out from the dates; days_to_start counts down to an upcoming trip, days_left is the days until the last day of an ongoing one. '
        + 'route lists airport codes in flight order and distance_km adds up the flights. '
        + 'Booking and item references are left out (has_booking_ref, has_reference say one is stored). '
        + 'Suggested trips are proposals from flights that have no trip; only Atit accepts or dismisses them.',
    actions: {
        list: { scope: 'trips:read', describe: `list: trips (optional phase (upcoming, ongoing, past, cancelled), year; limit 1-${LIST_MAX}). Upcoming and ongoing come soonest first, others newest first` },
        get: { scope: 'trips:read', describe: 'get: one trip (id) with its flights, deadlines and items; include_reference=true adds the item references' },
        upcoming: { scope: 'trips:read', describe: `upcoming: trips that are ongoing or start within days (default 60, 1-365), soonest first (limit 1-${LIST_MAX})` },
        suggest: { scope: 'trips:read', describe: 'suggest: proposed trips made from flights that have no trip (key, title, dates, flight ids, route). Read only: Atit accepts or dismisses them' },
        add: { scope: 'trips:agent-write', write: true, describe: 'add: file a trip (title required; optional destination, kind (leisure, conference, research, family, work, other), start_date, end_date, notes)' },
        edit: { scope: 'trips:agent-write', write: true, describe: 'edit: change one trip (id; only the fields sent change, null clears; status_override cancelled marks it cancelled, null undoes that; optional note = why)' },
        link_flight: { scope: 'trips:agent-write', write: true, describe: 'link_flight: put a flight on a trip (id, flight_id). A flight on another trip moves; moved_from says from where' },
        unlink_flight: { scope: 'trips:agent-write', write: true, describe: 'unlink_flight: take a flight off a trip (id, flight_id). The flight stays' },
        add_item: { scope: 'trips:agent-write', write: true, describe: 'add_item: add an item to a trip (id, item_title required; optional item_kind (stay, ground, activity, booking, other), start_date, end_date, place, notes, reference, sort)' },
        edit_item: { scope: 'trips:agent-write', write: true, describe: 'edit_item: change one item (id, item_id; only the fields sent change, null clears)' },
        remove_item: { scope: 'trips:agent-write', write: true, describe: 'remove_item: remove one item from a trip (id, item_id). Items have no history: it is gone' },
    },

    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        const text = (n) => z.string().max(n);
        if (has('list', 'upcoming')) shape.limit = z.number().int().min(1).max(LIST_MAX).optional().describe('list/upcoming: how many');
        if (has('list')) {
            shape.phase = text(20).optional().describe('list: upcoming, ongoing, past or cancelled');
            shape.year = z.string().regex(/^\d{4}$/).optional().describe('list: trips that touch this year, like 2026');
        }
        if (has('upcoming')) shape.days = z.number().int().min(1).max(365).optional().describe('upcoming: how many days ahead (default 60)');
        if (has('get', 'edit', 'link_flight', 'unlink_flight', 'add_item', 'edit_item', 'remove_item')) shape.id = z.number().int().positive().optional().describe('the trip id');
        if (has('get')) shape.include_reference = z.boolean().optional().describe('get: true to include the item references');
        if (has('link_flight', 'unlink_flight')) shape.flight_id = z.number().int().positive().optional().describe('link_flight/unlink_flight: the flight id');
        if (has('edit_item', 'remove_item')) shape.item_id = z.number().int().positive().optional().describe('edit_item/remove_item: the item id');
        if (has('add', 'edit')) {
            shape.title = text(120).optional().describe('add/edit: the trip title, 1-120 characters');
            shape.destination = text(120).nullable().optional().describe('add/edit: where, free text, like Hong Kong');
            shape.kind = text(20).nullable().optional().describe('add/edit: leisure, conference, research, family, work or other');
        }
        if (has('edit')) {
            shape.status_override = text(10).nullable().optional().describe('edit: cancelled, or null to undo');
            shape.note = z.string().max(200).optional().describe('edit: why it changed');
        }
        if (has('add', 'edit', 'add_item', 'edit_item')) {
            shape.start_date = text(10).nullable().optional().describe('a local date, like 2027-03-01');
            shape.end_date = text(10).nullable().optional().describe('a local date, not before start_date');
            shape.notes = z.string().max(2000).nullable().optional();
        }
        if (has('add_item', 'edit_item')) {
            shape.item_title = text(120).optional().describe('add_item/edit_item: what it is, like Hotel near the harbour');
            shape.item_kind = text(20).nullable().optional().describe('add_item/edit_item: stay, ground, activity, booking or other');
            shape.place = text(200).nullable().optional().describe('add_item/edit_item: where, free text');
            shape.reference = text(120).nullable().optional().describe('add_item/edit_item: booking or confirmation number (stored privately)');
            shape.sort = z.number().int().min(0).max(100000).optional().describe('add_item/edit_item: order among items on the same day');
        }
        return shape;
    },

    run(action, args, { db, key }) {
        switch (action) {
        case 'list': {
            const r = trips.list(db, { phase: args.phase, year: args.year, limit: args.limit || LIST_MAX });
            return { count: r.trips.length, total: r.total, trips: r.trips.map((t) => trip(t)) };
        }
        case 'get': {
            const withRef = args.include_reference === true;
            const t = trips.get(db, need(args.id, 'an id', action), { reference: withRef });
            return trip(t, { full: true });
        }
        case 'upcoming':
            return { trips: trips.upcoming(db, { days: args.days || 60, limit: args.limit || LIST_MAX }).map((t) => trip(t)) };
        case 'suggest':
            return suggestions.suggest(db);
        case 'add':
            return trips.create(db, pick(args, TRIP_FIELDS.filter((k) => k !== 'status_override')), key.name);
        case 'edit': {
            const id = need(args.id, 'an id', action);
            const fields = pick(args, [...TRIP_FIELDS, 'note']);
            if (!Object.keys(fields).some((k) => k !== 'note')) throw new ToolError('bad_request', 'The edit action needs at least one field to change.');
            return trips.update(db, id, fields, key.name);
        }
        case 'link_flight':
            return trips.linkFlight(db, need(args.id, 'an id', action), need(args.flight_id, 'a flight_id', action), key.name);
        case 'unlink_flight':
            return trips.unlinkFlight(db, need(args.id, 'an id', action), need(args.flight_id, 'a flight_id', action), key.name);
        case 'add_item': {
            const id = need(args.id, 'an id', action);
            need(args.item_title, 'an item_title', action);
            return items.add(db, id, itemFields(args), key.name);
        }
        case 'edit_item': {
            const id = need(args.id, 'an id', action);
            const itemId = need(args.item_id, 'an item_id', action);
            const fields = itemFields(args);
            if (!Object.keys(fields).length) throw new ToolError('bad_request', 'The edit_item action needs at least one field to change.');
            return items.update(db, id, itemId, fields, key.name);
        }
        case 'remove_item':
            return items.remove(db, need(args.id, 'an id', action), need(args.item_id, 'an item_id', action));
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
