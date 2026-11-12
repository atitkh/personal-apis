-- Hub settings: a few typed, admin-only knobs (hub time zone, backup location and schedule). One row per key; a key
-- without a row means "the default" (see services/settings.js). Never holds secrets.

CREATE TABLE hub_settings (
    key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 60),
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
