// Lifelog: what the dashboard needs (day, observations, episodes with history and restore, links, a manual note,
// sources, stats) and the one way anything is ever deleted: "forget a time range" (preview, confirm: true, optional
// pre-delete backup). Works while the domain is switched off. Audited as `admin` with ids, kinds, revisions, field
// names, ranges and counts (lifelog.auditDetail / forgetAuditDetail), never text, titles or detail.
// Fixed words (day, observations, episodes, sources, stats, forget-preview) come before /:id.
const lifelog = require('../../../services/lifelog');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api) => {
    const handler = adminHandler(lifelog.LifelogError, 'admin lifelog error:', { extra: true, async: true });
    const changed = adminChanged(lifelog.auditDetail);
    const bad = (code, message, status) => new lifelog.LifelogError(status || 400, code, message);

    api.get('/lifelog/day/:date', handler((req, res, conn) => {
        res.json(lifelog.day(conn, req.params.date));
    }));

    api.get('/lifelog/observations', handler((req, res, conn) => {
        const { source, kind, from, to, local_date, q, limit, offset, order } = req.query;
        res.json(lifelog.listObservations(conn, { source, kind, from, to, local_date, q, limit, offset, order }));
    }));

    // A manual note: one observation with source 'dashboard'.
    api.post('/lifelog/observations', handler((req, res, conn) => {
        changed(req, res, conn, 'lifelog_observation_added', lifelog.addObservation(conn, req.body, { source: 'dashboard' }), 201);
    }));

    // Forget a time range. Body { from, to, source?, confirm: true, backup?: true }. Episodes lying fully inside go
    // too; overlapping ones stay without the links.
    api.delete('/lifelog/observations', handler((req, res, conn) => removal(req, res, conn, 'lifelog_forgotten', {
        plan: () => { needConfirm(bad, req.body); lifelog.forgetPreview(conn, req.body); },
        run: () => lifelog.forget(conn, req.body),
        detail: lifelog.forgetAuditDetail,
    })));

    api.get('/lifelog/forget-preview', handler((req, res, conn) => {
        const { from, to, source } = req.query;
        res.json(lifelog.forgetPreview(conn, { from, to, source }));
    }));

    api.get('/lifelog/sources', handler((req, res, conn) => {
        res.json({ sources: lifelog.sources(conn) });
    }));

    api.get('/lifelog/stats', handler((req, res, conn) => {
        res.json(lifelog.stats(conn));
    }));

    api.get('/lifelog/episodes', handler((req, res, conn) => {
        const { kind, status, source, from, to, local_date, q, limit, offset, order } = req.query;
        res.json(lifelog.listEpisodes(conn, { kind, status, source, from, to, local_date, q, limit: limit || lifelog.LIST_MAX, offset, order }));
    }));

    api.post('/lifelog/episodes', handler((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_created', lifelog.createEpisode(conn, req.body, 'admin'), 201);
    }));

    api.get('/lifelog/episodes/:id', handler((req, res, conn) => {
        res.json({ ...lifelog.getEpisode(conn, req.params.id, { rev: req.query.rev }), history: lifelog.history(conn, req.params.id) });
    }));

    api.get('/lifelog/episodes/:id/history', handler((req, res, conn) => {
        res.json({ revisions: lifelog.history(conn, req.params.id) });
    }));

    api.patch('/lifelog/episodes/:id', handler((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_updated', lifelog.updateEpisode(conn, req.params.id, req.body, 'admin'));
    }));

    api.post('/lifelog/episodes/:id/restore', handler((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_restored', lifelog.restoreEpisode(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    // Body { observation_ids: [...] }.
    api.post('/lifelog/episodes/:id/observations', handler((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_linked', lifelog.link(conn, req.params.id, (req.body || {}).observation_ids, 'admin'));
    }));

    api.post('/lifelog/episodes/:id/observations/unlink', handler((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_unlinked', lifelog.unlink(conn, req.params.id, (req.body || {}).observation_ids, 'admin'));
    }));
};
