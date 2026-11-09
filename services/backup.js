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

// Checks shortly after boot and then hourly, so a restart never skips a day and never makes a second copy.
function start() {
    const tick = () => runOnce().catch((err) => console.error('Hub backup failed:', err.message));
    setTimeout(tick, 30 * 1000).unref();
    setInterval(tick, 60 * 60 * 1000).unref();
}

module.exports = { runOnce, start, prune };
