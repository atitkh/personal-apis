// API keys: list, create, edit in place, recent agent calls, revoke.
const apiKeys = require('../../../services/apiKeys');
const agents = require('../../../services/mcp/agents');

module.exports = (api, ctx) => {
    const { db, audit } = ctx;

    api.get('/keys', (req, res) => res.json({ keys: apiKeys.list(db.get()) }));

    api.post('/keys', (req, res) => {
        const conn = db.get();
        const { name, scopes } = req.body || {};
        try {
            const key = apiKeys.create(conn, { name, scopes });
            audit.record(conn, 'admin', 'key_created', { id: key.id, name: key.name, scopes: key.scopes }, req.ip);
            res.status(201).json(key); // the only time the key itself is returned
        } catch (err) {
            const dup = /UNIQUE/i.test(err.message);
            res.status(dup ? 409 : 400).json({ error: dup ? `A key named "${name}" is already active.` : err.message });
        }
    });

    // Edit a live key in place: name and/or scopes. The secret never changes and is never returned.
    api.patch('/keys/:id', (req, res) => {
        const conn = db.get();
        const id = Number(req.params.id);
        const { name, scopes, confirm_all: confirmAll } = req.body || {};
        try {
            const out = apiKeys.update(conn, id, { name, scopes, confirmAll });
            if (out.added.length || out.removed.length || out.renamedFrom) {
                audit.record(conn, 'admin', 'key_updated', {
                    id, name: out.key.name, ...(out.renamedFrom ? { renamed_from: out.renamedFrom } : {}), added: out.added, removed: out.removed,
                }, req.ip);
            }
            res.json(out.key);
        } catch (err) {
            res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not update the key.' });
        }
    });

    // A key's latest agent calls for its detail drawer: tool, action, outcome and time, never content.
    api.get('/keys/:id/calls', (req, res) => {
        const conn = db.get();
        const id = Number(req.params.id);
        const key = Number.isInteger(id) ? apiKeys.list(conn).find((k) => k.id === id) : null;
        if (!key) return res.status(404).json({ error: 'No key with that id.' });
        res.json({ calls: agents.callsFor(conn, key, req.query.limit) });
    });

    api.delete('/keys/:id', (req, res) => {
        const conn = db.get();
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? conn.prepare('SELECT name FROM api_keys WHERE id = ?').get(id) : null;
        if (!row || !apiKeys.revoke(conn, id)) return res.status(404).json({ error: 'No active key with that id.' });
        audit.record(conn, 'admin', 'key_revoked', { id, name: row.name }, req.ip);
        res.json({ ok: true });
    });
};
