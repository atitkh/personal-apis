// /hub/trips: the trips domain over REST. Mounted by hub.js, which supplies the rate limit, the JSON body parser,
// no-store and `handle` (turns a TripError into a JSON error).
//   trips:read       list, get, history, items
//   trips:api-write  create, update, restore, link and unlink a flight, add, change and remove items (also needs
//                    trips:read: the answer is the trip)
// There is no delete here (no DELETE method at all): deleting a trip is for a person at the dashboard only.
// Removing an item is a POST (/:id/items/:itemId/remove) for the same reason.
// A trip detail lists its flights without booking references and its deadlines without references or money.
// Item references (booking numbers) are left out (has_reference) unless the read asks with include_reference=true.
// Suggested trips (accept, dismiss) are not here: they are for a person at the dashboard.
// Changes are audited with trips.auditDetail: id, title, revision, field NAMES and flight ids, never values.
const express = require('express');
const trips = require('../../services/trips');
const items = require('../../services/tripItems');
const { keyChanged } = require('../lib/changed');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('trips:read'), requireDomain('trips')];
    // One requireScope only: each one counts the call against the key's limit.
    const alsoRead = (req, res, next) => (apiKeys.hasScope(req.apiKey.scopes, 'trips:read') ? next()
        : res.status(403).json({ error: 'Forbidden', message: 'This key lacks the "trips:read" scope' }));
    const write = [requireScope('trips:api-write'), alsoRead, requireDomain('trips')];

    const changed = keyChanged(trips.auditDetail);
    const itemChanged = keyChanged(items.auditDetail);
    const withRef = (req) => req.query.include_reference === 'true';

    router.get('/', read, handle((req, res, conn) => {
        const { phase, year, limit, offset } = req.query;
        res.json(trips.list(conn, { phase, year, limit, offset }));
    }));

    router.post('/', write, handle((req, res, conn) => {
        changed(req, res, conn, 'trip_created', trips.create(conn, req.body, req.apiKey.name), 201);
    }));

    router.get('/:id', read, handle((req, res, conn) => {
        res.json(trips.get(conn, req.params.id, { rev: req.query.rev, reference: withRef(req) }));
    }));

    router.get('/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: trips.history(conn, req.params.id) });
    }));

    router.patch('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'trip_updated', trips.update(conn, req.params.id, req.body, req.apiKey.name));
    }));

    router.post('/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'trip_restored', trips.restore(conn, req.params.id, (req.body || {}).rev, req.apiKey.name));
    }));

    // Body { flight_id }. A flight on another trip is moved here; the answer says from where (moved_from).
    router.post('/:id/flights', write, handle((req, res, conn) => {
        changed(req, res, conn, 'trip_flight_linked', trips.linkFlight(conn, req.params.id, (req.body || {}).flight_id, req.apiKey.name));
    }));

    // A POST, not a DELETE: /hub has no DELETE routes at all (tests/noRemoteDelete.test.js). The flight stays.
    router.post('/:id/flights/:flightId/unlink', write, handle((req, res, conn) => {
        changed(req, res, conn, 'trip_flight_unlinked', trips.unlinkFlight(conn, req.params.id, req.params.flightId, req.apiKey.name));
    }));

    router.get('/:id/items', read, handle((req, res, conn) => {
        res.json(items.list(conn, req.params.id, { reference: withRef(req) }));
    }));

    router.post('/:id/items', write, handle((req, res, conn) => {
        itemChanged(req, res, conn, 'trip_item_added', items.add(conn, req.params.id, req.body, req.apiKey.name), 201);
    }));

    router.patch('/:id/items/:itemId', write, handle((req, res, conn) => {
        itemChanged(req, res, conn, 'trip_item_updated', items.update(conn, req.params.id, req.params.itemId, req.body, req.apiKey.name));
    }));

    // A POST, not a DELETE (see above). The item is gone for good: items have no revisions.
    router.post('/:id/items/:itemId/remove', write, handle((req, res, conn) => {
        itemChanged(req, res, conn, 'trip_item_removed', items.remove(conn, req.params.id, req.params.itemId));
    }));

    return router;
};
