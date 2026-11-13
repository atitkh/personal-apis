// Trips: everything the dashboard needs (list, one trip with its flights and deadlines, edits, history, restore, flight
// links and the permanent delete). Works while the domain is switched off. Changes are audited as `admin` with id,
// title, revision, field names and flight ids (trips.auditDetail), never values or notes. Fixed words come before
// /trips/:id. The old /admin/api/flights/trips routes stay in flights.js and call the same service.
const trips = require('../../../services/trips');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api) => {
    const tripHandler = adminHandler(trips.TripError, 'admin trips error:', { extra: true, async: true });
    const tripChanged = adminChanged(trips.auditDetail);

    api.get('/trips', tripHandler((req, res, conn) => {
        const { phase, year, limit, offset } = req.query;
        res.json(trips.list(conn, { phase, year, limit: limit || trips.LIST_MAX, offset }));
    }));

    api.post('/trips', tripHandler((req, res, conn) => {
        tripChanged(req, res, conn, 'trip_created', trips.create(conn, req.body, 'admin'), 201);
    }));

    api.get('/trips/:id', tripHandler((req, res, conn) => {
        res.json({ ...trips.get(conn, req.params.id, { rev: req.query.rev }), history: trips.history(conn, req.params.id) });
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
