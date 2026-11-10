// A short, append-only record of dashboard and key activity.
function record(db, actor, action, detail, ip) {
    db.prepare('INSERT INTO audit_log (at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), actor, action, detail ? JSON.stringify(detail) : null, ip || null);
}

// Newest first. `before` (a row id) pages back through older rows; `actions` keeps only those kinds of event.
function recent(db, limit = 50, { before, actions } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const where = [];
    const args = [];
    const cursor = parseInt(before, 10);
    if (Number.isInteger(cursor) && cursor > 0) { where.push('id < ?'); args.push(cursor); }
    if (Array.isArray(actions) && actions.length) { where.push(`action IN (${actions.map(() => '?').join(', ')})`); args.push(...actions); }
    const sql = `SELECT id, at, actor, action, detail, ip FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, n)
        .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

module.exports = { record, recent };
