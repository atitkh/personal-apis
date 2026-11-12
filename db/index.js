// The hub's own SQLite database. One file, owned by this process only: other services reach the data
// through the API, never by opening the file. WAL mode, plain SQL migrations applied in filename order.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_FILE = path.join(process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data'), 'hub.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let shared = null;

// Migration files not applied yet. null when the database has no migration table at all (a brand-new file).
function pendingMigrations(db) {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!has) return null;
    const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort().filter((f) => !applied.has(f));
}

function migrate(db) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        db.transaction(() => {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
        })();
    }
}

function open(file = process.env.HUB_DB_FILE || DEFAULT_FILE) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = file !== ':memory:' && fs.existsSync(file) && fs.statSync(file).size > 0;
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    // A copy of the database as it is, before any pending migration changes it (existing database files only).
    const pending = existed ? pendingMigrations(db) : null;
    const pre = pending && pending.length
        ? require('../services/backup').snapshotBeforeMigration(db, file, { existed, pending: pending.length })
        : null;
    migrate(db);
    if (pre && pre.error) require('../services/backup').recordFailure(db, pre.error, 'migration');
    require('./seed').run(db);
    require('../services/domains').sync(db);
    return db;
}

// The process-wide handle, opened on first use.
function get() {
    if (!shared) shared = open();
    return shared;
}

function close() {
    if (shared) {
        shared.close();
        shared = null;
    }
}

// Cheap liveness probe for /health. Never throws.
function health() {
    try {
        const db = get();
        db.prepare('SELECT 1').get();
        const migrations = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name NOT LIKE \'seed:%\'').get().n;
        return { status: 'healthy', migrations };
    } catch (err) {
        return { status: 'unhealthy', error: err.message };
    }
}

module.exports = { open, get, close, health, migrate, pendingMigrations };
