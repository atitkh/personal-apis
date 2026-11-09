// The hub's MCP tools. `hub_overview` plus one tool per domain, each with a small `action` enum.
// Each domain declares its tool in services/mcp/domains/<domain>.js:
//   domain     the name in services/domains.js (must exist there)
//   readScope  needed to see the tool at all
//   actions    { name: { scope, write?, describe } }; write actions also need the domain's mcp_mode = write
//   input(z, actions)  zod fields besides `action` (actions = what this key may use)
//   run(action, args, { db, key })  returns a plain object
//   untrusted  results carry outside text: prefix them with util.DATA_NOTE
//   brief(db)  optional, short items for hub_overview
// What a key sees is worked out per request; a tool or action the key cannot use is not listed, and every
// call is checked again when it runs.
const fs = require('fs');
const path = require('path');
const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const db = require('../../db');
const domains = require('../domains');
const apiKeys = require('../apiKeys');
const { version } = require('../../package.json');
const { DATA_NOTE, MAX_RESULT_CHARS, ToolError, truncMarker } = require('./util');

const OVERVIEW_MAX_CHARS = 6000;

function load() {
    const dir = path.join(__dirname, 'domains');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => {
        const def = require(path.join(dir, f));
        if (!domains.exists(def.domain)) throw new Error(`MCP tool ${f} is for "${def.domain}", which is not a hub domain`);
        return def;
    });
}
const TOOLS = load();

// The actions of one domain tool this key may use right now; empty = the tool is not offered.
function visibleActions(conn, def, key) {
    if (!domains.isEnabled(conn, def.domain)) return [];
    const mode = domains.mcpMode(conn, def.domain);
    if (mode === 'off' || !apiKeys.hasScope(key.scopes, def.readScope)) return [];
    return Object.entries(def.actions)
        .filter(([, a]) => (!a.write || mode === 'write') && apiKeys.hasScope(key.scopes, a.scope))
        .map(([name]) => name);
}

function visibleTools(conn, key) {
    return TOOLS.map((def) => ({ def, actions: visibleActions(conn, def, key) })).filter((t) => t.actions.length > 0);
}

function capResult(text) {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return `${text.slice(0, MAX_RESULT_CHARS)}\n${truncMarker(MAX_RESULT_CHARS, text.length)}`;
}

const textResult = (data, untrusted) => ({
    content: [{ type: 'text', text: capResult(`${untrusted ? `${DATA_NOTE}\n` : ''}${JSON.stringify(data, null, 1)}`) }],
});

const errorResult = (code, message) => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
});

// Errors meant for the caller (bad input, not found, edited) carry a code; anything else is a bug.
function toError(err) {
    if (err instanceof ToolError) return errorResult(err.code, err.message);
    if (typeof err.code === 'string' && typeof err.status === 'number' && err.status < 500) return errorResult(err.code, err.message);
    console.error('mcp tool error:', err);
    return errorResult('server_error', 'Something went wrong.');
}

// What this key can reach, plus a short brief, under OVERVIEW_MAX_CHARS.
function overview(conn, key) {
    const tools = visibleTools(conn, key);
    const out = {
        key: key.name,
        domains: tools.map(({ def, actions }) => {
            const decl = domains.REGISTRY[def.domain];
            let stats = {};
            try { stats = decl.stats(conn) || {}; } catch (err) { stats = {}; }
            return {
                name: def.domain,
                title: decl.title,
                sensitivity: decl.sensitivity,
                mcpMode: domains.mcpMode(conn, def.domain),
                records: stats.records == null ? null : stats.records,
                actions,
            };
        }),
        brief: [],
        truncated: false,
    };
    let untrusted = false;
    for (const { def } of tools) {
        if (!def.brief) continue;
        const items = def.brief(conn);
        if (items.length && def.untrusted) untrusted = true;
        out.brief.push(...items.map((i) => ({ domain: def.domain, ...i })));
    }
    const render = () => `${untrusted ? `${DATA_NOTE}\n` : ''}${JSON.stringify(out, null, 1)}`;
    let text = render();
    while (text.length > OVERVIEW_MAX_CHARS && out.brief.length > 0) {
        out.brief.pop();
        out.truncated = true;
        out.truncatedNote = `Shortened to stay under ${OVERVIEW_MAX_CHARS} characters; use the domain tools for the full text.`;
        text = render();
    }
    if (text.length > OVERVIEW_MAX_CHARS) text = `${text.slice(0, OVERVIEW_MAX_CHARS)}\n${truncMarker(OVERVIEW_MAX_CHARS, text.length)}`;
    return { content: [{ type: 'text', text }] };
}

function describe(def, actions) {
    return `${def.description}\nActions:\n${actions.map((a) => `- ${def.actions[a].describe}`).join('\n')}`;
}

// A fresh server for one request, holding only what `key` may use. `report(requestId, outcome)` hears how
// each call ended, for the audit log.
function buildServer(conn, key, report = () => {}) {
    const server = new McpServer({ name: 'personal-hub', version });

    server.registerTool('hub_overview', {
        title: 'Hub overview',
        description: 'What this hub holds that you can reach (domains, record counts, allowed actions) and a short brief of the latest daily digests. Call this first.',
        annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (extra) => {
        try {
            const result = overview(db.get(), key);
            report(extra.requestId, { ok: true });
            return result;
        } catch (err) {
            report(extra.requestId, { ok: false, error: 'server_error' });
            return toError(err);
        }
    });

    for (const { def, actions } of visibleTools(conn, key)) {
        const writes = actions.some((a) => def.actions[a].write);
        server.registerTool(def.domain, {
            title: domains.REGISTRY[def.domain].title,
            description: describe(def, actions),
            inputSchema: { action: z.enum(actions).describe('What to do'), ...def.input(z, actions) },
            annotations: { readOnlyHint: !writes, destructiveHint: false, idempotentHint: !writes, openWorldHint: false },
        }, async (args, extra) => {
            try {
                // Checked again at run time: the operator may have changed the domain since the list was made.
                const live = db.get();
                if (!visibleActions(live, def, key).includes(args.action)) {
                    throw new ToolError('not_allowed', `The ${args.action} action of ${def.domain} is not available to this key.`);
                }
                const data = def.run(args.action, args, { db: live, key });
                report(extra.requestId, { ok: true });
                return textResult(data, def.untrusted);
            } catch (err) {
                const result = toError(err);
                report(extra.requestId, { ok: false, error: JSON.parse(result.content[0].text).error });
                return result;
            }
        });
    }
    return server;
}

module.exports = { TOOLS, visibleActions, visibleTools, buildServer, overview, OVERVIEW_MAX_CHARS };
