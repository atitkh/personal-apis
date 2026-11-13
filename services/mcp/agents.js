// What the dashboard shows about agent access: the tools, what each key can see right now (worked out by
// the registry's own rules) and how often keys called. Counts come from the 'mcp_call' audit rows, which hold
// the key name, tool, action and outcome but never content. Key secrets and hashes are never read here.
const apiKeys = require('../apiKeys');
const domains = require('../domains');
const registry = require('./registry');
const { clampLimit } = require('../lib/listing');

const ENDPOINT = '/hub/mcp';
const DAY_MS = 24 * 60 * 60 * 1000;

const hasTool = (name) => registry.TOOLS.some((def) => def.domain === name);

// domains.list() plus whether the domain has an agent tool at all.
const domainsWithTools = (conn) => domains.list(conn).map((d) => ({ ...d, mcpTool: hasTool(d.name) }));

function tools() {
    return [
        { tool: 'hub_overview', domain: null, general: true, title: 'Hub overview', scope: registry.GENERAL.hub_overview, actions: [] },
        { tool: 'hub_briefing', domain: null, general: true, title: 'Hub briefing', scope: registry.GENERAL.hub_briefing, actions: [] },
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

// Calls are attributed by the key id in the row's detail (so a renamed key keeps its history); rows from before key_id
// existed carry only the key's name and are matched by that name.
const KEY_ID_SQL = "CASE WHEN json_valid(detail) THEN json_extract(detail, '$.key_id') END";

function callTotals(conn, sinceIso) {
    const where = sinceIso ? "action = 'mcp_call' AND at >= ?" : "action = 'mcp_call'";
    const rows = conn.prepare(`SELECT ${KEY_ID_SQL} AS kid, actor, COUNT(*) AS n, MAX(at) AS at FROM audit_log WHERE ${where} GROUP BY kid, actor`)
        .all(...(sinceIso ? [sinceIso] : []));
    return (key) => {
        let n = 0;
        let at = null;
        for (const r of rows) {
            if (!(r.kid === key.id || (r.kid === null && r.actor === key.name))) continue;
            n += r.n;
            if (!at || r.at > at) at = r.at;
        }
        return { n, at };
    };
}

function summary(conn, now = new Date()) {
    const month = callTotals(conn, since(now, 30));
    const ever = callTotals(conn, null);

    const all = apiKeys.list(conn);
    const names = new Map(all.map((k) => [k.id, k.name]));
    const keys = all.map((k) => {
        const visible = visibleFor(conn, k);
        return {
            id: k.id,
            name: k.name,
            scopes: k.scopes,
            revoked: Boolean(k.revoked_at),
            lastUsedAt: k.last_used_at || null,
            visibleTools: visible.map(({ tool, actions }) => ({ tool, actions })),
            general: !k.revoked_at ? Object.keys(registry.GENERAL).filter((t) => registry.mayUseGeneral(k, t)) : [],
            canWrite: visible.some((t) => t.writes),
            calls30d: month(k).n,
            lastCallAt: ever(k).at,
        };
    });

    const recent = conn.prepare(
        "SELECT at, actor, detail FROM audit_log WHERE action = 'mcp_call' ORDER BY id DESC LIMIT 50",
    ).all().map((r) => callRow(r, names));

    return { endpoint: ENDPOINT, tools: tools(), keys, recent };
}

// names: key id -> the key's current name, so a renamed key shows under its new name (the row keeps the old one as a snapshot).
function callRow(r, names = new Map()) {
    let d = {};
    try { d = JSON.parse(r.detail) || {}; } catch (err) { d = {}; }
    return { at: r.at, key: names.get(d.key_id) || d.key || r.actor, tool: d.tool || null, action: d.action || null, ok: d.ok === true };
}

// One key's latest agent calls (tool, action, outcome; never content). Rows carry the key id, so a renamed key keeps its
// history. Older rows have only the name: those count when the key existed (created to revoked), in case an earlier
// revoked key had the same name.
function callsFor(conn, key, limit = 20) {
    const n = clampLimit(limit, 20, 100);
    const until = key.revoked_at || null;
    return conn.prepare(
        `SELECT at, actor, detail FROM audit_log WHERE action = 'mcp_call' AND (
            ${KEY_ID_SQL} = ?
            OR (${KEY_ID_SQL} IS NULL AND actor = ? AND at >= ? AND (? IS NULL OR at <= ?))
        ) ORDER BY id DESC LIMIT ?`,
    ).all(key.id, key.name, key.created_at, until, until, n).map((r) => callRow(r, new Map([[key.id, key.name]])));
}

module.exports = { ENDPOINT, hasTool, domainsWithTools, tools, visibleFor, callCount, keysWithTools, summary, callsFor };
