const places = require('../../../services/places');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api, ctx) => {
    const { audit } = ctx;

    // ---- places (works while the domain is switched off, like digests). Changes are audited as by
    // `admin` with ids, labels and rule types only, never rule values or streets. ----
    const placeHandler = adminHandler(places.PlaceError, 'admin places error:', { async: true });
    const placeChanged = adminChanged(places.auditDetail);

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

    const bad = (code, message, status) => new places.PlaceError(status || 400, code, message);
    // Delete a queue spot, or every dismissed one (the fixed word first). Body { confirm: true, backup?: true }.
    api.delete('/places/suggestions/dismissed', placeHandler((req, res, conn) => removal(req, res, conn, 'place_suggestion_deleted', {
        plan: () => { needConfirm(bad, req.body); },
        run: () => places.removeDismissedSuggestions(conn, req.body),
        detail: places.suggestionRemovedAuditDetail,
    })));

    api.delete('/places/suggestions/:id', placeHandler((req, res, conn) => removal(req, res, conn, 'place_suggestion_deleted', {
        plan: () => { needConfirm(bad, req.body); },
        run: () => places.removeSuggestion(conn, req.params.id, req.body),
        detail: places.suggestionRemovedAuditDetail,
    })));

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

    // Permanent delete: body { confirm: true, backup?: true }. /hub still has its own older place delete.
    api.get('/places/:id/delete-preview', placeHandler((req, res, conn) => {
        res.json(places.placeRemovalPreview(conn, req.params.id));
    }));

    api.delete('/places/:id', placeHandler((req, res, conn) => removal(req, res, conn, 'place_deleted', {
        plan: () => { needConfirm(bad, req.body); places.placeRemovalPreview(conn, req.params.id); },
        run: () => places.removePlace(conn, req.params.id, req.body),
        detail: places.removedAuditDetail,
    })));

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
