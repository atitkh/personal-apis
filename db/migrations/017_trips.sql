-- Trips become a domain of their own (services/trips.js). The `trips` table from migration 007 stays where it is, with
-- its ids, so flights.trip_id and deadlines.trip_id keep pointing at the same trips. New here: where and what kind of
-- trip it is, a hand-set cancelled, revisions with restore, a small itinerary (trip_items) and the dismissed
-- suggestions (used from stage 2 on).

ALTER TABLE trips ADD COLUMN destination TEXT CHECK (destination IS NULL OR length(destination) <= 120);
ALTER TABLE trips ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('leisure', 'conference', 'research', 'family', 'work', 'other'));
ALTER TABLE trips ADD COLUMN status_override TEXT CHECK (status_override IS NULL OR status_override = 'cancelled');
ALTER TABLE trips ADD COLUMN current_rev INTEGER NOT NULL DEFAULT 0;

-- Every version of a trip (all editable fields as they were after the change). Revision 1 is what was first filed
-- (for trips made before this migration: the trip as it was when the migration ran); a restore is a new revision.
CREATE TABLE trip_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id     INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    rev         INTEGER NOT NULL,
    snapshot    TEXT NOT NULL,         -- JSON of the editable fields
    source      TEXT NOT NULL,         -- create | edit | restore | migration
    actor       TEXT NOT NULL,
    note        TEXT,
    at          TEXT NOT NULL,
    UNIQUE (trip_id, rev)
);

INSERT INTO trip_revisions (trip_id, rev, snapshot, source, actor, note, at)
SELECT id, 1,
       json_object('title', title, 'destination', destination, 'kind', kind, 'start_date', start_date, 'end_date', end_date,
                   'notes', notes, 'status_override', status_override),
       'migration', updated_by, 'As it was when trips became a domain', updated_at
FROM trips;
UPDATE trips SET current_rev = 1;

-- A small itinerary per trip: where Atit stays, ground transport, activities, other bookings. reference is private
-- (only returned when asked for, like deadlines). Deleting a trip deletes its items.
CREATE TABLE trip_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id     INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('stay', 'ground', 'activity', 'booking', 'other')),
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    start_date  TEXT CHECK (start_date IS NULL OR start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    end_date    TEXT CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    place       TEXT,
    notes       TEXT,
    reference   TEXT CHECK (reference IS NULL OR length(reference) <= 120),
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL
);
CREATE INDEX trip_items_trip ON trip_items (trip_id, sort);

-- Suggested trips (flights without a trip, grouped) that Atit dismissed: key = the sorted flight ids, comma separated.
CREATE TABLE trip_suggestion_dismissed (
    key TEXT PRIMARY KEY,
    at  TEXT NOT NULL
);
