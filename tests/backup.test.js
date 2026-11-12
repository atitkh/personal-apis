const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const backup = require('../services/backup');

describe('daily backup', () => {
    let dir;
    let conn;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-backup-'));
        conn = db.open(path.join(dir, 'hub.db'));
    });
    afterEach(() => {
        conn.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('writes a restorable snapshot once per day', async () => {
        apiKeys.create(conn, { name: 'ha', scopes: 'attendance:read' });

        const file = await backup.runOnce(conn);
        expect(file).toMatch(/hub-\d{4}-\d{2}-\d{2}\.db$/);

        const copy = new Database(file, { readonly: true });
        expect(copy.prepare('SELECT name FROM api_keys').all()).toEqual([{ name: 'ha' }]);
        copy.close();

        expect(await backup.runOnce(conn)).toBeNull();
    });

    test('a pre-delete snapshot has its own name, is restorable, never collides, and is pruned on its own', async () => {
        apiKeys.create(conn, { name: 'ha', scopes: 'attendance:read' });
        const at = new Date('2026-11-12T06:01:57.123Z');
        const a = await backup.snapshotBeforeDelete(conn, { at });
        const b = await backup.snapshotBeforeDelete(conn, { at });
        expect(a).toBe('hub-pre-delete-20261112-060157.db');
        expect(b).toBe('hub-pre-delete-20261112-060157-2.db');
        const copy = new Database(path.join(dir, 'backups', a), { readonly: true });
        expect(copy.prepare('SELECT name FROM api_keys').all()).toEqual([{ name: 'ha' }]);
        copy.close();
        await backup.snapshotBeforeDelete(conn, { at: new Date('2026-11-13T00:00:00Z'), keep: 2 });
        const left = fs.readdirSync(path.join(dir, 'backups')).filter((f) => backup.PRE_DELETE_RE.test(f)).sort();
        expect(left).toEqual(['hub-pre-delete-20261112-060157-2.db', 'hub-pre-delete-20261113-000000.db']); // the older plain name went first
        // the daily pruning and today's snapshot are not affected by them
        expect(await backup.runOnce(conn)).toMatch(/hub-\d{4}-\d{2}-\d{2}\.db$/);
        expect(fs.readdirSync(path.join(dir, 'backups')).filter((f) => backup.PRE_DELETE_RE.test(f))).toHaveLength(2);
        expect(await backup.snapshotBeforeDelete(db.open(':memory:'))).toBeNull();
    });

    test('keeps only the newest snapshots', () => {
        const backups = path.join(dir, 'backups');
        fs.mkdirSync(backups);
        for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
            fs.writeFileSync(path.join(backups, `hub-${d}.db`), '');
        }
        fs.writeFileSync(path.join(backups, 'notes.txt'), '');

        backup.prune(backups, 2);

        expect(fs.readdirSync(backups).sort()).toEqual(['hub-2026-01-03.db', 'hub-2026-01-04.db', 'notes.txt']);
    });

    test('skips in-memory databases', async () => {
        const mem = db.open(':memory:');
        expect(await backup.runOnce(mem)).toBeNull();
        mem.close();
    });
});
