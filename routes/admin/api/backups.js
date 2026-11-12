// Backups: the list and Back up now.
const stats = require('../../../services/adminStats');
const backup = require('../../../services/backup');

module.exports = (api, ctx) => {
    const { db, audit } = ctx;

    api.get('/backups', (req, res) => res.json({ backups: stats.backups() }));
    api.post('/backups', async (req, res) => {
        const conn = db.get();
        try {
            const file = await backup.runOnce(conn, { force: true });
            audit.record(conn, 'admin', 'backup_run', null, req.ip);
            res.json({ ok: true, created: Boolean(file), backups: stats.backups() });
        } catch (err) {
            res.status(500).json({ error: `The backup failed: ${err.message}` });
        }
    });
};
