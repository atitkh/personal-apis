-- One row per consumer (Home Assistant, Axis, the digest job, an agent...). Only a SHA-256 of the key is
-- stored; the key itself is shown once, when it is created.
CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,   -- first characters of the key, so `list` can tell keys apart
    key_hash     TEXT NOT NULL UNIQUE,
    scopes       TEXT NOT NULL,   -- JSON array, e.g. ["attendance:read","flights:*"]
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
);

-- A name can be reused once its old key is revoked.
CREATE UNIQUE INDEX api_keys_active_name ON api_keys (name) WHERE revoked_at IS NULL;
