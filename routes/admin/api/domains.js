// Domain switches and how agents may reach each domain.
const domains = require('../../../services/domains');
const agents = require('../../../services/mcp/agents');

module.exports = (api, ctx) => {
    const { db, audit } = ctx;

    // ---- domains ----
    api.get('/domains', (req, res) => res.json({ domains: agents.domainsWithTools(db.get()) }));

    api.put('/domains/:name', (req, res) => {
        const conn = db.get();
        const { name } = req.params;
        if (!domains.exists(name)) return res.status(404).json({ error: 'No such domain.' });
        if (typeof (req.body || {}).enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
        const enabled = req.body.enabled;
        domains.setEnabled(conn, name, enabled, 'admin');
        audit.record(conn, 'admin', enabled ? 'domain_enabled' : 'domain_disabled', { name }, req.ip);
        res.json({ ok: true, enabled });
    });

    // How agents may reach a domain through /hub/mcp. Only domains that have an agent tool have a mode.
    api.put('/domains/:name/mcp', (req, res) => {
        const conn = db.get();
        const { name } = req.params;
        if (!domains.exists(name)) return res.status(404).json({ error: 'No such domain.' });
        if (!agents.hasTool(name)) return res.status(400).json({ error: 'This domain has no agent tool.' });
        const mode = (req.body || {}).mode;
        if (!domains.MCP_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${domains.MCP_MODES.join(', ')}.` });
        const from = domains.mcpMode(conn, name);
        domains.setMcpMode(conn, name, mode, 'admin');
        audit.record(conn, 'admin', 'domain_mcp_changed', { name, from, to: mode }, req.ip);
        res.json({ ok: true, mode });
    });
};
