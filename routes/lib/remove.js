// The admin side of a permanent delete: plan (validates, writes nothing) -> optional backup -> delete -> audit.
// A failed backup aborts: nothing is deleted. The audit row carries the plan's id, label and counts, never values.
const backup = require('../../services/backup');
const audit = require('../../services/audit');

// `plan()` throws the domain's errors (400 confirm, 404, 409) and returns the preview; `run()` deletes in one
// transaction and returns { id, label, counts, ... }; `detail(result)` shapes the audit row.
async function removal(req, res, conn, action, { plan, run, detail }) {
    plan();
    let file = null;
    if ((req.body || {}).backup === true) {
        try {
            file = await backup.snapshotBeforeDelete(conn);
        } catch (err) {
            return res.status(500).json({ error: `The backup failed, so nothing was deleted: ${err.message}` });
        }
    }
    const result = run();
    const out = { ...result, backup: file };
    audit.record(conn, 'admin', action, { ...detail(result), ...(file ? { backup: file } : {}) }, req.ip);
    return res.json(out);
}

module.exports = { removal };
