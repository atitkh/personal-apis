const preferences = require('../../../services/preferences');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');

module.exports = (api) => {
    // ---- preferences: the dashboard's API. Works while the domain is switched off. Changes are audited as `admin` with
    // id, area and key (preferences.auditDetail), never the value or the notes. There is no delete: unset hides, restore
    // brings back. ----
    const preferenceHandler = adminHandler(preferences.PreferenceError, 'admin preferences error:', { extra: true });
    const preferenceChanged = adminChanged(preferences.auditDetail);

    api.get('/preferences', preferenceHandler((req, res, conn) => {
        const { area, q, removed, limit, offset } = req.query;
        res.json(preferences.list(conn, { area, q, removed, limit: limit || 200, offset }));
    }));

    api.post('/preferences', preferenceHandler((req, res, conn) => {
        preferenceChanged(req, res, conn, 'preference_set', preferences.create(conn, req.body, 'admin'), 201);
    }));

    api.get('/preferences/:id', preferenceHandler((req, res, conn) => {
        res.json({ ...preferences.get(conn, req.params.id, { rev: req.query.rev }), history: preferences.history(conn, req.params.id) });
    }));

    api.get('/preferences/:id/history', preferenceHandler((req, res, conn) => {
        res.json({ revisions: preferences.history(conn, req.params.id) });
    }));

    api.patch('/preferences/:id', preferenceHandler((req, res, conn) => {
        preferenceChanged(req, res, conn, 'preference_updated', preferences.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.post('/preferences/:id/unset', preferenceHandler((req, res, conn) => {
        preferenceChanged(req, res, conn, 'preference_unset', preferences.unset(conn, req.params.id, 'admin'));
    }));

    api.post('/preferences/:id/restore', preferenceHandler((req, res, conn) => {
        preferenceChanged(req, res, conn, 'preference_restored', preferences.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));
};
