// Trips: everything the dashboard needs (list, one trip with its flights and deadlines, edits, history, restore, flight
// links, items, suggested trips and the permanent delete). Works while the domain is switched off. Changes are
// audited as `admin` with id, title, revision, field names and flight ids (trips.auditDetail), never values or
// notes; items by trip id, item id and title; suggestions by key (flight ids), trip id and title. Fixed words
// (suggestions) come before /trips/:id. The old /admin/api/flights/trips routes stay in flights.js and call the same
// service. The admin sees item references (the dashboard edits them).
const trips = require('../../../services/trips');
const items = require('../../../services/tripItems');
const suggestions = require('../../../services/tripSuggest');
const audit = require('../../../services/audit');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api) => {
    const tripHandler = adminHandler(trips.TripError, 'admin trips error:', { extra: true, async: true });
    const tripChanged = adminChanged(trips.auditDetail);
    const itemChanged = adminChanged(items.auditDetail);
    const suggestionChanged = adminChanged(suggestions.auditDetail);

    api.get('/trips', tripHandler((req, res, conn) => {
        const { phase, year, limit, offset } = req.query;
        res.json(trips.list(conn, { phase, year, limit: limit || trips.LIST_MAX, offset }));
    }));

    // ---- suggested trips (flights with no trip, grouped). Accept and dismiss are here only: never /hub or MCP.
    api.get('/trips/suggestions', tripHandler((req, res, conn) => {
        res.json(suggestions.suggest(conn));
    }));

    // Body { key, title? }: creates the trip and links its flights. A key no longer proposed is a 409.
    api.post('/trips/suggestions/accept', tripHandler((req, res, conn) => {
        suggestionChanged(req, res, conn, 'trip_suggestion_accepted', suggestions.accept(conn, req.body, 'admin'), 201);
    }));

    // Body { key }: hides the suggestion until the dismissed ones are restored.
    api.post('/trips/suggestions/dismiss', tripHandler((req, res, conn) => {
        suggestionChanged(req, res, conn, 'trip_suggestion_dismissed', suggestions.dismiss(conn, req.body));
    }));

    api.post('/trips/suggestions/restore-dismissed', tripHandler((req, res, conn) => {
        const result = suggestions.restoreDismissed(conn);
        if (result.status !== 'unchanged') audit.record(conn, 'admin', 'trip_suggestions_restored', { restored: result.restored }, req.ip);
        res.json(result);
    }));

    api.post('/trips', tripHandler((req, res, conn) => {
        tripChanged(req, res, conn, 'trip_created', trips.create(conn, req.body, 'admin'), 201);
    }));

    api.get('/trips/:id', tripHandler((req, res, conn) => {
        res.json({ ...trips.get(conn, req.params.id, { rev: req.query.rev, reference: true }), history: trips.history(conn, req.params.id) });
    }));

    api.patch('/trips/:id', tripHandler((req, res, conn) => {
        tripChanged(req, res, conn, 'trip_updated', trips.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.get('/trips/:id/history', tripHandler((req, res, conn) => {
        res.json({ revisions: trips.history(conn, req.params.id) });
    }));

    api.post('/trips/:id/restore', tripHandler((req, res, conn) => {
        tripChanged(req, res, conn, 'trip_restored', trips.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    // Body { flight_id }. A flight on another trip is moved here; the answer says from where (moved_from).
    api.post('/trips/:id/flights', tripHandler((req, res, conn) => {
        tripChanged(req, res, conn, 'trip_flight_linked', trips.linkFlight(conn, req.params.id, (req.body || {}).flight_id, 'admin'));
    }));

    // Takes the flight off the trip; the flight stays.
    api.delete('/trips/:id/flights/:flightId', tripHandler((req, res, conn) => {
        tripChanged(req, res, conn, 'trip_flight_unlinked', trips.unlinkFlight(conn, req.params.id, req.params.flightId, 'admin'));
    }));

    // ---- items (a small itinerary). Removing one is permanent: items have no revisions.
    api.get('/trips/:id/items', tripHandler((req, res, conn) => {
        res.json(items.list(conn, req.params.id, { reference: true }));
    }));

    api.post('/trips/:id/items', tripHandler((req, res, conn) => {
        itemChanged(req, res, conn, 'trip_item_added', items.add(conn, req.params.id, req.body, 'admin'), 201);
    }));

    api.patch('/trips/:id/items/:itemId', tripHandler((req, res, conn) => {
        itemChanged(req, res, conn, 'trip_item_updated', items.update(conn, req.params.id, req.params.itemId, req.body, 'admin'));
    }));

    api.delete('/trips/:id/items/:itemId', tripHandler((req, res, conn) => {
        itemChanged(req, res, conn, 'trip_item_removed', items.remove(conn, req.params.id, req.params.itemId));
    }));

    // Permanent delete (admin only). Body { confirm: true, unassign?: true, backup?: true }. Flights and deadlines stay
    // without the link; the trip's items and revisions go.
    const bad = (code, message, status) => new trips.TripError(status || 400, code, message);

    api.get('/trips/:id/delete-preview', tripHandler((req, res, conn) => {
        res.json(trips.removalPreview(conn, req.params.id));
    }));

    api.delete('/trips/:id', tripHandler((req, res, conn) => removal(req, res, conn, 'trip_deleted', {
        plan: () => { needConfirm(bad, req.body); trips.removalPreview(conn, req.params.id); },
        run: () => trips.remove(conn, req.params.id, req.body),
        detail: trips.removedAuditDetail,
    })));
};
