// Links, for the dashboard: list a record's links, add, remove. Admin session; the admin sees every domain. Audited as
// `admin` with the two ends and the relation. The record picker uses /admin/api/search.
const links = require('../../../services/links');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');

module.exports = (api) => {
    const handler = adminHandler(links.LinkError, 'admin links error:');
    const changed = adminChanged(links.auditDetail);

    api.get('/links', handler((req, res, conn) => res.json(links.listFor(conn, req.query.domain, req.query.id))));

    api.post('/links', handler((req, res, conn) => {
        const r = links.add(conn, req.body, 'admin');
        changed(req, res, conn, 'link_created', r.status === 'exists' ? { ...r, status: 'unchanged' } : r, r.status === 'created' ? 201 : 200);
    }));

    api.delete('/links/:id', handler((req, res, conn) => {
        changed(req, res, conn, 'link_removed', links.remove(conn, req.params.id));
    }));
};
