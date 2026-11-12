// /hub/places: the places domain over REST. Mounted by hub.js, which supplies the rate limit, the JSON
// body parser, no-store and `handle` (turns a PlaceError into a JSON error).
//   places:read     list, get, history, resolve, the suggestions queue
//   places:suggest  resolve with suggest: true (files an unnamed street; places:api-write also allows it)
//   places:api-write    create, update, restore, delete, rules, accept or dismiss a suggestion
// Resolve is a POST so that addresses travel in the body and never end up in the access log.
// Changes are audited with ids and labels only (places.auditDetail), never with rule values.
const express = require('express');
const places = require('../../services/places');
const audit = require('../../services/audit');
const { keyChanged } = require('../lib/changed');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('places:read'), requireDomain('places')];
    const write = [requireScope('places:api-write'), requireDomain('places')];

    // Answers with the result and records what changed (nothing when the change was a no-op).
    const changed = keyChanged(places.auditDetail);

    router.get('/', read, handle((req, res, conn) => {
        res.json({ places: places.list(conn, { kind: req.query.kind }) });
    }));

    // Fixed words first, so they are never read as an id.
    router.post('/resolve', read, handle((req, res, conn) => {
        const body = req.body || {};
        const { scopes } = req.apiKey;
        if (body.suggest === true && !apiKeys.hasScope(scopes, 'places:suggest') && !apiKeys.hasScope(scopes, 'places:api-write')) {
            return res.status(403).json({ error: 'Forbidden', message: 'suggest needs the "places:suggest" scope' });
        }
        res.json(places.resolve(conn, body));
    }));

    // ?status=pending (default) | accepted | dismissed | all. `counts` has every status, whatever the filter.
    router.get('/suggestions', read, handle((req, res, conn) => {
        const status = req.query.status || 'pending';
        res.json({ status, suggestions: places.suggestions(conn, { status, limit: req.query.limit }), counts: places.suggestionCounts(conn) });
    }));

    // Naming the queue is for a person (places:api-write); agents can only file suggestions.
    router.post('/suggestions/:id/accept', write, handle((req, res, conn) => {
        const result = places.acceptSuggestion(conn, req.params.id, req.body, req.apiKey.name);
        audit.recordKey(conn, req.apiKey, 'place_suggestion_accepted', places.suggestionAuditDetail(result), req.ip);
        res.json(result);
    }));

    router.post('/suggestions/:id/dismiss', write, handle((req, res, conn) => {
        const result = places.dismissSuggestion(conn, req.params.id, req.apiKey.name);
        if (result.status !== 'unchanged') audit.recordKey(conn, req.apiKey, 'place_suggestion_dismissed', places.suggestionAuditDetail(result), req.ip);
        res.json(result);
    }));

    router.post('/', write, handle((req, res, conn) => {
        changed(req, res, conn, 'place_created', places.create(conn, req.body, req.apiKey.name), 201);
    }));

    router.get('/:id', read, handle((req, res, conn) => {
        res.json(places.get(conn, req.params.id, { rev: req.query.rev }));
    }));

    router.get('/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: places.history(conn, req.params.id) });
    }));

    router.patch('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'place_updated', places.update(conn, req.params.id, req.body, req.apiKey.name));
    }));

    router.post('/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'place_restored', places.restore(conn, req.params.id, (req.body || {}).rev, req.apiKey.name));
    }));

    router.delete('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'place_deleted', places.remove(conn, req.params.id));
    }));

    router.post('/:id/rules', write, handle((req, res, conn) => {
        changed(req, res, conn, 'place_rule_added', places.addRule(conn, req.params.id, req.body, req.apiKey.name), 201);
    }));

    router.patch('/:id/rules/:ruleId', write, handle((req, res, conn) => {
        changed(req, res, conn, 'place_rule_updated', places.updateRule(conn, req.params.id, req.params.ruleId, req.body, req.apiKey.name));
    }));

    router.delete('/:id/rules/:ruleId', write, handle((req, res, conn) => {
        changed(req, res, conn, 'place_rule_removed', places.removeRule(conn, req.params.id, req.params.ruleId, req.apiKey.name));
    }));

    return router;
};
