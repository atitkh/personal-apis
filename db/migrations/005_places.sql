-- Places: the spots Atit keeps returning to, each with rules that say how a location is recognised as it.
-- The model and the matching semantics are described at the top of services/places.js.
-- `kind` and rule `type` are open lists checked in code (a new one must not need a table rebuild);
-- the closed lists (source, status, exclude) are checked here.

-- One row per place. The label is what a digest says ("Home", "Campus") and is unique whatever the case.
CREATE TABLE places (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reused, so audit entries stay unambiguous
    label       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind        TEXT NOT NULL DEFAULT 'other',       -- home | campus | family | friend | store | transit | other
    notes       TEXT,
    source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'suggested')),
    current_rev INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL                        -- API key name, or "admin"
);

-- Every version of a place: the label, kind, notes and all its rules as they were after the change, so a
-- bad edit (of the place or of a rule) can be restored. Deleting a place deletes its history with it.
CREATE TABLE place_revisions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id INTEGER NOT NULL REFERENCES places (id) ON DELETE CASCADE,
    rev      INTEGER NOT NULL,
    snapshot TEXT NOT NULL,   -- JSON: { label, kind, notes, rules: [...] }
    source   TEXT NOT NULL,   -- create | import | edit | rule | restore
    actor    TEXT NOT NULL,
    note     TEXT,
    at       TEXT NOT NULL,
    UNIQUE (place_id, rev)
);

-- How a location is recognised as a place.
--   street  value = text that must appear in the geocoded address (any case)
--   zone    value = a Home Assistant zone id ("home" for zone.home)
--   radius  lat, lon, radius_m = a circle; value is an optional caption
-- exclude = 1 turns the rule around: when it matches, the location is NOT this place.
CREATE TABLE place_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,    -- never reused: a restore brings a rule back under its old id
    place_id   INTEGER NOT NULL REFERENCES places (id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    value      TEXT,
    lat        REAL,
    lon        REAL,
    radius_m   REAL,
    exclude    INTEGER NOT NULL DEFAULT 0 CHECK (exclude IN (0, 1)),
    priority   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX place_rules_place ON place_rules (place_id);

-- Streets seen often that no place claims yet. Filed by resolve when the caller asks for it; a person
-- names them (accepted), or says they do not matter (dismissed).
CREATE TABLE place_suggestions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    street            TEXT NOT NULL COLLATE NOCASE UNIQUE,
    example_lat       REAL,
    example_lon       REAL,
    example_text      TEXT,
    count             INTEGER NOT NULL DEFAULT 1,
    first_seen        TEXT NOT NULL,
    last_seen         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
    resolved_place_id INTEGER REFERENCES places (id) ON DELETE SET NULL
);
CREATE INDEX place_suggestions_status ON place_suggestions (status, last_seen);
