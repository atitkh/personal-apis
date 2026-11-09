// A short, append-only record of dashboard and key activity.
function record(db, actor, action, detail, ip) {
    db.prepare('INSERT INTO audit_log (at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), actor, action, detail ? JSON.stringify(detail) : null, ip || null);
}

function recent(db, limit = 50) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    return db.prepare('SELECT id, at, actor, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT ?').all(n)
        .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

module.exports = { record, recent };
