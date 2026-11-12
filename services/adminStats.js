// Read-only facts the dashboard shows: service state, backups and an inventory of the portfolio content.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const apiKeys = require('./apiKeys');
const domains = require('./domains');
const agents = require('./mcp/agents');
const places = require('./places');
const flights = require('./flights');
const { readJson } = require('../routes/portfolio/freshJson');

const ATIT_DIR = path.join(__dirname, '..', 'routes', 'portfolio', 'atit');
const BACKUP_RE = /^hub-\d{4}-\d{2}-\d{2}\.db$/;

const size = (file) => {
    try { return fs.statSync(file).size; } catch (e) { return 0; }
};

function folder(name, ext) {
    const dir = path.join(ATIT_DIR, name);
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(ext)); } catch (e) { /* folder missing */ }
    return { names, count: names.length, bytes: names.reduce((sum, f) => sum + size(path.join(dir, f)), 0) };
}

function backups() {
    const conn = db.get();
    if (conn.memory) return [];
    const dir = path.join(path.dirname(conn.name), 'backups');
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)); } catch (e) { /* none yet */ }
    return names.sort().reverse().map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, bytes: st.size, modifiedAt: st.mtime.toISOString() };
    });
}

function portfolio() {
    const file = path.join(ATIT_DIR, 'atit.json');
    const data = readJson(file);
    const entries = Array.isArray(data.portfolio) ? data.portfolio : [];
    const pages = folder('md', '.md');
    const pageIds = new Set(pages.names.map((f) => f.slice(0, -3)));
    const rows = entries.map((e) => ({
        id: e.id,
        title: e.title || '',
        category: e.mainCategory || '',
        date: e.date || '',
        hasPage: Boolean(e.more),
        pageExists: pageIds.has(String(e.id)),
    }));
    const entryIds = new Set(entries.map((e) => String(e.id)));
    const categories = {};
    for (const r of rows) categories[r.category || 'none'] = (categories[r.category || 'none'] || 0) + 1;
    const images = folder('img', '.png');
    const gifs = folder('img', '.gif');
    const pdfs = folder('pdf', '.pdf');
    return {
        updatedAt: fs.statSync(file).mtime.toISOString(),
        entryCount: rows.length,
        categories,
        missingPages: rows.filter((r) => r.hasPage && !r.pageExists).map((r) => r.id),
        orphanPages: [...pageIds].filter((id) => !entryIds.has(id)),
        files: {
            pages: { count: pages.count, bytes: pages.bytes },
            images: { count: images.count + gifs.count, bytes: images.bytes + gifs.bytes },
            pdfs: { count: pdfs.count, bytes: pdfs.bytes },
        },
        rows,
    };
}

// The nightly job runs at 11 PM Central, so from 6 AM on, yesterday's daily digest should exist. Only
// warns once the domain is on and at least one daily digest has ever arrived.
function digestWatch(conn, now = new Date()) {
    const tz = process.env.DIGEST_TZ || 'America/Chicago';

    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
    const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
    const enabled = domains.isEnabled(conn, 'digests');
    const latest = conn.prepare("SELECT MAX(period) AS p, COUNT(*) AS n FROM digests WHERE kind = 'daily'").get();
    const expected = hour >= 6 ? day(new Date(now.getTime() - 24 * 3600 * 1000)) : null;
    const have = expected && conn.prepare("SELECT 1 FROM digests WHERE kind = 'daily' AND period = ?").get(expected);
    return {
        enabled,
        coverage: digestCoverage(conn, now, tz),
        dailyCount: latest.n,
        latestDaily: latest.p || null,
        expectedDaily: expected,
        missing: Boolean(enabled && latest.n > 0 && expected && !have),
    };
}

// Which of the last `days` days (ending yesterday, today is still being lived) have a daily digest.
function digestCoverage(conn, now = new Date(), tz = 'America/Chicago', days = 30) {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const list = [];
    for (let i = days; i >= 1; i--) list.push(fmt.format(new Date(now.getTime() - i * 24 * 3600 * 1000)));
    const have = new Set(conn.prepare("SELECT period FROM digests WHERE kind = 'daily' AND period >= ? AND period <= ?")
        .all(list[0], list[list.length - 1]).map((r) => r.period));
    const out = list.map((day) => ({ day, present: have.has(day) }));
    return { days: out, present: out.filter((d) => d.present).length, total: out.length };
}

function overview() {
    const conn = db.get();
    const health = db.health();
    const keys = apiKeys.list(conn);
    const list = backups();
    const lastUsed = keys.map((k) => k.last_used_at).filter(Boolean).sort().pop() || null;
    const p = portfolio();
    const pkg = require('../package.json');
    return {
        app: {
            name: pkg.name,
            version: pkg.version,
            node: process.version,
            environment: process.env.NODE_ENV || 'development',
            uptimeSeconds: Math.round(process.uptime()),
        },
        database: {
            status: health.status,
            migrations: health.migrations || 0,
            bytes: conn.memory ? 0 : size(conn.name),
            walBytes: conn.memory ? 0 : size(`${conn.name}-wal`),
        },
        backups: { count: list.length, newest: list[0] || null },
        keys: {
            active: keys.filter((k) => !k.revoked_at).length,
            revoked: keys.filter((k) => k.revoked_at).length,
            lastUsedAt: lastUsed,
        },
        portfolio: {
            entryCount: p.entryCount,
            updatedAt: p.updatedAt,
            problems: p.missingPages.length + p.orphanPages.length,
        },
        digests: digestWatch(conn),
        agents: { calls24h: agents.callCount(conn), keysWithTools: agents.keysWithTools(conn) },
        domains: agents.domainsWithTools(conn),
        // Counts only (no streets): the overview's attention list links to the "needs a name" queue.
        places: { suggestions: places.suggestionCounts(conn) },
        // Counts only (no flight details), for the attention list's found-flights line.
        flights: { candidates: flights.candidateCounts(conn) },
    };
}

// Agent calls per local day for the last `days` days, today included, split by tool, for the activity strip.
function series(conn, { days = 14, now = new Date(), tz = process.env.DIGEST_TZ || 'America/Chicago' } = {}) {
    const n = Math.min(Math.max(Math.trunc(Number(days)) || 14, 1), 90);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const list = [];
    // Step whole calendar days from today's local date (24-hour steps repeat or skip a day around a clock change).
    const [ty, tm, td] = fmt.format(now).split('-').map(Number);
    for (let i = n - 1; i >= 0; i--) list.push(new Date(Date.UTC(ty, tm - 1, td - i)).toISOString().slice(0, 10));
    const out = new Map(list.map((day) => [day, { day, calls: 0, failed: 0, byTool: {} }]));
    // One extra day of rows covers the time zone offset; rows outside the window are dropped below.
    const since = new Date(now.getTime() - (n + 1) * 24 * 3600 * 1000).toISOString();
    const rows = conn.prepare("SELECT at, detail FROM audit_log WHERE action = 'mcp_call' AND at >= ?").all(since);
    for (const row of rows) {
        const bucket = out.get(fmt.format(new Date(row.at)));
        if (!bucket) continue;
        let detail = {};
        try { detail = JSON.parse(row.detail || '{}') || {}; } catch (e) { /* keep the count */ }
        const tool = typeof detail.tool === 'string' ? detail.tool : 'unknown';
        bucket.calls += 1;
        if (detail.ok === false) bucket.failed += 1;
        bucket.byTool[tool] = (bucket.byTool[tool] || 0) + 1;
    }
    const last = conn.prepare("SELECT MAX(at) AS at FROM audit_log WHERE action = 'mcp_call'").get();
    return { tz, days: [...out.values()], lastCallAt: last.at || null };
}

module.exports = { overview, backups, portfolio, digestWatch, series };
