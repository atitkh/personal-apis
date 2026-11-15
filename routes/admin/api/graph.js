// The Graph page's data: a record's neighbourhood, the most connected records, the records with no link. Read only.
const graph = require('../../../services/graph');
const links = require('../../../services/links');
const { adminHandler } = require('../../lib/handle');
const { HubError } = require('../../../services/errors');

module.exports = (api) => {
    const handler = adminHandler(HubError, 'admin graph error:');
    api.get('/graph', handler((req, res, conn) => {
        res.json({ ...graph.neighborhood(conn, { domain: req.query.domain, id: req.query.id, depth: req.query.depth }), domains: links.linkable() });
    }));
    api.get('/graph/overview', handler((req, res, conn) => res.json(graph.overview(conn, { cap: req.query.cap }))));
    api.get('/graph/hubs', handler((req, res, conn) => res.json({ hubs: graph.hubs(conn, { limit: req.query.limit }) })));
    api.get('/graph/unlinked', handler((req, res, conn) => res.json(graph.unlinked(conn, { domain: req.query.domain, limit: req.query.limit }))));
};
