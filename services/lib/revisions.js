// The row-plus-revisions pattern the domain services share. A domain describes its tables once:
//   spec = { table: 'flights', revTable: 'flight_revisions', fk: 'flight_id' }
// and keeps its own `need`, snapshot shape, history columns and restore rules.
const { toId } = require('./validate');

const stamp = () => new Date().toISOString();

// The row with this id or a `fail()` (the domain's own not-found error, built by the caller so its message stays as is).
function needRow(db, table, id, fail) {
    const row = toId(id) && db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(toId(id));
    if (!row) throw fail();
    return row;
}

// Stores the row as it is now (`snapshot(row)`) as its next revision and moves current_rev on. Every change ends here.
function commitRevision(db, spec, id, { source, actor, note }, snapshot) {
    const who = String(actor || 'unknown');
    const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id);
    const rev = row.current_rev + 1;
    const at = stamp();
    db.prepare(`INSERT INTO ${spec.revTable} (${spec.fk}, rev, snapshot, source, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, rev, JSON.stringify(snapshot(row)), source, who, note || null, at);
    db.prepare(`UPDATE ${spec.table} SET current_rev = ?, updated_at = ?, updated_by = ? WHERE id = ?`).run(rev, at, who, id);
    return rev;
}

// One stored revision of a row, or undefined.
function findRevision(db, spec, rowId, rev) {
    return db.prepare(`SELECT * FROM ${spec.revTable} WHERE ${spec.fk} = ? AND rev = ?`).get(rowId, toId(rev));
}

module.exports = { needRow, commitRevision, findRevision };
