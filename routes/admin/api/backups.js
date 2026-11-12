// Backups: the list, Back up now, Verify newest. The schedule and folder live in Settings (api/settings.js).
const stats = require('../../../services/adminStats');
const backup = require('../../../services/backup');

module.exports = (api, ctx) => {
    const { db, audit } = ctx;
    const view = (conn) => ({ backups: stats.backups(), status: backup.status(conn) });

    api.get('/backups', (req, res) => res.json(view(db.get())));
    api.post('/backups', async (req, res) => {
        const conn = db.get();
        try {
            const file = await backup.backupNow(conn);
            audit.record(conn, 'admin', 'backup_run', null, req.ip);
            res.json({ ok: true, created: Boolean(file), ...view(conn) });
        } catch (err) {
            res.status(500).json({ error: `The backup failed: ${err.message}` });
        }
    });
    // Checks the newest backup on a temporary copy (integrity check and row counts against the live data).
    api.post('/backups/verify', async (req, res) => {
        const conn = db.get();
        try {
            const report = await backup.verifyNewest(conn);
            if (!report) return res.status(404).json({ error: 'There is no backup to verify yet.' });
            audit.record(conn, 'admin', 'backup_verified', { file: report.file, ok: report.ok }, req.ip);
            res.json(report);
        } catch (err) {
            res.status(500).json({ error: `The check failed: ${err.message}` });
        }
    });
};
