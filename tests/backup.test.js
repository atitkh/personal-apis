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
