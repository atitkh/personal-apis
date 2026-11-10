// What the dashboard shows about agent access: the tools, what each key can see right now (worked out by
// the registry's own rules) and how often keys called. Counts come from the 'mcp_call' audit rows, which hold
// the key name, tool, action and outcome but never content. Key secrets and hashes are never read here.
const apiKeys = require('../apiKeys');
const domains = require('../domains');
const registry = require('./registry');

const ENDPOINT = '/hub/mcp';
const DAY_MS = 24 * 60 * 60 * 1000;

const hasTool = (name) => registry.TOOLS.some((def) => def.domain === name);

// domains.list() plus whether the domain has an agent tool at all.
const domainsWithTools = (conn) => domains.list(conn).map((d) => ({ ...d, mcpTool: hasTool(d.name) }));

function tools() {
    return [
        { tool: 'hub_overview', domain: null, alwaysOn: true, actions: [] },
        ...registry.TOOLS.map((def) => ({
            tool: def.domain,
            domain: def.domain,
            title: domains.REGISTRY[def.domain].title,
            readScope: def.readScope,
            actions: Object.entries(def.actions).map(([name, a]) => ({ name, scope: a.scope, write: Boolean(a.write) })),
        })),
    ];
}

// The domain tools a key sees right now; a revoked key sees nothing.
function visibleFor(conn, key) {
    if (key.revoked_at) return [];
    return registry.visibleTools(conn, key).map(({ def, actions }) => ({
        tool: def.domain,
        actions,
        writes: actions.some((a) => def.actions[a].write),
    }));
}

const since = (now, days) => new Date(now.getTime() - days * DAY_MS).toISOString();

function callCount(conn, now = new Date(), days = 1) {
    return conn.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'mcp_call' AND at >= ?").get(since(now, days)).n;
}

// Active keys that would be offered at least one domain tool right now.
function keysWithTools(conn) {
    return apiKeys.list(conn).filter((k) => visibleFor(conn, k).length > 0).length;
}

function summary(conn, now = new Date()) {
    const counts = new Map(conn.prepare(
        "SELECT actor, COUNT(*) AS n FROM audit_log WHERE action = 'mcp_call' AND at >= ? GROUP BY actor",
    ).all(since(now, 30)).map((r) => [r.actor, r.n]));
    const last = new Map(conn.prepare(
        "SELECT actor, MAX(at) AS at FROM audit_log WHERE action = 'mcp_call' GROUP BY actor",
    ).all().map((r) => [r.actor, r.at]));

    const keys = apiKeys.list(conn).map((k) => {
        const visible = visibleFor(conn, k);
        return {
            id: k.id,
            name: k.name,
            scopes: k.scopes,
            revoked: Boolean(k.revoked_at),
            lastUsedAt: k.last_used_at || null,
            visibleTools: visible.map(({ tool, actions }) => ({ tool, actions })),
            canWrite: visible.some((t) => t.writes),
            calls30d: counts.get(k.name) || 0,
            lastCallAt: last.get(k.name) || null,
        };
    });

    const recent = conn.prepare(
        "SELECT at, actor, detail FROM audit_log WHERE action = 'mcp_call' ORDER BY id DESC LIMIT 50",
    ).all().map(callRow);

    return { endpoint: ENDPOINT, tools: tools(), keys, recent };
}

function callRow(r) {
    let d = {};
    try { d = JSON.parse(r.detail) || {}; } catch (err) { d = {}; }
    return { at: r.at, key: d.key || r.actor, tool: d.tool || null, action: d.action || null, ok: d.ok === true };
}

// One key's latest agent calls (tool, action, outcome; never content). Calls are logged by key name, so only
// calls made while this key existed count, in case an older revoked key had the same name.
function callsFor(conn, key, limit = 20) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const until = key.revoked_at || null;
    return conn.prepare(
        "SELECT at, actor, detail FROM audit_log WHERE action = 'mcp_call' AND actor = ? AND at >= ? AND (? IS NULL OR at <= ?) ORDER BY id DESC LIMIT ?",
    ).all(key.name, key.created_at, until, until, n).map(callRow);
}

module.exports = { ENDPOINT, hasTool, domainsWithTools, tools, visibleFor, callCount, keysWithTools, summary, callsFor };
