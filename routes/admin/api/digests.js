const digests = require('../../../services/digests');

module.exports = (api, ctx) => {
    const { db, audit } = ctx;

    // ---- digests (the dashboard may read and edit them even while the domain is switched off) ----
    const digestHandler = (fn) => (req, res) => {
        try {
            fn(req, res, db.get());
        } catch (err) {
            if (err instanceof digests.DigestError) return res.status(err.status).json({ error: err.message });
            console.error('admin digest error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        }
    };

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
};
