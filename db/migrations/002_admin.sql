-- Dashboard sign-ins. Only a hash of the session token is stored.
CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
);

-- Who changed what in the hub, newest first in the dashboard's Activity view.
CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,   -- "admin" or "anonymous"
    action TEXT NOT NULL,   -- login, login_failed, logout, key_created, key_revoked
    detail TEXT,            -- JSON
    ip     TEXT
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
