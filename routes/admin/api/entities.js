const entities = require('../../../services/entities');
const suggestions = require('../../../services/entitySuggestions');
const audit = require('../../../services/audit');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api) => {
    // ---- entities: the dashboard's API. Works while the domain is switched off. Changes are audited as `admin` with
    // id, kind, rev and field names (entities.auditDetail), never the name, aliases or notes. ----
    const entityHandler = adminHandler(entities.EntityError, 'admin entities error:', { extra: true, async: true });
    const entityChanged = adminChanged(entities.auditDetail);

    // The review queue ("Suggested" tab). Counts and ids in the audit, never a name.
    const suggestChanged = adminChanged(suggestions.auditDetail);
    api.get('/entities/suggestions', entityHandler((req, res, conn) => {
        const status = req.query.status || 'pending';
        res.json({ status, suggestions: suggestions.list(conn, { status, limit: req.query.limit || 200 }), counts: suggestions.counts(conn) });
    }));
    api.post('/entities/suggestions/dismiss-all', entityHandler((req, res, conn) => {
        const result = suggestions.dismissAllPending(conn, 'admin');
        if (result.status !== 'unchanged') audit.record(conn, 'admin', 'entity_suggestions_dismissed', { count: result.count }, req.ip);
        res.json({ ...result, counts: suggestions.counts(conn) });
    }));
    api.delete('/entities/suggestions', entityHandler((req, res, conn) => removal(req, res, conn, 'entity_suggestion_deleted', {
        plan: () => { needConfirm(bad, req.body); },
        run: () => suggestions.removeWhere(conn, (req.body || {}).status, req.body),
        detail: suggestions.auditDetail,
    })));
    api.post('/entities/suggestions/:id/accept', entityHandler((req, res, conn) => {
        suggestChanged(req, res, conn, 'entity_suggestion_accepted', suggestions.accept(conn, req.params.id, req.body, 'admin'));
    }));
    api.post('/entities/suggestions/:id/dismiss', entityHandler((req, res, conn) => {
        suggestChanged(req, res, conn, 'entity_suggestion_dismissed', suggestions.dismiss(conn, req.params.id, 'admin'));
    }));
    api.delete('/entities/suggestions/:id', entityHandler((req, res, conn) => removal(req, res, conn, 'entity_suggestion_deleted', {
        plan: () => { needConfirm(bad, req.body); },
        run: () => suggestions.remove(conn, req.params.id, req.body),
        detail: suggestions.auditDetail,
    })));

    api.get('/entities', entityHandler((req, res, conn) => {
        const { kind, q, limit, offset } = req.query;
        res.json(entities.list(conn, { kind, q, limit: limit || 200, offset }));
    }));

    api.post('/entities', entityHandler((req, res, conn) => {
        entityChanged(req, res, conn, 'entity_created', entities.create(conn, req.body, 'admin'), 201);
    }));

    api.get('/entities/:id', entityHandler((req, res, conn) => {
        res.json({ ...entities.get(conn, req.params.id, { rev: req.query.rev }), history: entities.history(conn, req.params.id) });
    }));

    api.get('/entities/:id/history', entityHandler((req, res, conn) => {
        res.json({ revisions: entities.history(conn, req.params.id) });
    }));

    api.patch('/entities/:id', entityHandler((req, res, conn) => {
        entityChanged(req, res, conn, 'entity_updated', entities.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.post('/entities/:id/restore', entityHandler((req, res, conn) => {
        entityChanged(req, res, conn, 'entity_restored', entities.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    // Permanent delete (admin only). Body { confirm: true, backup?: true }. The entity's links go with it.
    const bad = (code, message, status) => new entities.EntityError(status || 400, code, message);

    api.get('/entities/:id/delete-preview', entityHandler((req, res, conn) => {
        res.json(entities.removalPreview(conn, req.params.id));
    }));

    api.delete('/entities/:id', entityHandler((req, res, conn) => removal(req, res, conn, 'entity_deleted', {
        plan: () => { needConfirm(bad, req.body); entities.removalPreview(conn, req.params.id); },
        run: () => entities.remove(conn, req.params.id, req.body),
        detail: entities.removedAuditDetail,
    })));
};
