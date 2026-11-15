// /hub/entities: the entities domain over REST. Mounted by hub.js, which supplies the rate limit, the JSON body parser,
// no-store and `handle` (turns an EntityError into a JSON error).
//   entities:read       list, get, history
//   entities:api-write  create, update, restore (also needs entities:read: the answer is the entity)
// There is no DELETE: deleting an entity (and its links) is done by a person at the dashboard.
// Changes are audited with entities.auditDetail: id, kind, rev and field names, never the name, aliases or notes.
const express = require('express');
const entities = require('../../services/entities');
const { keyChanged } = require('../lib/changed');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('entities:read'), requireDomain('entities')];
    // One requireScope only: each one counts the call against the key's limit.
    const alsoRead = (req, res, next) => (apiKeys.hasScope(req.apiKey.scopes, 'entities:read') ? next()
        : res.status(403).json({ error: 'Forbidden', message: 'This key lacks the "entities:read" scope' }));
    const write = [requireScope('entities:api-write'), alsoRead, requireDomain('entities')];

    const changed = keyChanged(entities.auditDetail);

    router.get('/', read, handle((req, res, conn) => {
        const { kind, q, limit, offset } = req.query;
        res.json(entities.list(conn, { kind, q, limit, offset }));
    }));

    router.post('/', write, handle((req, res, conn) => {
        changed(req, res, conn, 'entity_created', entities.create(conn, req.body, req.apiKey.name), 201);
    }));

    router.get('/:id', read, handle((req, res, conn) => {
        res.json(entities.get(conn, req.params.id, { rev: req.query.rev }));
    }));

    router.get('/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: entities.history(conn, req.params.id) });
    }));

    router.patch('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'entity_updated', entities.update(conn, req.params.id, req.body, req.apiKey.name));
    }));

    router.post('/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'entity_restored', entities.restore(conn, req.params.id, (req.body || {}).rev, req.apiKey.name));
    }));

    return router;
};
