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
  - `flights:suggest`: only `POST /candidates` (stage 2).
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

## Done (stage 2: candidates queue, agent tool, admin API; 2026-11-10)

- `db/migrations/008_flight_candidates.sql`: `flight_candidates` (the flight fields that can be found, derived
  zones and `dep_local_date`, source gmail|calendar|manual, `source_key`, confidence 0..1, status
  pending|accepted|dismissed, `decided_at`/`decided_by`, `accepted_flight_id`, `created_by`). Unique per flight
  key and per (source, source_key), whatever the status: a dismissed flight found again stays dismissed.
- `services/flights.js`: `suggest` (cleaned by the same `build()` as flights; answers 'filed', or 'exists' with
  the flight id and label, or 'already_suggested' with the candidate; the answer never carries booking_ref),
  `listCandidates` (status filter, `all`), `candidateCounts`, `acceptCandidate` (overrides are flight fields;
  creates through `create()`, so a twin is 409 `duplicate` with its id and the candidate stays pending; source
  and source_key come from the candidate), `acceptAll` (max 100 ids, each on its own, per-id result),
  `dismissCandidate` (accepted = 409, repeat = unchanged), `candidateAuditDetail` (id, label, flight id, rev).
- REST: `POST /hub/flights/candidates` (`flights:suggest` only; 201 filed, 200 otherwise; audited
  `flight_candidate_filed`), `GET /hub/flights/candidates?status=` (`flights:read`, with counts, carries
  booking_ref like every REST read). No accept/dismiss on /hub.
- Admin API (session + X-Requested-With, works while the domain is off, audited as `admin`):
  `GET /admin/api/flights/candidates`, `POST .../:id/accept` (body = overrides), `POST .../accept-all`
  ({ids}), `POST .../:id/dismiss`. Overview carries `flights.candidates` counts; the attention list says
  "N found flights wait for review" (links to activity until the Flights view exists). Activity chip and
  sentences for the three candidate actions.
- MCP tool `flights` (`services/mcp/domains/flights.js`, untrusted = DATA_NOTE; description says times are
  UTC with dep_local/arr_local airport time): read `list`, `get`, `upcoming`, `stats`, `trips`,
  `candidates`; write mode `suggest` (`flights:suggest`), `add` and `edit` (new scope `flights:edit`, as
  places:edit; REST `flights:write` grants no MCP write). Tool needs `flights:read` to be seen (a suggest-only
  key uses REST). booking_ref left out everywhere (`has_booking_ref: true` instead); `get` with
  `include_booking_ref: true` adds it. No delete/restore/accept/dismiss. Audit stays `mcp_call` tool/action/ok.
- Scopes text: `flights:suggest` and `flights:edit` in `routes/admin/public/scopes.js`.
- Tests: `tests/mcpFlights.test.js`, `tests/adminFlights.test.js`, candidate blocks in `flightsHub.test.js`;
  `mcp.test.js` / `adminAgents.test.js` now use `attendance:read` as the scope with no tool. Suite: 284 pass.
- E2E on a scratch hub (/tmp copy, throwaway node:20 container, scratch DB, port 3999): tools/list showed
  `flights` with read actions + suggest for a read+suggest key in write mode; suggest filed, repeat answered
  already_suggested, candidates listed, admin accept created flight 1, get had has_booking_ref only, get with
  include_booking_ref returned it; audit rows had no booking reference, app log neither.

## Next

- Stage 3: dashboard Flights view (Passport, map, list + drawer, upcoming, found-flights queue using the admin
  API above: accept one / accept all / edit before accepting / dismiss), board channel; point the overview's
  found-flights attention link at the queue tab.
- Stage 4: ingestion (`flights_scan.py`, `flights-job` key with flights:read + flights:suggest, posting to
  `POST /hub/flights/candidates` over REST), briefing and digest mention upcoming flights.
- Later: admin-only real delete; trip delete; airlines seed. MCP add/edit are logged only as `mcp_call`.
- Not deployed: local commits only, not pushed, container not restarted. Migrations 007 and 008 run on the
  next start; Flights MCP mode defaults to read.
