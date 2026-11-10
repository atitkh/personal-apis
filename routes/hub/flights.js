// /hub/flights: the flights domain over REST. Mounted by hub.js, which supplies the rate limit, the JSON
// body parser, no-store and `handle` (turns a FlightError into a JSON error).
//   flights:read   list, get, history, upcoming, stats, trips, settings
//   flights:write  create, update, restore, trips and settings changes
//   flights:suggest  POST /candidates only: file a found flight for a person to accept or dismiss (the answer
//                    never carries a booking reference). Accepting and dismissing are admin-only
//                    (/admin/api/flights/candidates), never over /hub.
// There is no delete: a flight that did not happen gets status cancelled.
// booking_ref is in flight answers (every route needs flights:read), never in audit rows: changes are
// audited with flights.auditDetail (id, flight number, route, date).
const express = require('express');
const flights = require('../../services/flights');
const audit = require('../../services/audit');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('flights:read'), requireDomain('flights')];
    // Writing answers with the flight, booking reference included, so it needs read as well. (One
    // requireScope only: each one counts the call against the key's limit.)
    const alsoRead = (req, res, next) => (apiKeys.hasScope(req.apiKey.scopes, 'flights:read') ? next()
        : res.status(403).json({ error: 'Forbidden', message: 'This key lacks the "flights:read" scope' }));
    const write = [requireScope('flights:write'), alsoRead, requireDomain('flights')];

    const changed = (req, res, conn, action, result, status = 200) => {
        if (result.status !== 'unchanged') audit.record(conn, req.apiKey.name, action, flights.auditDetail(result), req.ip);
        res.status(status).json(result);
    };

    router.get('/', read, handle((req, res, conn) => {
        const { year, airport, airline, trip, status, limit, offset } = req.query;
        res.json(flights.list(conn, { year, airport, airline, trip, status, limit, offset }));
    }));

    // Fixed words first, so they are never read as an id.
    router.get('/upcoming', read, handle((req, res, conn) => {
        res.json({ flights: flights.upcoming(conn, { limit: req.query.limit }) });
    }));

    router.get('/stats', read, handle((req, res, conn) => {
        res.json(flights.stats(conn, { year: req.query.year }));
    }));

    router.get('/settings', read, handle((req, res, conn) => {
        res.json(flights.getSettings(conn));
    }));

    router.put('/settings', write, handle((req, res, conn) => {
        const result = flights.putSettings(conn, req.body, req.apiKey.name);
        audit.record(conn, req.apiKey.name, 'flight_settings_changed', { keys: Object.keys(req.body || {}) }, req.ip);
        res.json(result);
    }));

    router.get('/trips', read, handle((req, res, conn) => {
        res.json({ trips: flights.listTrips(conn) });
    }));

    router.post('/trips', write, handle((req, res, conn) => {
        const result = flights.createTrip(conn, req.body, req.apiKey.name);
        audit.record(conn, req.apiKey.name, 'trip_created', { id: result.id, title: result.title }, req.ip);
        res.status(201).json(result);
    }));

    router.get('/trips/:id', read, handle((req, res, conn) => {
        res.json(flights.getTrip(conn, req.params.id));
    }));

    router.patch('/trips/:id', write, handle((req, res, conn) => {
        const result = flights.updateTrip(conn, req.params.id, req.body, req.apiKey.name);
        if (result.status !== 'unchanged') audit.record(conn, req.apiKey.name, 'trip_updated', { id: result.id, title: result.title }, req.ip);
        res.json(result);
    }));

    // ?status=pending (default) | accepted | dismissed | all. `counts` has every status, whatever the filter.
    router.get('/candidates', read, handle((req, res, conn) => {
        const status = req.query.status || 'pending';
        res.json({ status, candidates: flights.listCandidates(conn, { status, limit: req.query.limit }), counts: flights.candidateCounts(conn) });
    }));

    // 201 when filed; 200 with what exists when it is already a flight or a candidate.
    router.post('/candidates', [requireScope('flights:suggest'), requireDomain('flights')], handle((req, res, conn) => {
        const result = flights.suggest(conn, req.body, req.apiKey.name);
        if (result.status === 'filed') {
            audit.record(conn, req.apiKey.name, 'flight_candidate_filed', flights.candidateAuditDetail(result.candidate), req.ip);
            return res.status(201).json(result);
        }
        res.json(result);
    }));

    router.post('/', write, handle((req, res, conn) => {
        changed(req, res, conn, 'flight_created', flights.create(conn, req.body, req.apiKey.name), 201);
    }));

    router.get('/:id', read, handle((req, res, conn) => {
        res.json(flights.get(conn, req.params.id, { rev: req.query.rev }));
    }));

    router.get('/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: flights.history(conn, req.params.id) });
    }));

    router.patch('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'flight_updated', flights.update(conn, req.params.id, req.body, req.apiKey.name));
    }));

    router.post('/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'flight_restored', flights.restore(conn, req.params.id, (req.body || {}).rev, req.apiKey.name));
    }));

    return router;
};
