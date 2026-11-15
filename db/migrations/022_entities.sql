-- Entities: the people, projects, organizations and topics other records can point at through links (services/entities.js).
-- aliases is a JSON array of up to 10 short names ("Kunjal", "KC"); the service keeps it tidy. One entity per kind and
-- name (case-insensitive). Names, aliases and notes are content: they never go into audit rows.
CREATE TABLE entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('person', 'project', 'organization', 'topic', 'other')),
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    aliases     TEXT NOT NULL DEFAULT '[]',
    notes       TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
    current_rev INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL
);
CREATE UNIQUE INDEX entities_kind_name ON entities (kind, name COLLATE NOCASE);

-- Every version of an entity (kind, name, aliases, notes as they were after the change). Revision 1 is what was first
-- filed and is never rewritten; a restore is a new revision.
CREATE TABLE entity_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   INTEGER NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    snapshot    TEXT NOT NULL,         -- JSON of the editable fields
    source      TEXT NOT NULL,         -- create | edit | restore
    actor       TEXT NOT NULL,
    note        TEXT,
    at          TEXT NOT NULL,
    UNIQUE (entity_id, rev)
);

-- Like the other domains (migration 021): deleting an entity for good removes its links.
CREATE TRIGGER links_gone_entities AFTER DELETE ON entities BEGIN
    DELETE FROM links WHERE (from_domain = 'entities' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'entities' AND to_id = CAST(OLD.id AS TEXT));
END;
