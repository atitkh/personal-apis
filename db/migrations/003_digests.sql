-- What the operator has chosen per hub domain. Titles, sensitivity and defaults are declared in code
-- (services/domains.js); only the on/off choice lives here.
CREATE TABLE hub_domains (
    name       TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT
);

-- One row per digest: kind "daily" (period 2026-11-08) or "weekly" (period 2026-W45).
CREATE TABLE digests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    period      TEXT NOT NULL,
    current_rev INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (kind, period)
);

-- Every version of a digest. Revision 1 is whatever first arrived (normally the generated text) and is
-- never changed, so edits can always be compared with what the model wrote.
CREATE TABLE digest_revisions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_id INTEGER NOT NULL REFERENCES digests (id) ON DELETE CASCADE,
    rev       INTEGER NOT NULL,
    body      TEXT NOT NULL,
    source    TEXT NOT NULL,   -- generated | import | edit | restore
    actor     TEXT NOT NULL,   -- API key name, or "admin"
    model     TEXT,
    note      TEXT,
    meta      TEXT,            -- JSON, for example which sources worked
    at        TEXT NOT NULL,
    UNIQUE (digest_id, rev)
);

-- Full-text index over the current text of each digest (rowid = digests.id).
CREATE VIRTUAL TABLE digest_search USING fts5 (body, tokenize = 'porter unicode61');
