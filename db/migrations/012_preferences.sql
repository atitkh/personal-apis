-- Preferences: plain facts about how Atit likes things (seat, call hours, airline). Context for agents, not attention.
-- The model is described at the top of services/preferences.js. One row per (area, key); values are plain text and the
-- service refuses anything that looks like a password, a long number or a key.

CREATE TABLE preferences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    area        TEXT NOT NULL CHECK (area IN ('travel', 'communication', 'work', 'food', 'health', 'devices', 'home', 'other')),
    key         TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
    value       TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
    notes       TEXT CHECK (notes IS NULL OR length(notes) <= 300),
    removed_at  TEXT,                  -- set by "unset": hidden from lists, kept with its history, restorable
    current_rev INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    UNIQUE (area, key)
);

-- Every version of a preference (all editable fields as they were after the change). Revision 1 is what was first
-- filed and is never rewritten; a restore is itself a new revision.
CREATE TABLE preference_revisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    preference_id INTEGER NOT NULL REFERENCES preferences (id) ON DELETE CASCADE,
    rev           INTEGER NOT NULL,
    snapshot      TEXT NOT NULL,       -- JSON of area, key, value, notes
    source        TEXT NOT NULL,       -- create | edit | unset | restore
    actor         TEXT NOT NULL,
    note          TEXT,
    at            TEXT NOT NULL,
    UNIQUE (preference_id, rev)
);
