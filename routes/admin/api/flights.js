// Flights: the found-flights queue, the list/Passport/airports/trips/settings and data sources (fixed words before /flights/:id).
const flights = require('../../../services/flights');
const enrich = require('../../../services/enrich');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api, ctx) => {
    const { audit } = ctx;

    // ---- flights: the found-flights queue (works while the domain is switched off). Accepting and dismissing
    // are for a person only, so they live here and not on /hub. Audited as `admin` with the candidate id, the
    // flight label and the flight it became; never the booking reference. ----
    const flightHandler = adminHandler(flights.FlightError, 'admin flights error:', { extra: true, async: true });

    api.get('/flights/candidates', flightHandler((req, res, conn) => {
        const status = req.query.status || 'pending';
        res.json({ status, candidates: flights.listCandidates(conn, { status, limit: req.query.limit }), counts: flights.candidateCounts(conn) });
    }));

    // Body: { ids: [..] }. Each id is accepted on its own; the answer lists what happened to each.
    api.post('/flights/candidates/accept-all', flightHandler((req, res, conn) => {
        const result = flights.acceptAll(conn, (req.body || {}).ids, 'admin');
        for (const r of result.results.filter((x) => x.status === 'accepted')) {
            audit.record(conn, 'admin', 'flight_candidate_accepted', { id: r.id, flight: r.label, flight_id: r.flight_id, rev: r.rev }, req.ip);
        }
        res.json(result);
    }));

    // Body: optional flight fields that replace the found ones before the flight is created.
    api.post('/flights/candidates/:id/accept', flightHandler((req, res, conn) => {
        const result = flights.acceptCandidate(conn, req.params.id, req.body, 'admin');
        audit.record(conn, 'admin', 'flight_candidate_accepted', flights.candidateAuditDetail(result.candidate, result.flight), req.ip);
        res.json(result);
    }));

    api.post('/flights/candidates/:id/dismiss', flightHandler((req, res, conn) => {
        const result = flights.dismissCandidate(conn, req.params.id, 'admin');
        if (result.status !== 'unchanged') audit.record(conn, 'admin', 'flight_candidate_dismissed', flights.candidateAuditDetail(result.candidate), req.ip);
        res.json(result);
    }));

    // ---- permanent delete: a person at the dashboard only. Body { confirm: true, backup?: true }. Fixed words first. ----
    const bad = (code, message, status) => new flights.FlightError(status || 400, code, message);
    const gone = (action, svc, detail) => flightHandler((req, res, conn) => removal(req, res, conn, action, {
        plan: () => { needConfirm(bad, req.body); },
        run: () => svc(conn, req),
        detail,
    }));

    api.delete('/flights/candidates/dismissed', gone('flight_candidate_deleted',
        (conn, req) => flights.removeDismissedCandidates(conn, req.body), flights.candidateRemovedAuditDetail));

    api.delete('/flights/candidates/:id', flightHandler((req, res, conn) => removal(req, res, conn, 'flight_candidate_deleted', {
        plan: () => { needConfirm(bad, req.body); },
        run: () => flights.removeCandidate(conn, req.params.id, req.body),
        detail: flights.candidateRemovedAuditDetail,
    })));

    // ---- flights: the list, one flight, the Passport, airports, trips and settings for the dashboard. Fixed words
    // come before /flights/:id. The list leaves booking references out (has_booking_ref instead); one flight
    // carries it. Changes are audited as `admin` with id, flight label and revision only. ----
    const flightChanged = adminChanged(flights.auditDetail);

    api.get('/flights', flightHandler((req, res, conn) => {
        const { year, airport, airline, trip, status, limit, offset } = req.query;
        const out = flights.list(conn, { year, airport, airline, trip, status, limit: limit || 500, offset });
        out.flights = out.flights.map(({ booking_ref: ref, ...rest }) => ({ ...rest, has_booking_ref: Boolean(ref) }));
        res.json(out);
    }));

    // The Passport numbers plus what the map draws (airports with coordinates, routes with counts).
    api.get('/flights/stats', flightHandler((req, res, conn) => {
        res.json({ ...flights.stats(conn, { year: req.query.year }), map: flights.mapData(conn, { year: req.query.year }), settings: flights.getSettings(conn) });
    }));

    api.get('/flights/upcoming', flightHandler((req, res, conn) => {
        res.json({ flights: flights.upcoming(conn, { limit: req.query.limit }).map(({ booking_ref: ref, ...rest }) => ({ ...rest, has_booking_ref: Boolean(ref) })) });
    }));

    api.get('/flights/airports', flightHandler((req, res, conn) => {
        res.json({ airports: flights.searchAirports(conn, req.query.q) });
    }));

    api.get('/flights/trips', flightHandler((req, res, conn) => {
        res.json({ trips: flights.listTrips(conn) });
    }));

    api.post('/flights/trips', flightHandler((req, res, conn) => {
        const result = flights.createTrip(conn, req.body, 'admin');
        audit.record(conn, 'admin', 'trip_created', { id: result.id, title: result.title }, req.ip);
        res.status(201).json(result);
    }));

    api.get('/flights/trips/:id/delete-preview', flightHandler((req, res, conn) => {
        res.json(flights.tripRemovalPreview(conn, req.params.id));
    }));

    api.delete('/flights/trips/:id', flightHandler((req, res, conn) => removal(req, res, conn, 'trip_deleted', {
        plan: () => { needConfirm(bad, req.body); flights.tripRemovalPreview(conn, req.params.id); },
        run: () => flights.removeTrip(conn, req.params.id, req.body),
        detail: flights.tripRemovedAuditDetail,
    })));

    api.get('/flights/settings', flightHandler((req, res, conn) => {
        res.json(flights.getSettings(conn));
    }));

    api.put('/flights/settings', flightHandler((req, res, conn) => {
        const result = flights.putSettings(conn, req.body, 'admin');
        audit.record(conn, 'admin', 'flight_settings_changed', { keys: Object.keys(req.body || {}) }, req.ip);
        res.json(result);
    }));

    api.post('/flights', flightHandler((req, res, conn) => {
        flightChanged(req, res, conn, 'flight_created', flights.create(conn, req.body, 'admin'), 201);
    }));

    // ---- flights: data sources (enrichment). Settings and calls this month; keys are only "configured". ----
    api.get('/flights/sources', flightHandler((req, res, conn) => {
        res.json(enrich.listSources(conn));
    }));

    api.put('/flights/sources', flightHandler((req, res, conn) => {
        const names = enrich.putSources(conn, req.body);
        audit.record(conn, 'admin', 'flight_sources_changed', { sources: names }, req.ip);
        res.json(enrich.listSources(conn));
    }));

    api.post('/flights/:id/refresh', flightHandler(async (req, res, conn) => {
        const result = await enrich.refresh(conn, req.params.id, { force: (req.body || {}).force === true, actor: 'admin' });
        if (result.looked_up || result.status === 'updated') {
            audit.record(conn, 'admin', 'flight_refreshed', { ...flights.auditDetail(result), results: result.results.map((r) => `${r.source}:${r.result}`) }, req.ip);
        }
        res.json(result);
    }));

    api.get('/flights/:id', flightHandler((req, res, conn) => {
        res.json({ ...flights.get(conn, req.params.id, { rev: req.query.rev }), history: flights.history(conn, req.params.id) });
    }));

    api.patch('/flights/:id', flightHandler((req, res, conn) => {
        flightChanged(req, res, conn, 'flight_updated', flights.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.post('/flights/:id/restore', flightHandler((req, res, conn) => {
        flightChanged(req, res, conn, 'flight_restored', flights.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    api.get('/flights/:id/delete-preview', flightHandler((req, res, conn) => {
        res.json(flights.flightRemovalPreview(conn, req.params.id, { forget_candidate: req.query.forget_candidate !== 'false' }));
    }));

    api.delete('/flights/:id', flightHandler((req, res, conn) => removal(req, res, conn, 'flight_deleted', {
        plan: () => { needConfirm(bad, req.body); flights.flightRemovalPreview(conn, req.params.id, req.body); },
        run: () => flights.removeFlight(conn, req.params.id, req.body),
        detail: flights.removedAuditDetail,
    })));
};
