-- Flight data enrichment: more facts per flight, filled from data sources (adapters in services/adapters/ and
-- observations pushed over /hub) and merged by services/enrich.js. Times are UTC ISO strings like sched_dep.
ALTER TABLE flights ADD COLUMN dep_terminal TEXT;
ALTER TABLE flights ADD COLUMN dep_gate TEXT;
ALTER TABLE flights ADD COLUMN arr_terminal TEXT;
ALTER TABLE flights ADD COLUMN arr_gate TEXT;
ALTER TABLE flights ADD COLUMN baggage_belt TEXT;
ALTER TABLE flights ADD COLUMN aircraft_reg TEXT;
ALTER TABLE flights ADD COLUMN est_dep TEXT;
ALTER TABLE flights ADD COLUMN est_arr TEXT;
ALTER TABLE flights ADD COLUMN delay_min INTEGER;
-- JSON array of field names a person set by hand; a source never overwrites them until they are unlocked.
ALTER TABLE flights ADD COLUMN locked_fields TEXT NOT NULL DEFAULT '[]';

-- What one source said about one flight at one time (ok or not). fields is JSON of normalised, cleaned values
-- (enrichable fields only); source_status is the source's own status word ("Arrived", "Canceled"); error a short
-- code. No raw payload is kept.
CREATE TABLE flight_observations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id     INTEGER NOT NULL REFERENCES flights (id) ON DELETE CASCADE,
    source        TEXT NOT NULL,
    fetched_at    TEXT NOT NULL,
    ok            INTEGER NOT NULL,
    fields        TEXT NOT NULL DEFAULT '{}',
    source_status TEXT,
    error         TEXT,
    actor         TEXT NOT NULL
);
CREATE INDEX flight_observations_flight ON flight_observations (flight_id, source, id);

-- Settings per source. A source without a row is enabled, priority 100, monthly cap 80. Lower priority wins.
-- API keys are never stored here: they live in the hub's environment.
CREATE TABLE flight_sources (
    name        TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    priority    INTEGER NOT NULL DEFAULT 100,
    monthly_cap INTEGER,
    updated_at  TEXT NOT NULL
);
INSERT INTO flight_sources (name, enabled, priority, monthly_cap, updated_at)
    VALUES ('aerodatabox', 1, 10, 80, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           ('gmail', 1, 20, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Lookups made per source and month (UTC, 'YYYY-MM'), against the monthly cap.
CREATE TABLE flight_source_usage (
    source TEXT NOT NULL,
    month  TEXT NOT NULL,
    calls  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, month)
);
