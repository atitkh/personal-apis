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

## Done (stage 3: dashboard; 2026-11-10)

- Admin API additions (session + X-Requested-With, errors `{ error, code }`, audited as `admin`, work while the domain is off):
  `GET /admin/api/flights` (filters year, airport, airline, trip, status; limit default 500; **no booking_ref**, only
  `has_booking_ref`), `GET /flights/:id` (full flight with `booking_ref`, `?rev=`, plus `history`), `POST /flights`,
  `PATCH /flights/:id`, `POST /flights/:id/restore`, `GET /flights/stats` (`?year=`; the stats plus `map` {airports with
  lat/lon/visits, routes a/b/flights} and `settings`), `GET /flights/upcoming`, `GET /flights/airports?q=` (iata/icao/city
  prefix or name substring, at most 20), `GET|POST /flights/trips`, `GET|PUT /flights/settings`. Services: `searchAirports`,
  `mapData` (no flight numbers, dates or booking refs). Tests: `tests/adminFlightsView.test.js` (10).
- View `routes/admin/public/views/flights.js` (`#/flights`): tabs Passport / Flights / Found flights (`?tab=found`, alias
  `?tab=queue`; `?show=accepted|dismissed|all`), `#/flights/12` drawer, `?tab=flights&new=1` Add flight, `?year=` on the
  Passport, filters `?year= ?airport= ?airline= ?status= ?q=` on the list. Passport (`passport.js`): six tiles, km/miles
  toggle (localStorage), year chips, SVG map (equirectangular; land outline `worldmap.js` = Natural Earth 110m, 32 KB, built by
  `scripts/worldmap-build.js`; quadratic arcs, repeated across the date line), records, top routes/aircraft/airports/airlines.
  Flights tab: Upcoming strip (next 3), filters + search, table (stacks at 390 px), home airport card (validated by the
  server), drawer with the edit form (times in airport-local time, only changed fields are sent), booking ref masked until
  Show, history with compare and restore, trip picker with inline "New trip", Cancel (status only, no delete). Add flight
  form with datalist airport autocomplete. Found flights: parsed fields, confidence, source, Accept, Edit and accept (drawer),
  Dismiss (confirm), Accept all shown (confirm; per-id toasts, duplicate = "already in your flights"), count badges on the tab
  and the side menu (`shell.setBadge`; also in the More sheet).
- Registered: nav item with an airplane icon (`ui.js`), `g f`, skeleton, palette (Add flight, Flights waiting for review, a
  palette entry per flight: number, route and date only), overview attention line now links to `?tab=found`, write-mode
  confirm wording for Flights. `api.js` keeps `err.code` and `err.data` (the duplicate id travels in it).
- Overview board needed no change: Flights already showed (teal, switch, Off/Read/Read and write). Activity sentences and the
  Flights filter existed from stages 1 and 2 and were checked in the browser.
- Browser checks (36 flow checks + 5 empty-hub checks, all pass): headless Google Chrome through `playwright-core` (from the
  OpenClaw install) against a SCRATCH hub: a throwaway `node:20` container (`pa-scratch`, port 3999, scratch DB under
  `/tmp/pa-scratch-data`, repo copy in `/tmp/pa-flights`). Scripts are in the OpenClaw workspace, not in the repo:
  `workspace/tmp/hub-flights-e2e/{seed.js,more.js,reset.sh,run.mjs}` (`./reset.sh [empty]` then `node run.mjs [empty]`, MORE=
  command adds candidates mid-run). Covered: board row, attention link, nav badge and `g f`, Passport tiles vs the seeded data
  (distance recomputed with haversine), records, map arcs, units, year switch, filters, drawer and masked booking ref,
  edit + restore + compare, trip creation, Esc and focus return, Add flight (validation, autocomplete, twin 409 link), home
  airport (unknown refused), queue accept (duplicate message), edit and accept, dismiss, accept all, palette, deep links, tab
  arrows, cancel, dark mode, 390 px (tiles two across, table stacks, drawer full width), no console errors. Screenshots (6, JPEG
  900 px): `workspace/tmp/hub-flights-shots/`. Suite: 294 pass in node:20.

## Done (stage 4: Gmail backfill; 2026-11-10)

- `scripts/flights_scan.py` in the OpenClaw workspace (python3 -I, stdlib; `pdftotext` used if present). Reads
  atit286@gmail.com through `gog` READ-ONLY (`--gmail-no-send`, only search/get/raw/attachment commands enabled; nothing
  labelled, archived or marked read). Six Gmail queries (airline and travel-site senders, confirmation/itinerary/e-ticket
  subjects, `.ics` attachments), deduped by message and thread. Per message: schema.org FlightReservation JSON-LD, then
  `.ics`, then regex (a stop parser: code + time + nearby date, and a route-line parser: "(LGA) to (ATL)" + Depart/Arrive),
  then PDF tickets via pdftotext. Legs are checked against the airports seed, dates near the mail date, 20 min to 20 h.
- Files each leg as a candidate over REST (`flights_key` in `~/.config/personal-hub/config.json`, flights:read +
  flights:suggest). source gmail, source_key = sha256(message id, leg index), confidence JSON-LD 0.95 (0.8 without an
  arrival), ics 0.9, regex 0.7, PDF 0.65, partial 0.4, status-mail-only 0.35-0.5, probably replaced 0.3. Notes say which
  airline's mail and its date, nothing from the body.
- Merging: one candidate per flight key, best evidence wins, a later schedule-change mail overrides times; arrivals are
  filled from other mails of the same flight; check-in/gate/delay mails only count when nothing firmer has the flight
  (within a day); a leg an older mail lists but the newest multi-leg itinerary of the same booking does not is flagged
  "probably replaced"; legs of a booking with a cancellation mail get "CANCELLED per ..." in notes (candidates have no
  status field). Bookings made for someone else (passenger list or greeting without Atit) veto the same flights from
  unnamed mails.
- Re-run: `python3 -I scripts/flights_scan.py --dry-run [--verbose] [--max-threads N]` (prints only, no state change),
  `python3 -I scripts/flights_scan.py` (new messages only; state `~/.config/personal-hub/flights_scan_state.json` = message
  ids), `--rescan` (re-parse all; the hub answers already_suggested for what it has). `--verbose` adds thread id and notes.
  Output never carries booking refs, addresses or body text; subjects in the human-look list have codes masked.
- Backfill run 2026-11-10: 171 threads / 203 messages (96 skipped as marketing, passcodes, hotels), 42 candidates filed
  (pending): Frontier 17, Korean Air 6, United 4, Southwest 3, Cathay 3, American 2, Delta 2, Nepal Airlines 2, Qatar 1 +
  B6-coded Qatar leg 1, Spirit 1 (cancelled). By year: 2023 2, 2024 6, 2026 33, 2027 1. 7 mails were for other passengers.
- Coverage: Frontier (both mail formats, connections "FLIGHT 4775 & 1450", JSON-LD in "Update regarding" mails), Delta
  (trip details, receipts), United (.ics), Korean Air, Qatar trip summary, Southwest, Spirit (airports by name), American
  rebook/delay, Cathay schedule changes, Nepal Airlines check-in. Needs a human look (4): an eSewa e-ticket (2023, same
  trip as RA 201/202) and three American Airlines boarding-pass mails (2024-10-31, 11-04, 12-13) that carry no flight data.
- For Atit to decide in Found flights: the 2026-03-26 return from Korea has competing versions (KE 35 + KE 3613 via ATL,
  AA 9602, KE 5031 "probably replaced", AA 280 delayed to 03-28); F9 1450 2026-08-13 "probably replaced" by F9 3294; NK 910
  2026-05-09 cancelled; B6 5566 DOH-DFW is the code Qatar's mail used for a Qatar-operated leg.
- Known gaps: no cancelled status on candidates (notes only); a later change mail for an already-filed flight answers
  already_suggested and does not update it; mails from booking sites that name no flight (CheapTripDesk, Flyus, "Print")
  are not listed; PDF-only tickets parse only when the layout has codes next to times; no LLM fallback (none on this host;
  the reachable one is on another machine and mail bodies stay here); Cathay's Jan 2027 HKG-DFW leg has no mail.

## Done (automatic status; 2026-11-10)

- Stored `status` keeps its three values (no change to the flights table), but `scheduled` now means AUTOMATIC.
  `services/flights.js` `effectiveStatus(row, now)` (and the same rule in SQL, `effectiveSql`): cancelled if stored
  cancelled; completed if stored completed or `actual_arr` (else `sched_arr`, else `sched_dep`) is before now (UTC,
  strict); else scheduled.
- API shape: every flight object (REST, admin API, MCP, trips) has `status` = effective and `status_override` = null
  (automatic) or the stored `completed`/`cancelled`. Inputs on create/edit accept `auto` (stored scheduled), `scheduled`
  (same), `completed`, `cancelled`. Revision snapshots hold the stored value; `get(id, {rev})` shows the effective one.
- `list({ status })` filters on the effective status (SQL, `now` parameterised; `list` and `get` take an optional `now`).
  `upcoming` = effective scheduled and not landed. The Passport (`stats`, `mapData`): flown = not cancelled and
  (departed by now OR completed, by hand or by landing); upcoming count = effective scheduled and not yet departed. So a
  flight set to completed by hand counts as flown even when its date is in the future.
- Candidates (migration 009): nullable `flight_status` (cancelled|completed; `auto`/`scheduled`/empty = null). `suggest`
  takes it (REST, MCP), candidate objects carry it, accepting passes it on as the flight's status (an override in the
  accept body wins, `status: auto` clears it). `flights_scan.py` (OpenClaw workspace) sends `flight_status=cancelled`
  for cancelled bookings instead of only writing CANCELLED in notes. Already-filed candidates are not updated (still
  `already_suggested`), so the cancelled Spirit NK 910 candidate filed earlier has no flight_status until filed again.
- Dashboard: chip and drawer show the effective status; the form's Status select is Automatic (shows what it resolves to,
  for example "Automatic (completed)") / Completed / Cancelled; the list filter uses effective values; the queue shows a
  Cancelled/Completed chip. The Passport means the same as before. Not yet checked in a browser (syntax and API tests only).
- Tests: effective-status block in `tests/flights.test.js` (future, past, in the air, boundary, actual_arr, forced,
  filter, revisions, upcoming/stats), candidate flight_status in `flightsHub`, `adminFlights`, `mcpFlights`, admin API in
  `adminFlightsView`. Suite: 306 pass in node:20. Migration 009 runs on the next start (not deployed).

## Next

- Stage 4 rest: the watcher (scheduled `flights_scan.py` run, maybe calendar events), the briefing and digest mention
  upcoming flights.
- Open (small): map labels of airports close together can overlap (LIT/DFW); the Flights list loads the newest 500 only.
- Later: admin-only real delete; trip delete; airlines seed. MCP add/edit are logged only as `mcp_call`.
- Not deployed: local commits only, not pushed, container not restarted. Migrations 007 and 008 run on the
  next start; Flights MCP mode defaults to read.

## Flight data sources (enrichment), stage A backend (2026-11-10)
Plan: workspace memory/projects/personal-hub-flights-sources-plan.md. Local commits only (not pushed, not
deployed); migration 010 runs on the next container start.

**UNVERIFIED: the AeroDataBox field mapping (services/adapters/aerodatabox.js) is built from the official
OpenAPI spec (FlightContract schema; the spec has no example payloads) and hand-made fixtures. It has never
seen a live answer. Stage D checks it against a real key: time format, runwayTime vs revisedTime as "actual",
multi-leg answers, gates/belts. Sources list shows `verified: false` for it until then.**

Done:
- Migration 010: flights.dep_terminal, dep_gate, arr_terminal, arr_gate, baggage_belt, aircraft_reg, est_dep,
  est_arr (UTC ISO), delay_min, locked_fields (JSON array); tables flight_observations, flight_sources (seeded:
  aerodatabox priority 10 cap 80, gmail priority 20 no cap), flight_source_usage (source, 'YYYY-MM', calls).
- The new fields are in flights.FIELDS: editable over REST/admin/MCP, in revisions and answers. Every flight
  answer has `locked_fields` and `source_says_cancelled`. MCP answers still leave out booking_ref.
- Locks: changing an enrichable field by hand (REST/admin PATCH, MCP edit) locks it; `unlock: [fields]` frees
  it (an unlock alone keeps the revision number). Enrichable: flights.ENRICHABLE.
- services/enrich.js: observe, applyObservations (priority merge, lower wins, locked skipped, one revision with
  source 'enrich' and note "From a, b"), refresh (skips: under 6 h since last ok lookup, departed over 30 days,
  both unless force; cap_reached at the monthly cap, default 80 without a settings row; every lookup counts),
  listSources/putSources.
- API: POST /hub/flights/:id/refresh (flights:read + flights:write), POST /hub/flights/:id/observations
  (flights:observe + flights:read; body {source, fields, source_status}), GET/PUT /hub/flights/sources
  (read/write; PUT body {name, enabled?, priority?, monthly_cap?} or {sources: [...]}). Admin: POST
  /admin/api/flights/:id/refresh, GET/PUT /admin/api/flights/sources. MCP: `refresh` (write mode,
  flights:edit), `sources` (read). Audit: flight_refreshed, flight_observed, flight_sources_changed with field
  and source names only. Keys are never shown: `configured` true/false.
- Hub and admin handlers and the MCP registry now accept async handlers/run.
- Tests: tests/flightsEnrich.test.js (22) + MCP case; suite 329 green.

Env (hub .env, recreate the container after adding): AERODATABOX_API_KEY, AERODATABOX_PROVIDER = apimarket
(default, header x-api-market-key, base https://prod.api.market/api/v1/aedbx/aerodatabox) or rapidapi
(X-RapidAPI-Key + X-RapidAPI-Host, base https://aerodatabox.p.rapidapi.com).

Adding an adapter:
1. Create services/adapters/<id>.js exporting { id, label, fields, keyEnv, verified, lookup }.
2. lookup(flight, { fetch, now, env }) is async and never throws: wrap in try/catch, 10 s AbortController.
3. flight has airline_iata, flight_number, dep_local_date, origin_iata, dest_iata, sched_dep, sched_arr.
4. Return { ok, fields, source_status, error }; fields only from flights.ENRICHABLE, times as UTC ISO.
5. Unset key env: return { ok: false, error: 'not_configured' } without calling anything.
6. Short error codes: timeout, rate_limited, unauthorized, not_found, http_<n>, network.
7. Add it to ADAPTERS in services/adapters/index.js (push-only sources go in PUSH_SOURCES).
8. Optionally seed a flight_sources row (priority, monthly_cap) in a migration; else priority 100, cap 80.
9. Fixture tests like tests/flightsEnrich.test.js, injecting fetch.
10. Mark verified: false until checked against a live answer.

Next: stage B dashboard (drawer fields, lock chips with Unlock, Data sources card, Refresh button);
stage C `flights_scan.py --status` pushing Gmail observations (needs a key with flights:read +
flights:observe); stage D live AeroDataBox test. Open: free-tier size and storage terms on API.Market;
observations are never pruned (small, but grows by one row per lookup).
