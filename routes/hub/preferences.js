// /hub/preferences: the preferences domain over REST. Mounted by hub.js, which supplies the rate limit, the JSON
// body parser, no-store and `handle` (turns a PreferenceError into a JSON error).
//   preferences:read   list, get, history
//   preferences:api-write  create, update, unset, restore (also needs preferences:read: the answer is the item)
// There is no DELETE: `unset` hides an item and keeps its history, `restore` brings it back.
// Changes are audited with preferences.auditDetail: id, area and key, never the value or the notes.
const express = require('express');
const preferences = require('../../services/preferences');
const audit = require('../../services/audit');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('preferences:read'), requireDomain('preferences')];
    // One requireScope only: each one counts the call against the key's limit.
    const alsoRead = (req, res, next) => (apiKeys.hasScope(req.apiKey.scopes, 'preferences:read') ? next()
        : res.status(403).json({ error: 'Forbidden', message: 'This key lacks the "preferences:read" scope' }));
    const write = [requireScope('preferences:api-write'), alsoRead, requireDomain('preferences')];

    const changed = (req, res, conn, action, result, status = 200) => {
        if (result.status !== 'unchanged') audit.recordKey(conn, req.apiKey, action, preferences.auditDetail(result), req.ip);
        res.status(status).json(result);
    };

    router.get('/', read, handle((req, res, conn) => {
        const { area, q, removed, limit, offset } = req.query;
        res.json(preferences.list(conn, { area, q, removed, limit, offset }));
    }));

    router.post('/', write, handle((req, res, conn) => {
        changed(req, res, conn, 'preference_set', preferences.create(conn, req.body, req.apiKey.name), 201);
    }));

    router.get('/:id', read, handle((req, res, conn) => {
        res.json(preferences.get(conn, req.params.id, { rev: req.query.rev }));
    }));

    router.get('/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: preferences.history(conn, req.params.id) });
    }));

    router.patch('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'preference_updated', preferences.update(conn, req.params.id, req.body, req.apiKey.name));
    }));

    router.post('/:id/unset', write, handle((req, res, conn) => {
        changed(req, res, conn, 'preference_unset', preferences.unset(conn, req.params.id, req.apiKey.name));
    }));

    router.post('/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'preference_restored', preferences.restore(conn, req.params.id, (req.body || {}).rev, req.apiKey.name));
    }));

    return router;
};
