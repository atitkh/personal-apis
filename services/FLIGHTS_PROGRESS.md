# Flights domain: progress

Plan: `memory/projects/personal-hub-flights-plan.md` in the OpenClaw workspace (Decisions section at the end).
The model, dedupe and privacy rules are described at the top of `services/flights.js`; this file says what
exists and what comes next.

## Done (stage 1: storage, seed, service, REST, tests; 2026-11-10)

- `db/migrations/007_flights.sql`: `airports`, `airlines`, `trips`, `flights`, `flight_revisions`,
  `flight_settings`. Unique `(airline_iata, flight_number, dep_local_date, origin_iata)` and
  `(source, source_key)` where a source key is set.
- Airports seed: `db/seed/airports.json` (520 KB, 5459 airports, every one with an IATA zone), loaded by
  `db/seed.js` from `db.open()` after the migrations. Idempotent: a marker `seed:airports@<built>:<count>`
  in `schema_migrations` skips an unchanged seed; a new seed upserts by IATA code (about 40 ms per open,
  also for the in-memory test databases). `db.health().migrations` does not count the marker.
- `services/flights.js`:
  - `create`, `get` (`rev`), `history`, `list` (year, airport, airline, trip, status, limit/offset; newest
    first, with `total`), `update` (fields sent; null clears; no-op = unchanged), `restore` (as a new
    revision; rev 1 is never rewritten). No delete: `status: cancelled`.
  - Times: stored UTC. A time without an offset is airport time (origin for departures, destination for
    arrivals) and needs the airport's zone. `dep_tz`, `arr_tz`, `dep_local_date` and `distance_km`
    (haversine, 0.1 km) are derived on every write; unknown airports give null distance and zone.
  - Flight numbers are normalised ("AA 01234" for AA is 1234). Duplicate = 409 `duplicate` with `id`.
  - `upcoming({ now, limit })`: not cancelled, not yet landed (in the air counts), soonest first.
  - `stats({ year, now })`, the Passport: flights departed by now and not cancelled; distance, hours
    (scheduled times), airports, countries, airlines, aircraft types, longest/shortest, top airports,
    routes (direction-agnostic), airlines, aircraft, `country_list`, `per_year` (always all years),
    `upcoming` count, `unmatched` { flights, airports } for codes not in the seed.
  - Trips: `listTrips` (with flight counts), `getTrip` (with flights), `createTrip`, `updateTrip`. No delete.
  - Settings: `getSettings`, `putSettings`; only `home_airport` (must be a seeded airport; null clears).
  - `overview()` feeds the domain tile (records, label flight/flights, lastChange).
- `routes/hub/flights.js` at `/hub/flights` (`requireDomain('flights')`, off = 503 `domain_disabled`):
  - `flights:read`: `GET /`, `GET /upcoming`, `GET /stats` (`?year=`), `GET /settings`, `GET /trips`,
    `GET /trips/:id`, `GET /:id` (`?rev=`), `GET /:id/history`
  - `flights:write` (plus `flights:read`, because answers carry the booking reference):
    `POST /`, `PATCH /:id`, `POST /:id/restore`, `POST /trips`, `PATCH /trips/:id`, `PUT /settings`
  - `flights:suggest` is reserved for stage 2 and grants nothing yet.
  - `hub.js` `handle()` now adds a HubError's `extra` (safe ids only) to the JSON error, for the duplicate id.
- Privacy of `booking_ref`: stored (decision 4); only in flight answers, which all need `flights:read`.
  Audit rows carry `{ id, flight: "AA 1234 LIT-DFW 2026-03-01", rev }` (trips: id, title; settings: the
  keys changed). Error messages never echo a value. Not in `stats()` or `overview()`. Tested.
- Registry entry `flights` (private, db). Admin: activity chip "Flights" and sentences
  (`flight_created`, `flight_updated`, `flight_restored`, `trip_created`, `trip_updated`,
  `flight_settings_changed`), scope descriptions in `routes/admin/public/scopes.js`. The overview's
  "upcoming" placeholder for flights disappears by itself now that the domain is registered.
- Tests: `tests/flights.test.js`, `tests/flightsHub.test.js` (28 tests). Three older tests that listed the
  registered domains now include flights (the unknown-domain 404 test uses `attendance`). Suite: 253 pass.

## Seed provenance

OurAirports `airports.csv` (public domain, https://ourairports.com/data/), downloaded 2026-11-10 from
https://davidmegginson.github.io/ourairports-data/airports.csv. Kept: rows with a 3-letter IATA code and
`scheduled_service=yes`, plus every `large_airport` / `medium_airport` with an IATA code; for a code that
appears twice the bigger airport wins. Zones from `tz-lookup` 6.1.25 (lat/lon, offline), run in a
throwaway node:20 container; it is not a hub dependency. Rebuild: see the header of `scripts/airports-build.js`.
`airlines` is empty: flights carry `airline_name` themselves; seed it later if wanted.

## Next

- Stage 2: MCP tool `flights` (list, get, upcoming, stats; add, edit, suggest), `flight_candidates` table
  and queue (suggest, accept, dismiss), `flights:suggest`, audit, tests. Decide whether MCP answers carry
  `booking_ref` (probably not by default).
- Stage 3: dashboard Flights view (Passport, map, list + drawer, upcoming, found-flights queue), board channel.
- Stage 4: ingestion (`flights_scan.py`, `flights-job` key), briefing and digest mention upcoming flights.
- Later: admin-only real delete; trip delete; airlines seed.
- Not deployed: local commits only, not pushed, container not restarted. Migration 007 runs on the next start.
