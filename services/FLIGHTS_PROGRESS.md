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

AeroDataBox mapping: checked against live answers on 2026-11-11 (see Stage D below); the adapter reports `verified: true`.

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

## Flight data sources (enrichment), stage B dashboard (2026-11-10)
Local commits only (not pushed, not deployed). No server change: stage A's admin API is used as is.

- New module `routes/admin/public/flightlive.js` (plain browser JS, no build step); `views/flights.js` imports it.
- Drawer (`#/flights/12`): top section **Live details**: delay chip (`+25 min`, `on time`, `N min early`), departure and
  arrival columns (scheduled, estimated, actual in airport-local time, terminal, gate, baggage belt), aircraft type and
  registration, and the "A data source reports this flight as cancelled. Set the status yourself if it is true." hint (a
  chip plus the sentence; the status is never changed by it). Under it the **Refresh from sources** button (`POST
  /admin/api/flights/:id/refresh`, a Force checkbox or Shift sends `force: true`) and a per-source result list in plain
  words (updated: fields, nothing new, skipped looked up recently, skipped over 30 days, cap reached, not configured,
  failed: code); the flight reloads afterwards. Deviation from the brief: the button is disabled only when no pull source
  is switched on (hint: "No source is switched on..."); with sources on but no key it stays clickable and says "No
  source has a key yet, so a refresh will only say so", so the "not configured" result can be seen.
- Edit form: new collapsible "Live details by hand" (estimated times, terminals, gates, belt, registration; local time
  for the estimated times) plus the existing Actual times and Aircraft. A field in `locked_fields` gets a lock chip
  ("Edited by hand", "Sources will not overwrite it.") and an Unlock button (`PATCH {unlock:[field]}`, asks first when
  the form has unsaved edits). One line under the section: "Fields you edit here are locked so sources do not overwrite
  them." Delay is read-only. Only changed fields are sent, as before. Compare view lists the live fields when set.
- Flights tab: a row shows "Terminal B, gate B12" (small) under the route and a delay chip next to the status chip,
  only when known. New **Data sources** card below Home airport: per source name, Configured / Not configured chip (never
  a key), "Not checked against live data yet" chip while `verified` is false, one-line hint, on/off switch, priority
  number with up/down buttons (renumbered 10, 20, ...; lower wins), monthly cap input (empty = no cap), "N / cap calls
  this month" with a thin bar (Gmail: "Not counted"), the sentence that refresh is on demand only, **Save sources**
  (`PUT /admin/api/flights/sources`, toast, error text, unsaved-changes note).
- Not done: palette action "Refresh flight from sources" (optional, skipped); Overview untouched.
- CSS: `.live-*`, `.lock-*`, `.refresh-*`, `.sources-card`, `.source-*`, `.usage-*` in style.css; icon `lock` in ui.js.
- Browser checks (scratch hub, port 3999, scripts in the OpenClaw workspace `tmp/hub-flights-e2e/`):
  `./reset.sh` then `docker run --rm -v /tmp/pa-flights:/app -v $PWD:/e2e -v /tmp/pa-scratch-data:/tmp/pa-scratch-data
  -e HUB_DATA_DIR=/tmp/pa-scratch-data -w /app node:20 node /e2e/sources-seed.js` (three invented future flights: one
  with AeroDataBox observations, one Gmail "cancelled", one plain; ids in `sources-ids.json`) then `node
  run-sources.mjs` (18 checks: live details and delay chip, cancelled hint, Refresh "not configured", lock chip and
  Unlock, list row, Data sources card, switch/priority/cap persistence, Refresh disabled when every source is off, dark
  mode, 390 px). The old flow stays `./reset.sh; MORE="docker run --rm -v /tmp/pa-flights:/app -v $PWD:/e2e -v
  /tmp/pa-scratch-data:/tmp/pa-scratch-data -e HUB_DATA_DIR=/tmp/pa-scratch-data -w /app node:20 node /e2e/more.js" node
  run.mjs` (36 checks). Reseed with reset.sh between the two. Scratch container: `docker rm -f pa-scratch` when done.
- Suite: 329 pass in node:20 (no test added: no admin behaviour changed; the "every admin module parses" test covers
  flightlive.js).

## Flight data sources (enrichment), stage C Gmail status source (2026-11-10)
Script in the OpenClaw workspace: `scripts/flights_status.py` (python3 -I, stdlib, reuses flights_scan.py's gog/fetch/
date helpers). Gmail READ-ONLY through gog exactly like flights_scan.py. No hub code changed.

- Run: `python3 -I scripts/flights_status.py --dry-run` (prints `<AIRLINE> <NUMBER> <date> <field names>`, pushes
  nothing, keeps state), `python3 -I scripts/flights_status.py` (new mails only), `--rescan` (re-read all; still pushes
  only what differs from the last push), `--days N` (flights departed in the last N days, default 30, plus every
  upcoming one), `--max-threads N`. Key: `flights_observe_key` in ~/.config/personal-hub/config.json
  (flights:read + flights:observe). State: ~/.config/personal-hub/flights_status_state.json (message ids, merged
  per-flight values, a signature of the last push per flight; no booking refs, no mail text).
- Flights from GET /hub/flights/upcoming + GET /hub/flights (dep_local_date in the window). Mails: airline senders with
  status words in the subject (delay, gate, cancel, rescheduled, changed, check-in, boarding, departing, travel alert),
  plus travel-site boarding-pass/gate/delay subjects, from 330 days before the earliest covered flight. Upgrade offers,
  SeatBid and similar marketing are skipped by subject.
- Matching: one mail, at most one flight: airline + number + airport-local date from the mail; number + the mail's date
  window when the mail gives no date (Frontier gate change); booking ref (in memory only) for mails with no flight
  number (Frontier "departing from gate"; cancellations, then up to 400 days ahead).
- Push: one observation per flight carrying everything Gmail knows (the hub keeps only the newest observation per
  source); per field the newest mail wins; est_dep/est_arr in UTC (converted with the hub's dep_tz/arr_tz), delay_min =
  est_dep - sched_dep; an estimate equal to the schedule is not sent and clears an older mail's estimate. source_status:
  newest of cancelled/delayed/schedule_change/gate_change, else boarding/check_in. Check-in reminders without a gate are
  not pushed.
- Formats: Frontier delay ("new estimated departure time is ..."), gate change ("updated to Gate X"), "departing from
  gate X" (+ "at Terminal X"), Important Travel Information (delay); American delay/rebook blocks (times, Terminal:,
  Gate: both ends); Korean Air delay/itinerary change (previous and new side by side, the new half is read; 00:01
  placeholder times ignored); Cathay reschedule (labelled departure/arrival) and "flight details changed" (times before
  the code, "+2" day offset; original itinerary ignored); Spirit cancellation (booking ref). Delta check-in mails carry
  no gate/terminal (airports by name). United, Southwest and Qatar: no status mails in the mailbox, no patterns.
- Run 2026-11-10 (30 days): 8 flights, 49 status-like mails scanned, 4 matched (Cathay), 3 observations pushed (CX 891,
  603, 640: schedule_change only; the hub's schedule already matches the newest mails, so no time fields), 42 outside
  the window, 0 unmatched. Re-run and --rescan push nothing. A wide dry run (--days 900) matched 27 mails to 17 flights
  (F9 16 mails, CX 4, KE 2, AA 2, NK 1) and was spot-checked against the mails (KE 1431 +15, AA 280 terminals/gates,
  F9 3293 +40 and newest gate, CX 640 cleared by the newer reschedule). Old flights were not pushed.
- Lock check on a scratch hub (invented flight, dep_gate edited by hand): a Gmail push with dep_gate, est_dep and
  delay_min merged est_dep/delay_min and left dep_gate as edited. No live flight has locked fields.
- Gaps: not scheduled (run by hand or add a cron later); a field dropped from a later push stays on the flight (the merge
  only writes values it has); a mail processed while its flight was not in the hub is not re-read without --rescan;
  five Frontier July mails for a friend's flights (not in the hub) stay unmatched; check-in mails give no gates for any
  airline seen; no baggage belt in any mail seen.

## Stage D: live check of AeroDataBox (2026-11-11)
RapidAPI provider, key in the hub .env (container recreated). Two forced refreshes through the admin API, 2 calls of the 80 monthly cap:
- F9 3294 DEN-ATL 2026-08-14 (past): actual_dep/actual_arr, est times, delay 44 min, arrival terminal, aircraft type (A320 NEO) and registration. Times convert correctly (UTC from the provider's local times; the flight ran 2 h 37 min, as expected).
- CX 891 DFW-HKG 2026-12-17 (future, 36 days out): est_arr (+117 min), departure and arrival terminals, aircraft type (A350-1000). No est_dep, no gate yet.
Not seen live yet: gates, baggage belt, multi-leg answers, a cancelled flight, dateLocalRole=Departure vs Both. Watch: for a flight weeks away the provider's revised arrival can show a large 'delay' that is really a schedule revision; consider ignoring est_*/delay_min until about 72 h before departure.

## Passport stage 1: Punctuality, map view switcher, Heat (2026-11-11)

Done (local commits, not pushed or deployed): delay statistics, the Punctuality section, `mapviews.js` with Flat, a Globe
placeholder and Heat, and label collision avoidance on the Flat map.

- **`stats().delays`** (REST, admin API, MCP `stats` carry it; existing keys unchanged). Over flown, non-cancelled flights
  (year filter applies): `measured` (flights with a computable arrival delay), `of` (flown count), `on_time_rate` (share
  within 15 min of schedule, 0..1, 3 decimals, null when nothing measured), `avg_delay_min` (early counts negative),
  `total_delay_min` (positive delays only), `early_count`, `late_count` (> 15 min), `worst` ({id, route, airline_iata,
  flight_number, date, delay_min}, null when nothing late), `by_airline` (top 5 by measured, ties by code; airline, name,
  measured, on_time_rate, avg_delay_min), `by_year`, `cancelled` and `cancelled_rate` (over flown + cancelled, the year filter
  applies). Arrival delay = actual_arr - sched_arr, else the `delay_min` column, else actual_dep - sched_dep (minutes).
  Tests: 9 in `tests/flights.test.js` (describe "stats: delays"), 1 in `tests/adminFlightsView.test.js`.
- **Passport tab**: "Punctuality" panel under the tiles: four tiles (On-time rate with "n of m flights measured", Average
  delay, Total time lost, Worst delay linking to the flight), "By airline" bars, notes ("Actual times known for 6 of 7
  flights; older flights have none.", cancelled share, early count). Empty state when measured = 0. Two columns at <= 1100 px.
- **`ui.js` `segmented({ pressed: true })`** renders plain buttons with `aria-pressed` in a `role="group"` (the km/miles toggle
  keeps radios). The admin CSP forbids `style=` attributes: styling goes through classes, SVG presentation attributes or `el.style`.
- **`routes/admin/public/mapviews.js`** (contract for the globe run):
  - A view is `(container, mapData, ctx) => { destroy() }`. It appends into `container` (already emptied) and must put its own
    help line there. `destroy()` removes observers, listeners and timers; the Passport calls it before mounting another view and
    through `ctx.onCleanup` when the page is left. A view that throws is replaced by a short message.
  - `mapData` is `stats.map`: `{ airports: [{ iata, city, lat, lon, visits }], routes: [{ a, b, flights }] }`, only airports the
    hub knows, airports sorted by IATA, routes by flights desc. No flight numbers, dates or booking refs. `ctx` = `{ home, unit,
    year, isDark() }` (`isDark` reads `data-theme` on `<html>`; colours come from CSS variables, `--teal` is the accent).
  - Registry: `MAP_VIEWS = { flat, globe, heat }` (id -> `{ label, render, soon }`). The globe run replaces the placeholder with
    `registerMapView('globe', 'Globe', globeView)` (or edits the table) and drops `soon`, which only dims the segmented button.
    Choice is remembered in localStorage `hub-flights-mapview` (`getMapView` / `setMapView`; unknown ids fall back to flat).
    `mountMapView(host, id, map, ctx)` is what the Passport calls. Exported helpers: `arcPaths`, `VIEW` (viewBox 0 6 360 142),
    `placeLabels`.
  - Flat = the old route map, unchanged, plus greedy labels: busiest first (home first), each tries above, below, right, left of
    its dot and is hidden (`.is-hidden`) when all four overlap; re-laid out by a ResizeObserver.
  - Heat: every airport is a radial-gradient glow (`#heat-glow`, teal), level = min(1, sqrt(visits / max(maxVisits, 4))), radius =
    3 + 10 * level map units (cap 13), glow opacity .35 + .55 * level; every route a wide (3.5 px) stroke at opacity
    min(.4, .14 + .05 * (flights - 1)) with `mix-blend-mode` multiply (light) / screen (dark) on routes and glows so overlaps
    accumulate. Hover or keyboard focus on an invisible hit circle (`.heat-hit`, tabindex 0) shows the `.map-tip` tooltip
    "DFW · Dallas · 3 visits". Legend "Brighter = visited more". Respects the year switcher (the map data is already filtered);
    the unit toggle does not affect it.
- Browser checks on the scratch hub (scripts in the OpenClaw workspace `tmp/hub-flights-e2e/`: `passport-seed.js` seeds invented
  flights with actual times and writes the independently computed expected numbers, `run-passport.mjs [main|plain]`; `reset.sh`
  takes `SEED=passport-seed.js`): 17 checks on the seeded hub (tiles, worst-delay link, 2025 filter, API shape, switcher, label
  overlap at 1280 and 390 px, Heat persistence across reload, glows per airport, tooltip hover and focus, blend modes in light and
  dark, Globe placeholder, km/miles still works, dark mode, 390 px layout, no console errors), 3 on a hub without actual times
  (empty state). The older flows still pass (36 and 18). Screenshots (3, JPEG 900 px): `workspace/tmp/hub-flights-shots/passport-*.jpg`.
- Scratch-hub note: rsync the repo with `--exclude .env`, otherwise the scratch copy carries the real AeroDataBox key and the
  "not configured" checks of `run-sources.mjs` (5 and 10) fail. With the `.env` out, `run-sources.mjs` gives 14 of 18: checks
  1, 3, 9 and 15 fail on the commit before this stage as well, because their seeded flights are in December and estimated
  times are only trusted within 72 h of departure (the stage D rule), so the seed needs flights dated within 72 h of "now".

## Passport stage 2: the Globe (2026-11-11)

Done (local commits, not pushed or deployed): the Globe placeholder is replaced by a real view (`MAP_VIEWS.globe` =
`globeView` in `mapviews.js`, same contract as Flat and Heat; `globePlaceholder` is gone, nothing is `soon` any more).

- **Data**: `routes/admin/public/globedata.js` (12.7 KB, 113 rings, about 2300 points) built by `scripts/globe-build.js` from
  Natural Earth 110m land (public domain; the curl line is in the script header). RDP simplification at 0.25 degree, coordinates
  in half-degree integers, one string per ring (first point absolute, then deltas), decoded by `landRings()`. Antarctica is
  left out (rings entirely south of 60 S). Every ring is turned counter-clockwise at build time; the one hole (the Caspian) is
  `GLOBE_LAKES`, drawn on top in the ocean colour. `worldmap.js` (Flat, Heat) is unchanged.
- **Geometry** (`routes/admin/public/globe.js`, pure, no DOM): `project(lon, lat, rot)` (orthographic, rot = the centre point
  {lon, lat}, returns [x, y, z], y up, z toward the viewer), `isFront`, `greatCircle(a, b, n)` (slerp), `arcLift` (bump of
  0.03..0.2 radii by route length), `routeRuns` (48 lifted samples, a lifted point is hidden only when behind the sphere and
  inside the disc), `lineRuns` (graticule, cut exactly at the horizon), `clipRing`, `midpoint`, `pathData`, clamps.
  **Clipping**: a ring's vertices are projected; walking from a hidden vertex, the ring is cut into visible runs that start and
  end where an edge's chord meets the plane z = 0 (normalised onto the horizon circle). Since rings are counter-clockwise and
  the front hemisphere keeps orientation, land continues counter-clockwise along the horizon after a run leaves: each run is
  joined to the run whose entry is nearest counter-clockwise from its exit, with horizon points every 6 degrees, until the
  polygon closes. Fully visible rings pass through; fully hidden ones are dropped. A full clip of all land takes under 1 ms.
- **View**: SVG 500 x 500, radius 205 x zoom (so the highest arcs fit at 1x). Layers: ocean circle, 30-degree graticule (dashed,
  reuses `.graticule`), land (fill only: no stroke, so the antimeridian splits and the horizon do not show), lake, rim, route
  arcs (`.arc arc-weak/mid/strong` like Flat), airport dots (radius 3..7.8 by sqrt of visits, home in the accent colour,
  back-facing ones `.is-back` = display none), invisible focusable hit circles with the `.map-tip` tooltip "LIT · Little Rock
  · 3 visits" on hover and focus (follows the dot while turning). Labels: up to 12 HTML labels with `placeLabels` (now takes
  cached sizes and an `off` flag, so it can run every frame without layout reads; Flat behaves as before); labels near the limb
  (z < 0.15) are hidden. Colours from CSS (`.globe-ocean/.globe-lake` = teal 9% over surface-2, land muted 28%), so dark and
  light themes follow the page.
- **Controls**: drag (pointer events, mouse, pen, touch; `touch-action: none` on the SVG only) turns it, vertical tilt clamped
  to +/-80; inertia after release (friction 0.92 per 16 ms); pinch and wheel zoom, buttons − / + (x1.2), clamp 0.8x..2.5x;
  Reset button, double-click and the Home key recentre on the home airport (settings `home_airport` if it is on the map, else
  the most visited) at 1x; arrow keys turn by 10 degrees when the globe has focus, +/- zoom (tabindex 0, role img,
  aria-label "Globe of N routes and M airports. ...", 3 px focus ring). Slow auto-spin (6 degrees/s eastward) until any
  interaction; the Spin button (aria-pressed) toggles it. `prefers-reduced-motion: reduce`: no auto-spin, no inertia (Spin can
  still be switched on by hand). Initial centre: the remembered rotation, else the home airport, else the visit-weighted
  midpoint of the airports.
- **Frames**: requestAnimationFrame with a dirty flag; frames only while spinning, coasting, or once per change; none while idle.
  Rotation, zoom and spin state live in a module-level memo, so the year switcher (which re-renders the Passport) and switching
  views keep the view; a reload starts fresh. `destroy()` cancels the pending frame, disconnects the ResizeObserver and removes
  all listeners. The wrap exposes `data-lon/-lat/-zoom/-spin` for tests.
- **Tests**: `tests/globe.test.js` (6 tests, runs globe.js in a child node process since jest is CommonJS: projection, great
  circles across the date line, clipping of synthetic rings and of all land from 60 viewpoints, runs, clamps); both new files
  are in the "every admin module parses" list. Jest 347 (was 341).
- **Browser checks**: `tmp/hub-flights-e2e/run-globe.mjs` (scratch hub, `SEED=passport-seed.js sh reset.sh`): 19 checks, all
  pass: render (sphere, land, 6 dots, 6 arcs), a11y, land inside the disc, auto-spin, hover tooltip, drag moves a dot, spin stops
  on drag, inertia then zero idle frames, arrow keys and lat clamp, focus ring, zoom buttons/keys/wheel and clamps, Reset /
  double-click / Home on LIT, focus tooltip, labels without overlaps or back labels, year switch keeps rotation and zoom, no
  frames after switching to Flat or leaving the page, dark palette, reduced motion (no spin, no idle frames, no inertia), 390 px
  with a real CDP touch drag (no horizontal scroll), no console errors. A requestAnimationFrame wrapper counts frames.
  `run-passport.mjs` check 15 now expects the globe instead of the placeholder (main 17/17, plain 3/3). `run-sources.mjs` 14/18
  (the known 4). `run.mjs` gives 34/36 on this code and 33-34/36 on the stage 1 commit: checks 25 and 26 (Accept all / Added
  view) fail on both today, and 29-34 are occasionally flaky (a drawer left open), not caused by the globe.
  Screenshots: `workspace/tmp/hub-flights-shots/globe-light.jpg`, `globe-dark.jpg`, `globe-mobile.jpg`.
- **Known limits**: a ring that contained the whole visible hemisphere with every vertex hidden would be dropped (no 110m land
  ring is that large); tiny slivers along the limb can have reversed winding (area < 1e-3, invisible); land detail is 110m
  (small islands missing, coastlines coarse at 2.5x); the wheel zooms the globe instead of scrolling the page while the pointer
  is over it; the globe SVG is role img with focusable airport circles inside (as Heat does); Reset jumps rather than animates.
