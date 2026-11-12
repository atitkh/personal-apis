// Shared by the "delete permanently" paths. Deleting is for a person at the dashboard only: it is never on /hub or MCP.
// `bad` is the domain's own error maker, so each domain keeps its error class.

// A stray call cannot delete: the body must say confirm: true.
function needConfirm(bad, input) {
    if (!input || input.confirm !== true) throw bad('confirm_required', 'Send confirm: true to delete permanently.', 400);
}

// Counts of rows for `ids` in a child table; `ids` is one value.
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

module.exports = { needConfirm, count };
