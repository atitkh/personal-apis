const deadlines = require('../../../services/deadlines');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');

module.exports = (api) => {
    // ---- deadlines: everything the dashboard needs. The admin sees every field, the private reference included.
    // Works while the domain is switched off. Changes are audited as `admin` with id, title, revision and field
    // names (deadlines.auditDetail), never values. Fixed words come before /deadlines/:id. ----
    const deadlineHandler = adminHandler(deadlines.DeadlineError, 'admin deadlines error:', { extra: true });
    const deadlineChanged = adminChanged(deadlines.auditDetail);

    api.get('/deadlines', deadlineHandler((req, res, conn) => {
        const { kind, status, due_before: before, due_after: after, overdue, q, limit, offset } = req.query;
        res.json(deadlines.list(conn, { kind, status, due_before: before, due_after: after, overdue, q, limit: limit || 500, offset, reference: true }));
    }));

    api.get('/deadlines/upcoming', deadlineHandler((req, res, conn) => {
        res.json({ deadlines: deadlines.upcoming(conn, { days: req.query.days, limit: req.query.limit, reference: true }) });
    }));

    api.post('/deadlines', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_created', deadlines.create(conn, req.body, 'admin'), 201);
    }));

    api.get('/deadlines/:id', deadlineHandler((req, res, conn) => {
        res.json({ ...deadlines.get(conn, req.params.id, { rev: req.query.rev }), history: deadlines.history(conn, req.params.id) });
    }));

    api.patch('/deadlines/:id', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_updated', deadlines.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.post('/deadlines/:id/done', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_done', deadlines.done(conn, req.params.id, 'admin'));
    }));

    api.post('/deadlines/:id/end', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_ended', deadlines.end(conn, req.params.id, 'admin'));
    }));

    api.post('/deadlines/:id/restore', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_restored', deadlines.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));
};
