// Read-only facts the dashboard shows: service state, backups and an inventory of the portfolio content.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const apiKeys = require('./apiKeys');
const domains = require('./domains');
const agents = require('./mcp/agents');
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
    };
}

module.exports = { overview, backups, portfolio, digestWatch };
