-- Lifelog (services/lifelog.js): what Atit does, pushed as text from many sources (camera captions, glasses, sensors,
-- voice, manual notes). Two layers:
--   lifelog_observations  raw lines, APPEND-ONLY: never edited, kept forever (no retention by default).
--   lifelog_episodes      derived or hand-made facts ("ate lunch 12:40-13:05") with revisions and restore like trips,
--                         linked to the observations behind them through lifelog_episode_observations.
--
-- APPEND-ONLY GUARD. Triggers abort every UPDATE of an observation, and every DELETE unless a row exists in
-- lifelog_forget_guard. The only code that writes that row is the admin "forget a time range" path
-- (lifelog.forget), which inserts the guard row, deletes, and removes the guard row again, all inside ONE
-- transaction: a failure rolls the guard row back with everything else, and no other connection ever sees it
-- (SQLite has one writer at a time). A stray DELETE anywhere else fails.
--
-- SEARCH. FTS5 tables with external content (content = the real table, content_rowid = id), kept in sync by
-- AFTER triggers. The observations index is only ever written on insert and on a (guarded) delete, so it needs
-- no update trigger; the episodes index follows insert, update and delete.

CREATE TABLE IF NOT EXISTS lifelog_observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 60),
    at          TEXT NOT NULL,                    -- UTC ISO
    end_at      TEXT,                             -- UTC ISO, optional
    local_date  TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- hub zone, at insert
    kind        TEXT CHECK (kind IS NULL OR length(kind) <= 40),
    text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
    place       TEXT CHECK (place IS NULL OR length(place) <= 120),
    place_id    INTEGER,                          -- places.id when the place resolved (no foreign key: places may go)
    tags        TEXT,                             -- JSON array of slugs, at most 10
    data        TEXT CHECK (data IS NULL OR length(data) <= 2048), -- JSON object
    confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    dedupe      TEXT CHECK (dedupe IS NULL OR length(dedupe) <= 120),
    created_at  TEXT NOT NULL,
    key_id      INTEGER                           -- the API key that pushed it (null: dashboard)
);
CREATE UNIQUE INDEX IF NOT EXISTS lifelog_observations_dedupe ON lifelog_observations (source, dedupe) WHERE dedupe IS NOT NULL;
CREATE INDEX IF NOT EXISTS lifelog_observations_at ON lifelog_observations (at);
CREATE INDEX IF NOT EXISTS lifelog_observations_day ON lifelog_observations (local_date, at);
CREATE INDEX IF NOT EXISTS lifelog_observations_source ON lifelog_observations (source, at);
CREATE INDEX IF NOT EXISTS lifelog_observations_kind ON lifelog_observations (kind, at);

-- At most one row, only ever present inside the forget transaction (see the top of this file).
CREATE TABLE IF NOT EXISTS lifelog_forget_guard (
    id  INTEGER PRIMARY KEY CHECK (id = 1),
    at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS lifelog_observations_no_update BEFORE UPDATE ON lifelog_observations
BEGIN
    SELECT RAISE(ABORT, 'lifelog observations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS lifelog_observations_no_delete BEFORE DELETE ON lifelog_observations
WHEN NOT EXISTS (SELECT 1 FROM lifelog_forget_guard)
BEGIN
    SELECT RAISE(ABORT, 'lifelog observations are append-only: use forget');
END;

CREATE VIRTUAL TABLE IF NOT EXISTS lifelog_observations_fts USING fts5 (
    text, tags, kind, source, content = 'lifelog_observations', content_rowid = 'id'
);

CREATE TRIGGER IF NOT EXISTS lifelog_observations_fts_ai AFTER INSERT ON lifelog_observations
BEGIN
    INSERT INTO lifelog_observations_fts (rowid, text, tags, kind, source) VALUES (new.id, new.text, new.tags, new.kind, new.source);
END;

CREATE TRIGGER IF NOT EXISTS lifelog_observations_fts_ad AFTER DELETE ON lifelog_observations
BEGIN
    INSERT INTO lifelog_observations_fts (lifelog_observations_fts, rowid, text, tags, kind, source)
    VALUES ('delete', old.id, old.text, old.tags, old.kind, old.source);
END;

CREATE TABLE IF NOT EXISTS lifelog_episodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL DEFAULT 'other' CHECK (length(kind) BETWEEN 1 AND 40),
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    start_at    TEXT NOT NULL,                    -- UTC ISO
    end_at      TEXT,                             -- UTC ISO
    local_date  TEXT NOT NULL,                    -- hub zone date of start_at
    place       TEXT CHECK (place IS NULL OR length(place) <= 120),
    place_id    INTEGER,
    detail      TEXT CHECK (detail IS NULL OR length(detail) <= 2000),
    source      TEXT NOT NULL DEFAULT 'manual' CHECK (length(source) BETWEEN 1 AND 60), -- manual | derived | a source label
    confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    current_rev INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lifelog_episodes_day ON lifelog_episodes (local_date, start_at);
CREATE INDEX IF NOT EXISTS lifelog_episodes_start ON lifelog_episodes (start_at);
CREATE INDEX IF NOT EXISTS lifelog_episodes_kind ON lifelog_episodes (kind, start_at);

CREATE TABLE IF NOT EXISTS lifelog_episode_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id  INTEGER NOT NULL REFERENCES lifelog_episodes (id) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    snapshot    TEXT NOT NULL,         -- JSON of the editable fields
    source      TEXT NOT NULL,         -- create | edit | restore
    actor       TEXT NOT NULL,
    note        TEXT,
    at          TEXT NOT NULL,
    UNIQUE (episode_id, rev)
);

CREATE TABLE IF NOT EXISTS lifelog_episode_observations (
    episode_id      INTEGER NOT NULL REFERENCES lifelog_episodes (id) ON DELETE CASCADE,
    observation_id  INTEGER NOT NULL REFERENCES lifelog_observations (id) ON DELETE CASCADE,
    PRIMARY KEY (episode_id, observation_id)
);
CREATE INDEX IF NOT EXISTS lifelog_episode_observations_obs ON lifelog_episode_observations (observation_id);

CREATE VIRTUAL TABLE IF NOT EXISTS lifelog_episodes_fts USING fts5 (
    title, detail, kind, content = 'lifelog_episodes', content_rowid = 'id'
);

CREATE TRIGGER IF NOT EXISTS lifelog_episodes_fts_ai AFTER INSERT ON lifelog_episodes
BEGIN
    INSERT INTO lifelog_episodes_fts (rowid, title, detail, kind) VALUES (new.id, new.title, new.detail, new.kind);
END;

CREATE TRIGGER IF NOT EXISTS lifelog_episodes_fts_ad AFTER DELETE ON lifelog_episodes
BEGIN
    INSERT INTO lifelog_episodes_fts (lifelog_episodes_fts, rowid, title, detail, kind) VALUES ('delete', old.id, old.title, old.detail, old.kind);
END;

CREATE TRIGGER IF NOT EXISTS lifelog_episodes_fts_au AFTER UPDATE OF title, detail, kind ON lifelog_episodes
BEGIN
    INSERT INTO lifelog_episodes_fts (lifelog_episodes_fts, rowid, title, detail, kind) VALUES ('delete', old.id, old.title, old.detail, old.kind);
    INSERT INTO lifelog_episodes_fts (rowid, title, detail, kind) VALUES (new.id, new.title, new.detail, new.kind);
END;
