-- Notes: a personal wiki. Markdown notes with [[wikilinks]] that become links (rel 'mentions') on every save
-- (services/notes.js). Titles, bodies and tags are content: they never go into audit rows or error messages.
-- kind is a free slug (note, daily, inbox, meeting, ...); tags is a JSON array of up to 20 short slugs.
CREATE TABLE notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    body        TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
    kind        TEXT NOT NULL DEFAULT 'note',
    tags        TEXT NOT NULL DEFAULT '[]',
    pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    current_rev INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    removed_at  TEXT                  -- soft delete: hidden from lists and links, kept with its history, restorable
);
CREATE INDEX notes_order ON notes (removed_at, pinned DESC, updated_at DESC);
CREATE INDEX notes_title ON notes (title COLLATE NOCASE);

-- Every version of a note (title, body, kind, tags, pinned as they were after the change). Revision 1 is what was first
-- filed and is never rewritten; a restore is a new revision. Autosaves in quick succession share one revision.
CREATE TABLE note_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id     INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    snapshot    TEXT NOT NULL,         -- JSON of the editable fields
    source      TEXT NOT NULL,         -- create | edit | autosave | restore | append
    actor       TEXT NOT NULL,
    note        TEXT,
    at          TEXT NOT NULL,
    UNIQUE (note_id, rev)
);

-- [[Title]] targets in a note's text that no note or entity answered to when it was last saved (the "Missing pages" list).
CREATE TABLE note_unresolved (
    note_id     INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    key         TEXT NOT NULL,         -- the target, lower case
    target      TEXT NOT NULL,         -- the target as written
    PRIMARY KEY (note_id, key)
);
CREATE INDEX note_unresolved_key ON note_unresolved (key);

-- Like the other domains (migrations 021, 022): deleting a note for good removes its links.
CREATE TRIGGER links_gone_notes AFTER DELETE ON notes BEGIN
    DELETE FROM links WHERE (from_domain = 'notes' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'notes' AND to_id = CAST(OLD.id AS TEXT));
END;
