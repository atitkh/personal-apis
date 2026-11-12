const digests = require('../../../services/digests');
const { adminHandler } = require('../../lib/handle');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api, ctx) => {
    const { audit } = ctx;

    // ---- digests (the dashboard may read and edit them even while the domain is switched off) ----
    const digestHandler = adminHandler(digests.DigestError, 'admin digest error:', { code: false, async: true });

    api.get('/digests', digestHandler((req, res, conn) => {
        const { kind, q, limit, offset, from, to } = req.query;
        if (q) return res.json({ results: digests.search(conn, q, { kind, limit }) });
        const out = { digests: digests.list(conn, { kind, limit, offset, from, to }) };
        if (kind) out.bounds = digests.bounds(conn, kind);
        res.json(out);
    }));

    api.get('/digests/:kind/:period', digestHandler((req, res, conn) => {
        const d = digests.get(conn, req.params.kind, req.params.period, { rev: req.query.rev });
        res.json({ ...d, history: digests.revisions(conn, req.params.kind, req.params.period) });
    }));

    api.patch('/digests/:kind/:period', digestHandler((req, res, conn) => {
        const { kind, period } = req.params;
        const result = digests.edit(conn, kind, period, { body: (req.body || {}).body, note: (req.body || {}).note, actor: 'admin' });
        if (result.status === 'updated') audit.record(conn, 'admin', 'digest_edited', { kind, period, rev: result.rev }, req.ip);
        res.json(result);
    }));

    api.post('/digests/:kind/:period/restore', digestHandler((req, res, conn) => {
        const { kind, period } = req.params;
        const result = digests.restore(conn, kind, period, (req.body || {}).rev, 'admin');
        if (result.status === 'updated') audit.record(conn, 'admin', 'digest_restored', { kind, period, rev: result.rev }, req.ip);
        res.json(result);
    }));

    // Permanent delete of one digest with its revisions and search row. Body { confirm: true, backup?: true }.
    const bad = (code, message, status) => new digests.DigestError(status || 400, code, message);

    api.get('/digests/:kind/:period/delete-preview', digestHandler((req, res, conn) => {
        res.json(digests.removalPreview(conn, req.params.kind, req.params.period));
    }));

    api.delete('/digests/:kind/:period', digestHandler((req, res, conn) => removal(req, res, conn, 'digest_deleted', {
        plan: () => { needConfirm(bad, req.body); digests.removalPreview(conn, req.params.kind, req.params.period); },
        run: () => digests.remove(conn, req.params.kind, req.params.period, req.body),
        detail: digests.removedAuditDetail,
    })));
};
