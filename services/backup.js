// Snapshots of the hub database, taken by the service itself (no host cron). SQLite's online backup copies a
// consistent image while the server keeps running. Location, frequency and keep-N come from the hub settings
// (services/settings.js), read again on every scheduler tick, so a change applies without a restart.
//
// Files in the backup folder:
//   hub-YYYY-MM-DD.db            scheduled/manual, when the schedule is a day or longer
//   hub-YYYY-MM-DD-HHmm.db       scheduled/manual, when the schedule is shorter than a day (hub time zone clock)
//   hub-pre-delete-<stamp>.db    taken before a permanent delete; newest KEEP_PRE_DELETE kept
//   hub-pre-migration-<stamp>.db taken before a pending migration is applied; newest KEEP_PRE_MIGRATION kept
// keep-N pruning only ever touches the first two forms.
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const settings = require('./settings');
const audit = require('./audit');
const { hubTz, stampIn } = require('./lib/tz');

const KEEP = 7;
const FILE_RE = /^hub-(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?\.db$/;
const PRE_DELETE_RE = /^hub-pre-delete-(\d{8}-\d{6})(?:-(\d+))?\.db$/;
const PRE_MIGRATION_RE = /^hub-pre-migration-(\d{8}-\d{6})(?:-(\d+))?\.db$/;
const KEEP_PRE_DELETE = 20;
const KEEP_PRE_MIGRATION = 5;
const TICK_MS = 5 * 60 * 1000;

const kindOf = (name) => (FILE_RE.test(name) ? 'scheduled' : PRE_DELETE_RE.test(name) ? 'pre-delete' : PRE_MIGRATION_RE.test(name) ? 'pre-migration' : null);
const isBackupName = (name) => kindOf(name) !== null;

// oldest-first order of scheduled names: date, then time of day (the daily form counts as 0000)
const scheduledKey = (name) => { const m = FILE_RE.exec(name); return `${m[1]}-${m[2] || '0000'}`; };
const scheduledOrder = (a, b) => (scheduledKey(a) < scheduledKey(b) ? -1 : scheduledKey(a) > scheduledKey(b) ? 1 : (a < b ? -1 : 1));

// oldest-first order of stamped names: by stamp, then by the collision number (plain names have none)
const stampedOrder = (re) => (a, b) => {
    const [, sa, na = '1'] = re.exec(a);
    const [, sb, nb = '1'] = re.exec(b);
    return sa === sb ? Number(na) - Number(nb) : (sa < sb ? -1 : 1);
};

const listNames = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)); } catch (e) { return []; } };

// Keeps the newest `keep` scheduled files (both name forms together).
function prune(dir, keep) {
    const files = listNames(dir, FILE_RE).sort(scheduledOrder);
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
}

/* ---------- settings in effect ---------- */

// The backup settings as the scheduler and the buttons use them. Never throws (a db without the settings table, or
// an in-memory one, gets the defaults).
function config(conn) {
    let c;
    try {
        c = {
            enabled: settings.get(conn, 'backup.enabled'),
            dir: settings.get(conn, 'backup.dir'),
            everyHours: settings.get(conn, 'backup.every_hours'),
            keep: settings.get(conn, 'backup.keep'),
            verifyAfter: settings.get(conn, 'backup.verify_after'),
            tz: hubTz(conn),
        };
        c.dirIsDefault = isDefaultDir(conn, c.dir);
    } catch (e) {
        c = { enabled: true, dir: settings.defaultBackupDir(conn), everyHours: 24, keep: KEEP, verifyAfter: true, tz: hubTz(null), dirIsDefault: true };
    }
    return c;
}
const isDefaultDir = (conn, dir) => dir === settings.defaultBackupDir(conn);

// The scheduler's decision, pure: run when backups are on and the newest scheduled one is at least everyHours old
// (or there is none). newestMtime: ms since epoch or null.
function shouldRun(now, newestMtime, everyHours, enabled) {
    if (!enabled) return false;
    if (newestMtime == null) return true;
    return now - newestMtime >= everyHours * 3600 * 1000;
}

// Scheduled name for `at`: the daily form for a schedule of a day or longer, else with the time of day.
function scheduledName(at, tz, everyHours) {
    const s = stampIn(tz, at);
    return everyHours >= 24 ? `hub-${s.date}.db` : `hub-${s.date}-${s.hm}.db`;
}

// Where backups go for this connection: the configured folder. The default folder is created on demand; a configured
// one must already exist, so an unmounted volume is an error instead of a silent copy inside the container.
function backupDir(conn, cfg = config(conn)) {
    const dir = cfg.dir;
    if (!dir) return null;
    if (cfg.dirIsDefault) { fs.mkdirSync(dir, { recursive: true }); return dir; }
    let st;
    try { st = fs.statSync(dir); } catch (e) { throw new Error(`The backup folder ${dir} does not exist (is its volume mounted?).`); }
    if (!st.isDirectory()) throw new Error(`The backup folder ${dir} is not a folder.`);
    return dir;
}

function newestScheduledMtime(dir) {
    let newest = null;
    for (const f of listNames(dir, FILE_RE)) {
        try { const t = fs.statSync(path.join(dir, f)).mtimeMs; if (newest == null || t > newest) newest = t; } catch (e) { /* vanished */ }
    }
    return newest;
}

async function writeCopy(conn, dest) {
    const tmp = `${dest}.tmp`;
    try {
        await conn.backup(tmp);
        fs.renameSync(tmp, dest);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean */ }
        throw err;
    }
}

// Writes a scheduled-form snapshot unless it already exists (force replaces it). Resolves to the new file's path, or
// null if skipped. `keep`, `now` and `dir` override the settings (tests).
async function runOnce(conn = db.get(), { keep, force = false, now = new Date(), dir } = {}) {
    if (conn.memory) return null;
    const cfg = config(conn);
    const target = dir || backupDir(conn, cfg);
    const dest = path.join(target, scheduledName(now, cfg.tz, cfg.everyHours));
    if (!force && fs.existsSync(dest)) return null;
    await writeCopy(conn, dest);
    prune(target, keep == null ? cfg.keep : keep);
    return dest;
}

/* ---------- failures ---------- */

// Remembers why backups are failing (last_backup_error) and writes one audit row per new message, so a failing
// folder does not fill the log every five minutes. A later success clears it.
function recordFailure(conn, message, where) {
    const msg = String(message).slice(0, 300);
    let was = null;
    try { was = settings.getInternal(conn, 'last_backup_error'); } catch (e) { return; }
    let prev = null;
    try { prev = was ? JSON.parse(was).message : null; } catch (e) { /* old format */ }
    settings.setInternal(conn, 'last_backup_error', JSON.stringify({ at: new Date().toISOString(), message: msg }));
    if (prev !== msg) audit.record(conn, 'system', 'backup_failed', { message: msg, ...(where ? { where } : {}) });
    return msg;
}
function clearFailure(conn) {
    try { settings.setInternal(conn, 'last_backup_error', null); } catch (e) { /* settings table missing */ }
}
function lastError(conn) {
    try {
        const raw = settings.getInternal(conn, 'last_backup_error');
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

/* ---------- the scheduler ---------- */

// One scheduler step: reads the settings, decides, backs up (and verifies) when due. Never throws; resolves to
// { ran, file?, error?, skipped? }.
async function tick(conn = db.get(), { now = new Date() } = {}) {
    if (conn.memory) return { ran: false, skipped: 'memory' };
    const cfg = config(conn);
    if (!cfg.enabled) return { ran: false, skipped: 'disabled' };
    try {
        const dir = backupDir(conn, cfg);
        if (!shouldRun(now.getTime(), newestScheduledMtime(dir), cfg.everyHours, cfg.enabled)) return { ran: false, skipped: 'not due' };
        const file = await runOnce(conn, { force: true, now, dir });
        if (cfg.verifyAfter) {
            const report = await verifyFile(conn, file);
            if (!report.ok) throw new Error(`The new backup ${path.basename(file)} did not verify: ${report.problems.join('; ')}`);
        }
        clearFailure(conn);
        return { ran: true, file };
    } catch (err) {
        recordFailure(conn, err.message, 'scheduled');
        console.error('Hub backup failed:', err.message);
        return { ran: false, error: err.message };
    }
}

// Wakes shortly after boot and then every five minutes; each wake reads the settings again.
function start() {
    const run = () => tick().catch((err) => console.error('Hub backup tick failed:', err.message));
    setTimeout(run, 30 * 1000).unref();
    setInterval(run, TICK_MS).unref();
}

// "Back up now": a scheduled-form copy in the configured folder, replacing one of the same name. A failure is recorded
// like a scheduled one and thrown to the caller.
async function backupNow(conn = db.get(), { now = new Date() } = {}) {
    try {
        const file = await runOnce(conn, { force: true, now });
        clearFailure(conn);
        return file;
    } catch (err) {
        recordFailure(conn, err.message, 'manual');
        throw err;
    }
}

/* ---------- one-off copies: before a delete, before a migration ---------- */

async function stamped(conn, kind, re, keep, at, dirOverride) {
    if (conn.memory) return null;
    const dir = dirOverride || backupDir(conn);
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
    let name = `hub-${kind}-${stamp}.db`;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `hub-${kind}-${stamp}-${n}.db`;
    await writeCopy(conn, path.join(dir, name));
    const old = listNames(dir, re).sort(stampedOrder(re));
    for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(dir, f));
    return name;
}

// hub-pre-delete-<timestamp>.db next to the scheduled ones. Resolves to the file name; rejects if the copy fails.
const snapshotBeforeDelete = (conn = db.get(), { keep = KEEP_PRE_DELETE, at = new Date() } = {}) =>
    stamped(conn, 'pre-delete', PRE_DELETE_RE, keep, at);

// Before pending migrations are applied (called by db.open before migrate). Synchronous (VACUUM INTO) because open is.
// `file` is the database file; `existed` whether it was there before this open. Returns { file } | { error } | null (nothing to do).
function snapshotBeforeMigration(conn, file, { existed, pending, at = new Date(), keep = KEEP_PRE_MIGRATION } = {}) {
    if (!existed || !pending || file === ':memory:') return null;
    try {
        const cfg = config(conn);
        const dir = backupDir(conn, { ...cfg, dir: cfg.dir || path.join(path.dirname(file), 'backups'), dirIsDefault: cfg.dirIsDefault });
        const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
        let name = `hub-pre-migration-${stamp}.db`;
        for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `hub-pre-migration-${stamp}-${n}.db`;
        const dest = path.join(dir, name);
        try { conn.prepare('VACUUM INTO ?').run(`${dest}.tmp`); fs.renameSync(`${dest}.tmp`, dest); } catch (e) { try { fs.unlinkSync(`${dest}.tmp`); } catch (e2) { /* clean */ } throw e; }
        const old = listNames(dir, PRE_MIGRATION_RE).sort(stampedOrder(PRE_MIGRATION_RE));
        for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(dir, f));
        return { file: dest };
    } catch (err) {
        return { error: `The backup before the migration failed: ${err.message}` };
    }
}

/* ---------- listing ---------- */

// Every backup file in the configured folder, newest first, with its kind.
function list(conn = db.get()) {
    if (conn.memory) return [];
    let dir;
    try { dir = config(conn).dir; } catch (e) { return []; }
    if (!dir) return [];
    const out = [];
    for (const name of listNames(dir, { test: isBackupName })) {
        try {
            const st = fs.statSync(path.join(dir, name));
            out.push({ name, kind: kindOf(name), bytes: st.size, modifiedAt: st.mtime.toISOString() });
        } catch (e) { /* vanished */ }
    }
    return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : (a.name < b.name ? 1 : -1)));
}

function freeBytes(dir) {
    try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (e) { return null; }
}

// What the Backups page shows about the schedule.
function status(conn = db.get()) {
    const cfg = config(conn);
    const files = list(conn);
    const scheduled = files.filter((f) => f.kind === 'scheduled');
    return {
        enabled: cfg.enabled,
        dir: cfg.dir,
        dirIsDefault: cfg.dirIsDefault,
        everyHours: cfg.everyHours,
        keep: cfg.keep,
        verifyAfter: cfg.verifyAfter,
        schedule: cfg.enabled ? `every ${cfg.everyHours} h, keep ${cfg.keep}` : 'off',
        newest: scheduled[0] || null,
        freeBytes: cfg.dir ? freeBytes(cfg.dir) : null,
        lastError: lastError(conn),
    };
}

/* ---------- the folder check ---------- */

// Never test, create or write in these (and anything below them), however the path is spelled or linked.
const FORBIDDEN = ['/proc', '/sys', '/dev', '/etc', '/boot', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/usr', '/run', '/root', '/var/run'];
const under = (p, root) => p === root || p.startsWith(`${root}/`);

class DirError extends Error {
    constructor(message) { super(message); this.status = 400; }
}

// The real path of `p`, following links as far as it exists.
function realish(p) {
    let cur = p;
    const rest = [];
    for (;;) {
        try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch (e) {
            const parent = path.dirname(cur);
            if (parent === cur) return p;
            rest.push(path.basename(cur));
            cur = parent;
        }
    }
}

// The resolved path of a folder that may be used, or a DirError (status 400): not text, not absolute, or in a system area.
function allowedDir(input) {
    if (typeof input !== 'string' || !input.trim()) throw new DirError('Enter a folder path.');
    const raw = input.trim();
    if (raw.includes('\0') || raw.length > 500) throw new DirError('That is not a usable path.');
    if (!path.isAbsolute(raw)) throw new DirError('The path must be absolute (it starts with /).');
    const resolved = path.resolve(raw);
    if (resolved === '/') throw new DirError('The root folder cannot be the backup folder.');
    for (const root of FORBIDDEN) {
        if (under(resolved, root) || under(realish(resolved), root)) throw new DirError(`${root} is a system folder; backups cannot go there.`);
    }
    return resolved;
}

// Writes and deletes a temp file in `input` (created if missing). Resolves { ok, writable, free_bytes, resolved, created }
// or throws DirError (status 400) for a path that must not be used (see allowedDir).
function checkDir(input) {
    const resolved = allowedDir(input);
    const out = { ok: false, writable: false, free_bytes: null, resolved, created: false };
    try {
        if (!fs.existsSync(resolved)) { fs.mkdirSync(resolved, { recursive: true }); out.created = true; }
        if (!fs.statSync(resolved).isDirectory()) throw new DirError(`${resolved} exists but is not a folder.`);
        const probe = path.join(resolved, `.hub-write-test-${process.pid}-${Date.now()}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        out.writable = true;
        out.ok = true;
        out.free_bytes = freeBytes(resolved);
    } catch (err) {
        if (err instanceof DirError) throw err;
        out.error = `Could not write in ${resolved}: ${err.code || err.message}`;
    }
    return out;
}

/* ---------- verify ---------- */

const MAIN_TABLES = ['api_keys', 'audit_log', 'digests', 'places', 'flights', 'trips', 'deadlines', 'preferences'];

// Opens a temp copy of `file` (the original is never touched), runs integrity_check and compares row counts of the
// main tables with the live database. Different counts are only reported (live_newer: rows added since; backup_more:
// rows deleted since); a table the copy lacks or a failed integrity check is a problem.
async function verifyFile(conn, file) {
    const Database = require('better-sqlite3');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-verify-'));
    const copy = path.join(scratch, 'copy.db');
    const report = { ok: false, file: path.basename(file), integrity: null, tables: [], problems: [] };
    let h = null;
    try {
        fs.copyFileSync(file, copy);
        h = new Database(copy, { readonly: true, fileMustExist: true });
        const rows = h.prepare('PRAGMA integrity_check').all();
        report.integrity = rows.map((r) => r.integrity_check).join('; ').slice(0, 300);
        if (report.integrity !== 'ok') report.problems.push(`integrity check says: ${report.integrity}`);
        const have = new Set(h.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        const liveTables = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        for (const t of MAIN_TABLES) {
            if (!liveTables.has(t)) continue;
            const live = conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
            if (!have.has(t)) { report.tables.push({ table: t, live, backup: null, status: 'missing' }); report.problems.push(`table ${t} is missing in the backup`); continue; }
            const bk = h.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
            const status = bk === live ? 'same' : bk < live ? 'live_newer' : 'backup_more';
            report.tables.push({ table: t, live, backup: bk, status });
        }
        report.ok = report.problems.length === 0;
    } catch (err) {
        report.problems.push(`the backup could not be read: ${err.message}`);
    } finally {
        try { if (h) h.close(); } catch (e) { /* closed */ }
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    return report;
}

// Verifies the newest scheduled backup in the configured folder. Resolves the report, or null when there is none.
async function verifyNewest(conn = db.get()) {
    const cfg = config(conn);
    if (!cfg.dir) return null;
    const names = listNames(cfg.dir, FILE_RE).sort(scheduledOrder);
    if (!names.length) return null;
    return verifyFile(conn, path.join(cfg.dir, names[names.length - 1]));
}

module.exports = {
    runOnce, backupNow, tick, start, shouldRun, scheduledName, config, status, list, lastError, recordFailure, clearFailure,
    snapshotBeforeDelete, snapshotBeforeMigration, checkDir, allowedDir, DirError, verifyFile, verifyNewest, prune,
    FILE_RE, PRE_DELETE_RE, PRE_MIGRATION_RE, isBackupName, kindOf,
};
