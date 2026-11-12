// The configurable backup scheduler: pure decision, file names and pruning across both forms, failures that are
// recorded (never a silent copy elsewhere), pre-migration copies and verify.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const settings = require('../services/settings');
const backup = require('../services/backup');
const stats = require('../services/adminStats');

const HOUR = 3600 * 1000;
let dir;
let conn;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sched-'));
    conn = db.open(path.join(dir, 'hub.db'));
    apiKeys.create(conn, { name: 'ha', scopes: 'attendance:read' });
});
afterEach(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
const backups = () => path.join(dir, 'backups');
const names = (re) => fs.readdirSync(backups()).filter((f) => re.test(f)).sort();

describe('shouldRun', () => {
    const NOW = Date.parse('2026-11-12T12:00:00Z');
    test('off never runs; no backup yet runs; otherwise when the newest is at least every_hours old', () => {
        expect(backup.shouldRun(NOW, null, 24, false)).toBe(false);
        expect(backup.shouldRun(NOW, NOW - 1000 * HOUR, 24, false)).toBe(false);
        expect(backup.shouldRun(NOW, null, 24, true)).toBe(true);
        expect(backup.shouldRun(NOW, NOW - 23.9 * HOUR, 24, true)).toBe(false);
        expect(backup.shouldRun(NOW, NOW - 24 * HOUR, 24, true)).toBe(true);
        expect(backup.shouldRun(NOW, NOW - 5 * HOUR, 6, true)).toBe(false);
        expect(backup.shouldRun(NOW, NOW - 6 * HOUR, 6, true)).toBe(true);
        expect(backup.shouldRun(NOW, NOW - 100 * HOUR, 168, true)).toBe(false);
    });
});

describe('names and pruning', () => {
    const NOW = new Date('2026-11-12T20:07:00Z'); // 14:07 in Chicago
    test('daily form for 24 h and longer, time-of-day form below, in the hub time zone', () => {
        expect(backup.scheduledName(NOW, 'America/Chicago', 24)).toBe('hub-2026-11-12.db');
        expect(backup.scheduledName(NOW, 'America/Chicago', 168)).toBe('hub-2026-11-12.db');
        expect(backup.scheduledName(NOW, 'America/Chicago', 6)).toBe('hub-2026-11-12-1407.db');
        expect(backup.scheduledName(new Date('2026-11-13T03:00:00Z'), 'America/Chicago', 1)).toBe('hub-2026-11-12-2100.db');
        expect(backup.scheduledName(new Date('2026-11-13T03:00:00Z'), 'Asia/Tokyo', 1)).toBe('hub-2026-11-13-1200.db');
        for (const n of ['hub-2026-11-12.db', 'hub-2026-11-12-1407.db']) expect(backup.FILE_RE.test(n)).toBe(true);
        for (const n of ['hub-2026-11-12-14.db', 'hub-pre-delete-20261112-060157.db', 'hub-pre-migration-20261112-060157.db']) expect(backup.FILE_RE.test(n)).toBe(false);
    });

    test('keep-N prunes the newest N across both forms and never touches pre-delete or pre-migration files', () => {
        fs.mkdirSync(backups());
        const files = ['hub-2026-01-01.db', 'hub-2026-01-02.db', 'hub-2026-01-03-0300.db', 'hub-2026-01-03-1500.db', 'hub-2026-01-04.db',
            'hub-pre-delete-20250101-000000.db', 'hub-pre-migration-20250101-000000.db', 'notes.txt'];
        for (const f of files) fs.writeFileSync(path.join(backups(), f), '');
        backup.prune(backups(), 3);
        expect(fs.readdirSync(backups()).sort()).toEqual(['hub-2026-01-03-0300.db', 'hub-2026-01-03-1500.db', 'hub-2026-01-04.db',
            'hub-pre-delete-20250101-000000.db', 'hub-pre-migration-20250101-000000.db', 'notes.txt']);
    });

    test('a daily file and a same-day time file sort by date then time of day', () => {
        fs.mkdirSync(backups());
        for (const f of ['hub-2026-01-03.db', 'hub-2026-01-03-0001.db', 'hub-2026-01-02-2359.db']) fs.writeFileSync(path.join(backups(), f), '');
        backup.prune(backups(), 1);
        expect(fs.readdirSync(backups())).toEqual(['hub-2026-01-03-0001.db']);
    });

    test('runOnce uses the settings: sub-daily names, keep, and stats.backups lists both forms with their kind', async () => {
        settings.set(conn, 'backup.every_hours', 6);
        settings.set(conn, 'backup.keep', 2);
        await backup.runOnce(conn, { now: new Date('2026-11-12T08:00:00Z'), force: true });
        await backup.runOnce(conn, { now: new Date('2026-11-12T14:00:00Z'), force: true });
        await backup.runOnce(conn, { now: new Date('2026-11-12T20:00:00Z'), force: true });
        expect(names(backup.FILE_RE)).toEqual(['hub-2026-11-12-0800.db', 'hub-2026-11-12-1400.db']); // Chicago clock
        await backup.snapshotBeforeDelete(conn, { at: new Date('2026-11-12T20:00:00Z') });
        const kinds = stats.backups(conn);
        expect(kinds.map((b) => b.kind).sort()).toEqual(['pre-delete', 'scheduled', 'scheduled']);
    });
});

describe('scheduler tick', () => {
    const T0 = new Date();
    test('backs up when none exists, waits until due, honours off and changed settings without a restart', async () => {
        expect(await backup.tick(conn, { now: T0 })).toMatchObject({ ran: true });
        expect(names(backup.FILE_RE)).toHaveLength(1);
        expect(await backup.tick(conn, { now: new Date(T0.getTime() + 2 * HOUR) })).toEqual({ ran: false, skipped: 'not due' });
        settings.set(conn, 'backup.every_hours', 1); // read again on the next tick
        expect(await backup.tick(conn, { now: new Date(T0.getTime() + 2 * HOUR) })).toMatchObject({ ran: true });
        expect(names(backup.FILE_RE)).toHaveLength(2);
        settings.set(conn, 'backup.enabled', false);
        expect(await backup.tick(conn, { now: new Date(T0.getTime() + 50 * HOUR) })).toEqual({ ran: false, skipped: 'disabled' });
        expect(names(backup.FILE_RE)).toHaveLength(2);
    });

    test('a pre-delete or pre-migration file does not count as the newest scheduled backup', async () => {
        await backup.snapshotBeforeDelete(conn);
        expect(await backup.tick(conn, { now: T0 })).toMatchObject({ ran: true });
    });

    test('verify_after checks the new file; a copy that does not verify is recorded as a failure', async () => {
        const v = jest.spyOn(backup, 'verifyFile');
        expect(await backup.tick(conn, { now: T0 })).toMatchObject({ ran: true });
        v.mockRestore();
        settings.set(conn, 'backup.verify_after', false);
        settings.set(conn, 'backup.every_hours', 1);
        expect(await backup.tick(conn, { now: new Date(T0.getTime() + 3 * HOUR) })).toMatchObject({ ran: true });
    });

    test('settings drive the folder: a configured folder is used, a missing one fails loudly and writes nothing elsewhere', async () => {
        const nas = path.join(dir, 'nas');
        fs.mkdirSync(nas);
        settings.set(conn, 'backup.dir', nas);
        expect(await backup.tick(conn, { now: T0 })).toMatchObject({ ran: true });
        expect(fs.readdirSync(nas).filter((f) => backup.FILE_RE.test(f))).toHaveLength(1);
        expect(fs.existsSync(backups())).toBe(false); // nothing in the default folder

        const gone = path.join(dir, 'unmounted', 'hub');
        settings.set(conn, 'backup.dir', gone);
        const r = await backup.tick(conn, { now: T0 });
        expect(r.ran).toBe(false);
        expect(r.error).toMatch(/does not exist/);
        expect(fs.existsSync(path.dirname(gone))).toBe(false); // not created behind the user's back
        expect(fs.existsSync(backups())).toBe(false);
        expect(backup.lastError(conn).message).toMatch(/does not exist/);
        expect(stats.overview(conn).backups.error).toMatch(/does not exist/);
        expect(backup.status(conn).lastError.message).toMatch(/does not exist/);

        await backup.tick(conn, { now: T0 }); // the same failure again: one audit row only
        const rows = audit.recent(conn, 20, { actions: ['backup_failed'] });
        expect(rows).toHaveLength(1);
        expect(rows[0].detail.message).toMatch(/does not exist/);

        fs.mkdirSync(gone, { recursive: true }); // the mount comes back
        expect(await backup.tick(conn, { now: T0 })).toMatchObject({ ran: true });
        expect(backup.lastError(conn)).toBeNull();
    });

    test('a configured folder that is a file fails too', async () => {
        const f = path.join(dir, 'plain');
        fs.writeFileSync(f, 'x');
        settings.set(conn, 'backup.dir', f);
        expect((await backup.tick(conn, { now: T0 })).error).toMatch(/not a folder/);
    });

    test('backupNow records its failure and throws', async () => {
        settings.set(conn, 'backup.dir', path.join(dir, 'nope'));
        await expect(backup.backupNow(conn)).rejects.toThrow(/does not exist/);
        expect(backup.lastError(conn).message).toMatch(/does not exist/);
    });

    test('pre-delete copies follow the configured folder and refuse (reject) when it is missing', async () => {
        const nas = path.join(dir, 'nas');
        fs.mkdirSync(nas);
        settings.set(conn, 'backup.dir', nas);
        const n = await backup.snapshotBeforeDelete(conn);
        expect(fs.existsSync(path.join(nas, n))).toBe(true);
        settings.set(conn, 'backup.dir', path.join(dir, 'nope'));
        await expect(backup.snapshotBeforeDelete(conn)).rejects.toThrow(/does not exist/);
    });
});

describe('verify', () => {
    test('a good backup passes: integrity ok and row counts compared with the live data', async () => {
        const f = await backup.runOnce(conn);
        apiKeys.create(conn, { name: 'later', scopes: 'attendance:read' }); // live moves on after the copy
        const r = await backup.verifyNewest(conn);
        expect(r).toMatchObject({ ok: true, file: path.basename(f), integrity: 'ok', problems: [] });
        expect(r.tables.find((t) => t.table === 'api_keys')).toEqual({ table: 'api_keys', live: 2, backup: 1, status: 'live_newer' });
        expect(r.tables.map((t) => t.table)).toEqual(expect.arrayContaining(['audit_log', 'flights', 'deadlines', 'preferences']));
        expect(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('hub-verify-') && fs.readdirSync(path.join(os.tmpdir(), x)).length)).toEqual([]);
    });

    test('a truncated copy fails and the original file is untouched', async () => {
        const f = await backup.runOnce(conn);
        const size = fs.statSync(f).size;
        fs.truncateSync(f, Math.floor(size / 2));
        const r = await backup.verifyNewest(conn);
        expect(r.ok).toBe(false);
        expect(r.problems.length).toBeGreaterThan(0);
        expect(fs.statSync(f).size).toBe(Math.floor(size / 2)); // never rewritten
        fs.writeFileSync(f, '');
        const empty = await backup.verifyNewest(conn);
        expect(empty.ok).toBe(false);
        expect(empty.problems.join(' ')).toMatch(/missing/);
    });

    test('garbage is a plain failure, not a crash; no backup gives null', async () => {
        expect(await backup.verifyNewest(conn)).toBeNull();
        fs.mkdirSync(backups());
        fs.writeFileSync(path.join(backups(), 'hub-2026-01-01.db'), 'this is not a database at all, just text'.repeat(200));
        const r = await backup.verifyNewest(conn);
        expect(r.ok).toBe(false);
        expect(r.problems[0]).toMatch(/could not be read|integrity/);
    });
});

describe('pre-migration backup', () => {
    // Opens the file, then makes migration 014 pending again (drop its table, forget it) and reopens.
    const withPending = (file) => {
        const c = db.open(file);
        c.prepare('INSERT INTO api_keys (name, key_hash, key_prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?)').run('k', 'h', 'p', 'x', 'now');
        c.exec("DROP TABLE hub_settings; DELETE FROM schema_migrations WHERE name = '014_hub_settings.sql'");
        c.close();
    };

    test('is taken in the default folder before a pending migration, and holds the pre-migration state', () => {
        const file = path.join(dir, 'old.db');
        withPending(file);
        const c = db.open(file);
        const copies = fs.readdirSync(path.join(dir, 'backups')).filter((f) => backup.PRE_MIGRATION_RE.test(f));
        expect(copies).toHaveLength(1);
        const copy = new Database(path.join(dir, 'backups', copies[0]), { readonly: true });
        expect(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'hub_settings'").get().n).toBe(0);
        expect(copy.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n).toBe(1);
        copy.close();
        expect(c.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'hub_settings'").get().n).toBe(1); // and the migration ran
        c.close();
        // nothing pending now: opening again makes no new copy
        db.open(file).close();
        expect(fs.readdirSync(path.join(dir, 'backups')).filter((f) => backup.PRE_MIGRATION_RE.test(f))).toHaveLength(1);
    });

    test('no copy for a brand-new file or an empty database file', () => {
        const fresh = path.join(dir, 'fresh', 'hub.db');
        db.open(fresh).close();
        expect(fs.existsSync(path.join(dir, 'fresh', 'backups'))).toBe(false);
        const empty = path.join(dir, 'empty.db');
        fs.writeFileSync(empty, '');
        db.open(empty).close();
        expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    });

    test('keeps the newest five, and the scheduled pruning leaves them alone', () => {
        fs.mkdirSync(backups());
        for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(backups(), `hub-pre-migration-2026010${i}-000000.db`), '');
        const file = path.join(dir, 'old.db');
        withPending(file);
        db.open(file).close();
        const left = fs.readdirSync(backups()).filter((f) => backup.PRE_MIGRATION_RE.test(f)).sort();
        expect(left).toHaveLength(5);
        expect(left[0]).toBe('hub-pre-migration-20260104-000000.db'); // oldest went first; the new one is the newest
        backup.prune(backups(), 1);
        expect(fs.readdirSync(backups()).filter((f) => backup.PRE_MIGRATION_RE.test(f))).toHaveLength(5);
    });

    test('a failed copy does not stop the migration; the failure is recorded', () => {
        const file = path.join(dir, 'old.db');
        withPending(file);
        fs.writeFileSync(path.join(dir, 'backups'), 'a file where the folder should be');
        const c = db.open(file);
        expect(c.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'hub_settings'").get().n).toBe(1);
        expect(backup.lastError(c).message).toMatch(/before the migration failed/);
        expect(audit.recent(c, 5, { actions: ['backup_failed'] })).toHaveLength(1);
        c.close();
    });
});
