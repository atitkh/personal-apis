// Dashboard sign-in. The admin key lives in .env (ADMIN_KEY, at least 32 characters). Signing in with it
// opens a 12 hour session; the browser keeps only an opaque cookie, never the key itself.
const crypto = require('crypto');

const MIN_KEY_LENGTH = 32;
const SESSION_MS = 12 * 60 * 60 * 1000;

const digest = (value) => crypto.createHash('sha256').update(value).digest();
const hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Read on every call so the key can be rotated by recreating the container, and so tests can set it.
function adminKey() {
    const key = process.env.ADMIN_KEY || '';
    return key.length >= MIN_KEY_LENGTH ? key : null;
}

const isEnabled = () => adminKey() !== null;

// Constant-time comparison of the two hashes, so neither the key nor its length leaks through timing.
function checkKey(provided) {
    const key = adminKey();
    if (!key || typeof provided !== 'string' || provided.length === 0) return false;
    return crypto.timingSafeEqual(digest(provided), digest(key));
}

function purgeExpired(db) {
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

function createSession(db, { ip, userAgent } = {}) {
    purgeExpired(db);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_MS).toISOString();
    db.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
        .run(hex(token), new Date(now).toISOString(), expiresAt, ip || null, (userAgent || '').slice(0, 200) || null);
    return { token, expiresAt, maxAgeSeconds: SESSION_MS / 1000 };
}

// Returns { expiresAt } for a live session, otherwise null.
function getSession(db, token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(hex(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
        db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hex(token));
        return null;
    }
    return { expiresAt: row.expires_at };
}

function destroySession(db, token) {
    if (typeof token !== 'string' || token.length === 0) return;
    db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hex(token));
}

module.exports = { isEnabled, checkKey, createSession, getSession, destroySession, MIN_KEY_LENGTH, SESSION_MS };
