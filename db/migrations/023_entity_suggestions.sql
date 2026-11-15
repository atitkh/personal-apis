-- Names the nightly job saw that no entity claims yet, waiting for a person to accept or dismiss them (like place_suggestions).
-- name is unique on its own (any case): one row per name whatever kind it was first guessed to be, so a dismissed name never
-- comes back and a repeat sighting only raises its count. example is a short note on where it was seen, no record content.
CREATE TABLE entity_suggestions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind               TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('person', 'project', 'organization', 'topic', 'other')),
    example            TEXT,
    count              INTEGER NOT NULL DEFAULT 1,
    first_seen         TEXT NOT NULL,
    last_seen          TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
    resolved_entity_id INTEGER REFERENCES entities (id) ON DELETE SET NULL,
    decided_at         TEXT,
    decided_by         TEXT,
    suggested_by       TEXT
);
CREATE INDEX entity_suggestions_status ON entity_suggestions (status, last_seen);
