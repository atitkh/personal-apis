// Search across every enabled domain, for the dashboard. Admin session only. The admin sees all domains (lifelog
// episodes included); results hold the same safe text the agent tool gets: no references, amounts or addresses.
const search = require('../../../services/search');
const { adminHandler } = require('../../lib/handle');

module.exports = (api) => {
    const handler = adminHandler(search.SearchError, 'admin search error:', { extra: false });
    api.get('/search', handler((req, res, conn) => {
        const only = typeof req.query.domains === 'string' ? req.query.domains.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
        res.json(search.search(conn, req.query.q, { domains: only, perDomain: req.query.per_domain || 10 }));
    }));
};
