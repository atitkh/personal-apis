// /hub/links: links between records of any two domains over REST. Needs a key with links:read (list) or links:api-write
// (create, remove); what a key sees and may link is limited to domains it can read, as for the agent tool. Removing a
// link is a POST (there are no DELETE routes under /hub). Audit rows carry the two ends and the relation, never titles.
const express = require('express');
const links = require('../../services/links');
const briefing = require('../../services/briefing');
const apiKeys = require('../../services/apiKeys');
const { keyChanged } = require('../lib/changed');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('links:read'), requireDomain('links')];
    const alsoRead = (req, res, next) => (apiKeys.hasScope(req.apiKey.scopes, 'links:read') ? next()
        : res.status(403).json({ error: 'Forbidden', message: 'This key lacks the "links:read" scope' }));
    const write = [requireScope('links:api-write'), alsoRead, requireDomain('links')];
    const changed = keyChanged(links.auditDetail);
    const visible = (req, conn) => briefing.visibleDomainsFor(conn, req.apiKey);

    router.get('/', read, handle((req, res, conn) => {
        res.json(links.listFor(conn, req.query.domain, req.query.id, { visible: visible(req, conn) }));
    }));

    router.post('/', write, handle((req, res, conn) => {
        const r = links.add(conn, req.body, req.apiKey.name, { visible: visible(req, conn) });
        changed(req, res, conn, 'link_created', r.status === 'exists' ? { ...r, status: 'unchanged' } : r, r.status === 'created' ? 201 : 200);
    }));

    router.post('/:id/remove', write, handle((req, res, conn) => {
        changed(req, res, conn, 'link_removed', links.remove(conn, req.params.id, { visible: visible(req, conn) }));
    }));

    return router;
};
