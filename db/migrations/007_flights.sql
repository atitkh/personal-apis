-- Flights: Atit's flight history and upcoming flights, grouped loosely into trips. The model is described at
-- the top of services/flights.js. Times are UTC ISO strings; the local zone of each end comes from the airport.
-- The closed lists (status, source) are checked here; cabin and aircraft type are free text checked in code.

-- Reference data, loaded from db/seed/airports.json by db/seed.js (OurAirports, public domain). Never edited
-- by callers; a newer seed replaces rows by IATA code.
CREATE TABLE airports (
    iata    TEXT PRIMARY KEY,          -- "LIT"
    icao    TEXT,                      -- "KLIT"
    name    TEXT NOT NULL,
    city    TEXT,
    country TEXT NOT NULL,             -- ISO 3166-1 alpha-2
    lat     REAL NOT NULL,
    lon     REAL NOT NULL,
    tz      TEXT                       -- IANA zone, "America/Chicago"
);

-- Airline names by IATA code. Optional: a flight carries its own airline_name too.
CREATE TABLE airlines (
    iata TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

-- A light grouping of flights ("Spring break 2027"). Deleting a trip leaves its flights, without the link.
CREATE TABLE trips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    start_date TEXT,                   -- YYYY-MM-DD
    end_date   TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

CREATE TABLE flights (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id        INTEGER REFERENCES trips (id) ON DELETE SET NULL,
    airline_iata   TEXT NOT NULL,      -- "AA"
    airline_name   TEXT,
    flight_number  TEXT NOT NULL,      -- "1234", without the airline code
    origin_iata    TEXT NOT NULL,
    dest_iata      TEXT NOT NULL,
    sched_dep      TEXT NOT NULL,      -- UTC ISO
    sched_arr      TEXT,               -- UTC ISO
    dep_tz         TEXT,               -- IANA zone of the origin, from airports.tz (null if unknown)
    arr_tz         TEXT,
    dep_local_date TEXT NOT NULL,      -- departure date in dep_tz (UTC if unknown): part of the dedupe key
    actual_dep     TEXT,
    actual_arr     TEXT,
    aircraft_type  TEXT,
    cabin          TEXT,
    seat           TEXT,
    booking_ref    TEXT,               -- private: only in answers to flights:read keys, never in audit or logs
    status         TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    distance_km    REAL,               -- great circle between the airports, null if either is unknown
    source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'gmail', 'calendar', 'feed')),
    source_key     TEXT,               -- the source's own id (hashed by the caller), for re-scans
    notes          TEXT,
    current_rev    INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    updated_by     TEXT NOT NULL
);
-- One flight is one row, however often it is filed.
CREATE UNIQUE INDEX flights_dedupe ON flights (airline_iata, flight_number, dep_local_date, origin_iata);
CREATE UNIQUE INDEX flights_source_key ON flights (source, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX flights_dep ON flights (sched_dep);
CREATE INDEX flights_trip ON flights (trip_id);

-- Every version of a flight (all its fields as they were after the change), so a bad edit can be restored.
-- Revision 1 is what was first filed and is never rewritten; a restore is itself a new revision.
CREATE TABLE flight_revisions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL REFERENCES flights (id) ON DELETE CASCADE,
    rev       INTEGER NOT NULL,
    snapshot  TEXT NOT NULL,           -- JSON of the editable fields
    source    TEXT NOT NULL,           -- create | edit | restore
    actor     TEXT NOT NULL,
    note      TEXT,
    at        TEXT NOT NULL,
    UNIQUE (flight_id, rev)
);

-- Plain settings for the domain. home_airport (an IATA code) is the first.
CREATE TABLE flight_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);
