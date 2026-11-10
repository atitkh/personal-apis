// The hub's domains: kinds of data the hub holds. What a domain is (title, sensitivity, where its data
// lives) is declared here in code; the database stores only the operator's on/off choice.
//   public  - may be served without a key (the portfolio)
//   private - only ever served from key-protected /hub routes
const REGISTRY = {
    digests: {
        title: 'Digests',
        sensitivity: 'private',
        storage: 'db',
        defaultEnabled: true,
        stats: (db) => require('./digests').stats(db),
    },
    portfolio: {
        title: 'Portfolio',
        sensitivity: 'public',
        storage: 'files',
        defaultEnabled: true,
        // Turning this off takes the public site down, so the dashboard asks twice.
        confirmOff: 'Your public portfolio site stops loading until this is turned back on.',
        stats: () => {
            const p = require('./adminStats').portfolio();
            return { records: p.entryCount, label: p.entryCount === 1 ? 'entry' : 'entries', lastChange: p.updatedAt };
        },
    },
    places: {
        title: 'Places',
        sensitivity: 'private',   // rule values include the home address
        storage: 'db',
        defaultEnabled: true,
        stats: (db) => require('./places').stats(db),
    },
    flights: {
        title: 'Flights',
        sensitivity: 'private',   // booking references, where and when Atit travels
        storage: 'db',
        defaultEnabled: true,
        stats: (db) => require('./flights').overview(db),
    },
};

const names = () => Object.keys(REGISTRY);
const exists = (name) => Object.prototype.hasOwnProperty.call(REGISTRY, name);

// Adds a row for every declared domain that has none. Existing choices are never touched.
function sync(db) {
    const insert = db.prepare('INSERT OR IGNORE INTO hub_domains (name, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    for (const name of names()) insert.run(name, REGISTRY[name].defaultEnabled ? 1 : 0, now, 'default');
}

// If the database cannot be read the declared default applies, so a database problem alone never takes
// the public portfolio down.
function isEnabled(db, name) {
    if (!exists(name)) return false;
    try {
        const row = db.prepare('SELECT enabled FROM hub_domains WHERE name = ?').get(name);
        return row ? row.enabled === 1 : REGISTRY[name].defaultEnabled;
    } catch (err) {
        return REGISTRY[name].defaultEnabled;
    }
}

function setEnabled(db, name, enabled, actor) {
    if (!exists(name)) throw new Error(`Unknown domain "${name}"`);
    db.prepare(`INSERT INTO hub_domains (name, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
                ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(name, enabled ? 1 : 0, new Date().toISOString(), actor || null);
}

// How agents may reach the domain through /hub/mcp: off, read or write (see migration 004).
const MCP_MODES = ['off', 'read', 'write'];
const DEFAULT_MCP_MODE = 'read';

function mcpMode(db, name) {
    if (!exists(name)) return 'off';
    try {
        const row = db.prepare('SELECT mcp_mode FROM hub_domains WHERE name = ?').get(name);
        return row && MCP_MODES.includes(row.mcp_mode) ? row.mcp_mode : DEFAULT_MCP_MODE;
    } catch (err) {
        return DEFAULT_MCP_MODE;
    }
}

function setMcpMode(db, name, mode, actor) {
    if (!exists(name)) throw new Error(`Unknown domain "${name}"`);
    if (!MCP_MODES.includes(mode)) throw new Error(`MCP mode must be one of: ${MCP_MODES.join(', ')}`);
    const def = REGISTRY[name];
    db.prepare(`INSERT INTO hub_domains (name, enabled, mcp_mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (name) DO UPDATE SET mcp_mode = excluded.mcp_mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(name, def.defaultEnabled ? 1 : 0, mode, new Date().toISOString(), actor || null);
}

function list(db) {
    return names().map((name) => {
        const def = REGISTRY[name];
        const row = db.prepare('SELECT enabled, mcp_mode, updated_at, updated_by FROM hub_domains WHERE name = ?').get(name);
        let stats = {};
        try { stats = def.stats(db) || {}; } catch (err) { stats = { error: err.message }; }
        return {
            name,
            title: def.title,
            sensitivity: def.sensitivity,
            storage: def.storage,
            enabled: row ? row.enabled === 1 : def.defaultEnabled,
            changedAt: row ? row.updated_at : null,
            changedBy: row ? row.updated_by : null,
            confirmOff: def.confirmOff || null,
            mcpMode: row && MCP_MODES.includes(row.mcp_mode) ? row.mcp_mode : DEFAULT_MCP_MODE,
            records: stats.records == null ? null : stats.records,
            recordLabel: stats.label || 'records',
            lastChange: stats.lastChange || null,
        };
    });
}

module.exports = { REGISTRY, names, exists, sync, isEnabled, setEnabled, list, MCP_MODES, mcpMode, setMcpMode };
