// /hub/mcp: the hub as an MCP server for agents (streamable HTTP, stateless: a fresh server per request).
// Auth is the same API key as the rest of /hub; which tools a key sees is decided per request in
// services/mcp/registry.js. One audit row per tool call, never with its content. Not listed in /api.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const db = require('../../db');
const audit = require('../../services/audit');
const registry = require('../../services/mcp/registry');
const { requireKey } = require('../../middleware/apiKey');

const router = express.Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false }));
router.use(express.json({ limit: '256kb' }));
router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});
router.use(requireKey());

// Names and actions go into the audit log, so only short plain words are kept.
const word = (v) => (typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : null);

// The tools/call messages in a request body (one message, or a batch).
function toolCalls(body) {
    const messages = Array.isArray(body) ? body : [body];
    return messages
        .filter((m) => m && m.method === 'tools/call' && m.id != null)
        .map((m) => ({ id: String(m.id), tool: word(m.params && m.params.name), action: word(m.params && m.params.arguments && m.params.arguments.action) }));
}

router.post('/', async (req, res) => {
    const key = req.apiKey;
    const calls = toolCalls(req.body);
    const outcomes = new Map();
    let server;
    let transport;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        // A call that never reached its handler (unknown tool, an action this key is not offered, bad
        // arguments) is logged as not ok.
        for (const c of calls) {
            const o = outcomes.get(c.id) || { ok: false, error: 'rejected' };
            const detail = { key: key.name, tool: c.tool, action: c.action, ok: o.ok === true };
            if (!detail.ok) detail.error = o.error;
            try { audit.record(db.get(), key.name, 'mcp_call', detail, req.ip); } catch (err) { console.error('mcp audit failed:', err.message); }
        }
        if (transport) transport.close().catch(() => {});
        if (server) server.close().catch(() => {});
    };
    res.on('finish', finish);
    res.on('close', finish);
    try {
        server = registry.buildServer(db.get(), key, (id, outcome) => outcomes.set(String(id), outcome));
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('mcp request failed:', err);
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
});

// Stateless: no server-sent event stream to open (GET) and no session to end (DELETE).
router.all('/', (req, res) => {
    res.set('Allow', 'POST').status(405).json({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; send JSON-RPC with POST.' }, id: null,
    });
});

module.exports = router;
