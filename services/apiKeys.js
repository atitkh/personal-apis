// API keys for machine consumers. Keys are random (192 bits), so a plain SHA-256 is enough to store them.
const crypto = require('crypto');

const PREFIX = 'pak_';
const SCOPE_RE = /^(\*|[a-z][a-z0-9_-]*:(\*|[a-z][a-z0-9_-]*))$/;
const TOUCH_EVERY_MS = 60 * 1000; // do not write last_used_at on every request

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

function parseScopes(scopes) {
    const list = Array.isArray(scopes) ? scopes : String(scopes || '').split(',');
    const clean = list.map((s) => String(s).trim()).filter(Boolean);
    if (clean.length === 0) throw new Error('At least one scope is required (for example attendance:read)');
    for (const s of clean) {
        if (!SCOPE_RE.test(s)) throw new Error(`Invalid scope "${s}". Use domain:action, domain:* or *`);
    }
    return [...new Set(clean)];
}

// granted: array of scopes on the key. required: "domain:action".
function hasScope(granted, required) {
    const domain = required.split(':')[0];
    return granted.some((g) => g === '*' || g === required || g === `${domain}:*`);
}

function create(db, { name, scopes }) {
    if (!name || !String(name).trim()) throw new Error('A name is required');
    const list = parseScopes(scopes);
    const key = PREFIX + crypto.randomBytes(24).toString('base64url');
    const row = db.prepare(
        'INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(String(name).trim(), key.slice(0, 8), hash(key), JSON.stringify(list), new Date().toISOString());
    return { id: Number(row.lastInsertRowid), name: String(name).trim(), scopes: list, key };
}

// Returns { id, name, scopes } for a live key, or null.
function verify(db, key) {
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) return null;
    const row = db.prepare('SELECT id, name, scopes, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(hash(key));
    if (!row) return null;
    const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
    if (Date.now() - last > TOUCH_EVERY_MS) {
        db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    }
    return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) };
}

function list(db) {
    return db.prepare('SELECT id, name, key_prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id').all()
        .map((r) => ({ ...r, scopes: JSON.parse(r.scopes) }));
}

// idOrName: numeric id, or the name of an active key. Returns true if a key was revoked.
function revoke(db, idOrName) {
    const now = new Date().toISOString();
    const byId = /^\d+$/.test(String(idOrName));
    const res = byId
        ? db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, Number(idOrName))
        : db.prepare('UPDATE api_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL').run(now, String(idOrName));
    return res.changes > 0;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function get(db, id) {
    const r = db.prepare('SELECT id, name, key_prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE id = ?').get(id);
    return r ? { ...r, scopes: JSON.parse(r.scopes) } : null;
}

// What changed between two scope lists, as names only.
function diffScopes(before, after) {
    return { added: after.filter((s) => !before.includes(s)), removed: before.filter((s) => !after.includes(s)) };
}

// Changes a live key's name and/or scopes in place: the secret and its hash stay as they are, and verify() reads the row on
// every call, so a change applies to the key's next request. Granting "*" needs confirmAll. Errors carry .status (400/404/409).
// Returns { key, added, removed, renamedFrom } (key is the list() shape, never the secret).
function update(db, id, { name, scopes, confirmAll } = {}) {
    const before = Number.isInteger(id) ? get(db, id) : null;
    if (!before) throw fail(404, 'No key with that id.');
    if (before.revoked_at) throw fail(409, 'A revoked key cannot be edited. Create a new key instead.');
    if (name === undefined && scopes === undefined) throw fail(400, 'Nothing to change: send a name or scopes.');

    let nextName = before.name;
    if (name !== undefined) {
        nextName = String(name).trim();
        if (nextName.length < 1 || nextName.length > 60) throw fail(400, 'The name must be 1 to 60 characters.');
    }
    let nextScopes = before.scopes;
    if (scopes !== undefined) {
        try { nextScopes = parseScopes(scopes); } catch (err) { throw fail(400, err.message); }
    }
    const { added, removed } = diffScopes(before.scopes, nextScopes);
    if (added.includes('*') && confirmAll !== true) {
        throw fail(400, 'Giving a key every scope ("*") needs confirm_all: true.');
    }
    try {
        const res = db.prepare('UPDATE api_keys SET name = ?, scopes = ? WHERE id = ? AND revoked_at IS NULL')
            .run(nextName, JSON.stringify(nextScopes), id);
        if (res.changes === 0) throw fail(409, 'A revoked key cannot be edited. Create a new key instead.');
    } catch (err) {
        if (/UNIQUE/i.test(err.message)) throw fail(409, `A key named "${nextName}" is already active.`);
        throw err;
    }
    return { key: get(db, id), added, removed, renamedFrom: nextName !== before.name ? before.name : null };
}

module.exports = { create, verify, list, get, update, diffScopes, revoke, hasScope, parseScopes };
