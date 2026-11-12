// /hub/deadlines: the deadlines domain over REST. Mounted by hub.js, which supplies the rate limit, the JSON
// body parser, no-store and `handle` (turns a DeadlineError into a JSON error).
//   deadlines:read   list, upcoming, get, history
//   deadlines:write  create, update, done, end, restore (also needs deadlines:read: the answer is the item)
// There is no key with only a suggest scope: nothing here is found by a job for review.
// Lists and /upcoming leave the private reference out (has_reference instead); GET /:id carries it.
// Changes are audited with deadlines.auditDetail: id, title, revision and field NAMES, never values.
const express = require('express');
const deadlines = require('../../services/deadlines');
const audit = require('../../services/audit');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('deadlines:read'), requireDomain('deadlines')];
    // One requireScope only: each one counts the call against the key's limit.
    const alsoRead = (req, res, next) => (apiKeys.hasScope(req.apiKey.scopes, 'deadlines:read') ? next()
        : res.status(403).json({ error: 'Forbidden', message: 'This key lacks the "deadlines:read" scope' }));
    const write = [requireScope('deadlines:write'), alsoRead, requireDomain('deadlines')];

    const changed = (req, res, conn, action, result, status = 200) => {
        if (result.status !== 'unchanged') audit.record(conn, req.apiKey.name, action, deadlines.auditDetail(result), req.ip);
        res.status(status).json(result);
    };

    router.get('/', read, handle((req, res, conn) => {
        const { kind, status, due_before: before, due_after: after, overdue, q, limit, offset } = req.query;
        res.json(deadlines.list(conn, { kind, status, due_before: before, due_after: after, overdue, q, limit, offset }));
    }));

    // Fixed words first, so they are never read as an id.
    router.get('/upcoming', read, handle((req, res, conn) => {
        res.json({ deadlines: deadlines.upcoming(conn, { days: req.query.days === undefined ? undefined : req.query.days, limit: req.query.limit }) });
    }));

    router.post('/', write, handle((req, res, conn) => {
        changed(req, res, conn, 'deadline_created', deadlines.create(conn, req.body, req.apiKey.name), 201);
    }));

    router.get('/:id', read, handle((req, res, conn) => {
        res.json(deadlines.get(conn, req.params.id, { rev: req.query.rev }));
    }));

    router.get('/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: deadlines.history(conn, req.params.id) });
    }));

    router.patch('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'deadline_updated', deadlines.update(conn, req.params.id, req.body, req.apiKey.name));
    }));

    router.post('/:id/done', write, handle((req, res, conn) => {
        changed(req, res, conn, 'deadline_done', deadlines.done(conn, req.params.id, req.apiKey.name));
    }));

    router.post('/:id/end', write, handle((req, res, conn) => {
        changed(req, res, conn, 'deadline_ended', deadlines.end(conn, req.params.id, req.apiKey.name));
    }));

    router.post('/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'deadline_restored', deadlines.restore(conn, req.params.id, (req.body || {}).rev, req.apiKey.name));
    }));

    return router;
};
