// Daily snapshot of the hub database, run by the service itself (no host cron). SQLite's online backup
// copies a consistent image while the server keeps running. The newest KEEP snapshots are kept, in
// <data dir>/backups.
const fs = require('fs');
const path = require('path');
const db = require('../db');

const KEEP = 7;
const FILE_RE = /^hub-\d{4}-\d{2}-\d{2}\.db$/;

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, in the container's timezone

function prune(dir, keep) {
    const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
        fs.unlinkSync(path.join(dir, f));
    }
}

// Writes today's snapshot unless it already exists (force replaces it). Resolves to the new file's path, or null if skipped.
async function runOnce(conn = db.get(), { keep = KEEP, force = false } = {}) {
    if (conn.memory) return null;
    const dir = path.join(path.dirname(conn.name), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `hub-${today()}.db`);
    if (!force && fs.existsSync(dest)) return null;
    const tmp = `${dest}.tmp`;
    await conn.backup(tmp);
    fs.renameSync(tmp, dest);
    prune(dir, keep);
    return dest;
}

// A one-off copy taken just before a permanent delete: hub-pre-delete-<timestamp>.db next to the daily ones. The daily
// pruning never touches these; the newest KEEP_PRE_DELETE are kept. Resolves to the file name; rejects if the copy fails.
const PRE_DELETE_RE = /^hub-pre-delete-(\d{8}-\d{6})(?:-(\d+))?\.db$/;
// oldest first: by time stamp, then by the collision number (plain names have none)
const byAge = (a, b) => {
    const [, sa, na = '1'] = PRE_DELETE_RE.exec(a);
    const [, sb, nb = '1'] = PRE_DELETE_RE.exec(b);
    return sa === sb ? Number(na) - Number(nb) : (sa < sb ? -1 : 1);
};
const KEEP_PRE_DELETE = 20;

async function snapshotBeforeDelete(conn = db.get(), { keep = KEEP_PRE_DELETE, at = new Date() } = {}) {
    if (conn.memory) return null;
    const dir = path.join(path.dirname(conn.name), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
    let name = `hub-pre-delete-${stamp}.db`;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `hub-pre-delete-${stamp}-${n}.db`;
    const dest = path.join(dir, name);
    const tmp = `${dest}.tmp`;
    try {
        await conn.backup(tmp);
        fs.renameSync(tmp, dest);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean */ }
        throw err;
    }
    const old = fs.readdirSync(dir).filter((f) => PRE_DELETE_RE.test(f)).sort(byAge);
    for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(dir, f));
    return name;
}

// Checks shortly after boot and then hourly, so a restart never skips a day and never makes a second copy.
function start() {
    const tick = () => runOnce().catch((err) => console.error('Hub backup failed:', err.message));
    setTimeout(tick, 30 * 1000).unref();
    setInterval(tick, 60 * 60 * 1000).unref();
}

module.exports = { runOnce, snapshotBeforeDelete, start, prune, PRE_DELETE_RE };
