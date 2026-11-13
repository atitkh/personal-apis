// Webhooks: where the hub pushes briefing changes. Admin session only; never over /hub or MCP. The address and secret are
// credentials: the API returns only the host and whether a secret is set, and the audit rows carry names, never either.
const webhooks = require('../../../services/webhooks');

module.exports = (api, ctx) => {
    const { db, audit } = ctx;
    const handler = (fn) => async (req, res) => {
        try {
            await fn(req, res, db.get());
        } catch (err) {
            if (err instanceof webhooks.WebhookError) {
                return res.status(err.status).json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
            }
            console.error('admin webhooks error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        }
    };
    const idOf = (req) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1) throw new webhooks.WebhookError('No such webhook.', null, 404);
        return id;
    };

    api.get('/webhooks', handler((req, res, conn) => res.json({ webhooks: webhooks.list(conn) })));

    api.post('/webhooks', handler((req, res, conn) => {
        const hook = webhooks.create(conn, req.body);
        audit.record(conn, 'admin', 'webhook_created', { id: hook.id, name: hook.name, host: hook.host }, req.ip);
        res.status(201).json(hook);
    }));

    api.put('/webhooks/:id', handler((req, res, conn) => {
        const id = idOf(req);
        const hook = webhooks.update(conn, id, req.body);
        audit.record(conn, 'admin', 'webhook_updated', { id, name: hook.name, fields: Object.keys(req.body || {}).filter((k) => k !== 'secret' && k !== 'url') }, req.ip);
        res.json(hook);
    }));

    api.delete('/webhooks/:id', handler((req, res, conn) => {
        const id = idOf(req);
        if (!req.body || req.body.confirm !== true) throw new webhooks.WebhookError('Send confirm: true to delete this webhook.', 'confirm');
        const gone = webhooks.remove(conn, id);
        audit.record(conn, 'admin', 'webhook_deleted', gone, req.ip);
        res.json({ ok: true, ...gone });
    }));

    // One message straight to the receiver, outside the outbox.
    api.post('/webhooks/:id/test', handler(async (req, res, conn) => {
        const id = idOf(req);
        const r = await webhooks.sendTest(conn, id);
        audit.record(conn, 'admin', 'webhook_tested', { id, ok: r.ok, status: r.status }, req.ip);
        res.json(r);
    }));

    // Check now and deliver what is due (and retry failed rows when asked).
    api.post('/webhooks/:id/run', handler(async (req, res, conn) => {
        const id = idOf(req);
        if (!webhooks.get(conn, id)) throw new webhooks.WebhookError('No such webhook.', null, 404);
        const retried = req.body && req.body.retry_failed === true ? webhooks.retryFailed(conn, id) : 0;
        const checked = webhooks.check(conn, { id });
        const delivered = await webhooks.deliver(conn, { id });
        audit.record(conn, 'admin', 'webhook_run', { id, new: checked.new, escalated: checked.escalated, resolved: checked.resolved, sent: delivered.sent, retried }, req.ip);
        res.json({ checked, delivered, requeued: retried, webhook: webhooks.get(conn, id) });
    }));

    api.get('/webhooks/:id/events', handler((req, res, conn) => {
        const id = idOf(req);
        if (!webhooks.get(conn, id)) throw new webhooks.WebhookError('No such webhook.', null, 404);
        res.json({ events: webhooks.events(conn, id, req.query.limit) });
    }));
};
