const places = require('../../../services/places');

module.exports = (api, ctx) => {
    const { db, audit } = ctx;

    // ---- places (works while the domain is switched off, like digests). Changes are audited as by
    // `admin` with ids, labels and rule types only, never rule values or streets. ----
    const placeHandler = (fn) => (req, res) => {
        try {
            fn(req, res, db.get());
        } catch (err) {
            if (err instanceof places.PlaceError) return res.status(err.status).json({ error: err.message, code: err.code });
            console.error('admin places error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        }
    };
    const placeChanged = (req, res, conn, action, result, status = 200) => {
        if (result.status !== 'unchanged') audit.record(conn, 'admin', action, places.auditDetail(result), req.ip);
        res.status(status).json(result);
    };

    api.get('/places', placeHandler((req, res, conn) => {
        const list = places.list(conn, { kind: req.query.kind }).map((p) => ({
            ...p, ruleCount: p.rules.length, revisions: p.rev, lastChange: { at: p.updated_at, by: p.updated_by },
        }));
        res.json({ places: list, kinds: places.KINDS, ruleTypes: places.RULE_TYPES, suggestions: places.suggestionCounts(conn) });
    }));

    // Fixed words before /places/:id.
    api.post('/places/resolve', placeHandler((req, res, conn) => {
        res.json(places.resolve(conn, { ...(req.body || {}), suggest: false })); // the resolve box never files suggestions
    }));

    api.get('/places/suggestions', placeHandler((req, res, conn) => {
        const status = req.query.status || 'pending';
        res.json({ status, suggestions: places.suggestions(conn, { status, limit: req.query.limit }), counts: places.suggestionCounts(conn) });
    }));

    api.post('/places/suggestions/:id/accept', placeHandler((req, res, conn) => {
        const result = places.acceptSuggestion(conn, req.params.id, req.body, 'admin');
        audit.record(conn, 'admin', 'place_suggestion_accepted', places.suggestionAuditDetail(result), req.ip);
        res.json(result);
    }));

    api.post('/places/suggestions/:id/dismiss', placeHandler((req, res, conn) => {
        const result = places.dismissSuggestion(conn, req.params.id, 'admin');
        if (result.status !== 'unchanged') audit.record(conn, 'admin', 'place_suggestion_dismissed', places.suggestionAuditDetail(result), req.ip);
        res.json(result);
    }));

    api.post('/places', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_created', places.create(conn, req.body, 'admin'), 201);
    }));

    // One place (?rev= for an old revision) with its whole history.
    api.get('/places/:id', placeHandler((req, res, conn) => {
        res.json({ ...places.get(conn, req.params.id, { rev: req.query.rev }), history: places.history(conn, req.params.id) });
    }));

    api.patch('/places/:id', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_updated', places.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.delete('/places/:id', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_deleted', places.remove(conn, req.params.id));
    }));

    api.post('/places/:id/restore', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_restored', places.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    api.post('/places/:id/rules', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_rule_added', places.addRule(conn, req.params.id, req.body, 'admin'), 201);
    }));

    api.patch('/places/:id/rules/:ruleId', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_rule_updated', places.updateRule(conn, req.params.id, req.params.ruleId, req.body, 'admin'));
    }));

    api.delete('/places/:id/rules/:ruleId', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_rule_removed', places.removeRule(conn, req.params.id, req.params.ruleId, 'admin'));
    }));
};
