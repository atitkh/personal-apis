-- Found flights waiting for a person: a job (Gmail, calendar) or an agent files a candidate with
-- flights:suggest; a person accepts it (it becomes a flight through the normal create path) or dismisses it.
-- Fields are cleaned exactly as for flights (times stored UTC, dep_local_date derived from the origin zone).
-- One candidate per (source, source_key) and one per flight key, whatever its status: a dismissed candidate
-- stays dismissed when the same flight is found again.
CREATE TABLE flight_candidates (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    airline_iata       TEXT NOT NULL,
    airline_name       TEXT,
    flight_number      TEXT NOT NULL,
    origin_iata        TEXT NOT NULL,
    dest_iata          TEXT NOT NULL,
    sched_dep          TEXT NOT NULL,      -- UTC ISO
    sched_arr          TEXT,               -- UTC ISO
    dep_tz             TEXT,
    arr_tz             TEXT,
    dep_local_date     TEXT NOT NULL,      -- part of the dedupe key, as for flights
    booking_ref        TEXT,               -- private: only in answers to flights:read keys, never in audit
    cabin              TEXT,
    seat               TEXT,
    aircraft_type      TEXT,
    notes              TEXT,
    source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('gmail', 'calendar', 'manual')),
    source_key         TEXT,               -- the source's own id (hashed by the caller), for re-scans
    confidence         REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
    decided_at         TEXT,
    decided_by         TEXT,
    accepted_flight_id INTEGER REFERENCES flights (id),
    created_at         TEXT NOT NULL,
    created_by         TEXT NOT NULL
);
CREATE UNIQUE INDEX flight_candidates_dedupe ON flight_candidates (airline_iata, flight_number, dep_local_date, origin_iata);
CREATE UNIQUE INDEX flight_candidates_source_key ON flight_candidates (source, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX flight_candidates_status ON flight_candidates (status, sched_dep);
