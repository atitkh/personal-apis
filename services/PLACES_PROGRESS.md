# Places domain: progress

Plan: `memory/projects/personal-hub-places-plan.md` in the OpenClaw workspace. The model and the matching
rules are described at the top of `services/places.js`; this file says what exists and what comes next.

## Done (stage 1: storage, service, REST, importer)

- `db/migrations/005_places.sql`: `places`, `place_revisions`, `place_rules`, `place_suggestions`.
- `services/places.js`: list, get (rules + revision count, or an old revision), history, create, update,
  restore, remove, addRule / updateRule / removeRule, resolve, suggestions, stats. Every change to a place
  or to one of its rules stores a whole-place revision; restore brings rules back under their old ids.
- `resolve({ geocode, lat, lon, zone, suggest })`: deterministic, no model. Street = substring of the
  geocode in any case; zone = Home Assistant zone id; radius = haversine metres. A matching exclude rule
  takes its place out. Zone or radius beats street, then the longer street text, then priority, then the
  smaller circle, then the older place. Answer: `match`, `matched_rule`, `confidence` (exact | street),
  `alternatives`, `excluded`; nothing matched is `{ match: null }`. A pending suggestion is filed only
  with `suggest: true`.
- `services/errors.js`: `HubError`, the shared base of `DigestError` and `PlaceError` (no behaviour change).
- `services/domains.js`: registry entry `places` (private, db, stats). On/off and `mcp_mode` work as for
  the other domains; there is no agent tool yet, so the MCP mode has nothing to switch.
- `routes/hub/places.js`, mounted at `/hub/places`:
  - `places:read`: `GET /`, `GET /:id` (`?rev=`), `GET /:id/history`, `POST /resolve`, `GET /suggestions`
  - `places:write`: `POST /`, `PATCH /:id`, `POST /:id/restore`, `DELETE /:id`, `POST /:id/rules`,
    `PATCH /:id/rules/:ruleId`, `DELETE /:id/rules/:ruleId`
  - `places:suggest` (or write): `POST /resolve` with `suggest: true`. This scope is not in the plan; it was
    added so that a read-only key cannot write to the suggestions queue. Drop it in the route and in
    `routes/admin/public/scopes.js` if read keys should be allowed to file suggestions.
  - Domain off = 503 `domain_disabled`. Resolve is a POST so that addresses stay out of the access log.
  - Audit: `place_created`, `place_updated`, `place_restored`, `place_deleted`, `place_rule_added`,
    `place_rule_updated`, `place_rule_removed`, with id, label, rev, rule id and rule type only. Rule
    values and addresses are never logged (`places.auditDetail`).
- `scripts/places-import.js <table.md | -> [--dry-run] [--force] [--exclude "Label=text"]`: imports a
  markdown table (Match, Label, Notes). Same label = one place with several street rules; safe to repeat;
  "NOT that place" notes are printed for a person to turn into exclude rules.
- Tests: `tests/places.test.js` (service, resolve, importer on an invented table) and
  `tests/placesHub.test.js` (scopes, HTTP, audit, domain switch). No real address appears in the repo.

## Done (stage 2: agent tool, suggestions queue, admin API)

- `services/mcp/domains/places.js`: one tool `places`, marked as stored data (DATA_NOTE). What a key sees is
  filtered per scope and per `mcp_mode` (off hides it, read is the default, write is the admin's switch):
  - read (`places:read`): `list` (kind, limit 1-50; notes cut at 300 chars), `get` (id), `resolve`
    (geocode / lat+lon / zone; answers label, kind, notes, confidence, `matched_rule_type`, alternative and
    excluded labels; never the street text; never files a suggestion).
  - write mode: `suggest` (`places:suggest`; resolve that files an unmatched street), `add` and `edit`
    (new scope `places:edit`). `edit` takes label/kind/notes plus `add_rules`, `update_rules`,
    `remove_rule_ids` in one transaction; each step is its own revision. No delete, restore, accept or
    dismiss over MCP. The REST scope `places:write` grants no MCP write action.
  - `mcp_call` audit rows stay tool/action/ok only (tested with canary streets and coordinates).
  - hub_overview lists places with its record count and this key's actions; Agent access lists them per key.
- Suggestions: migration 006 (`decided_at`, `decided_by`); `acceptSuggestion` ({place_id} adds a street
  rule, or {label, kind, notes} creates a place with source suggested), `dismissSuggestion`,
  `suggestionCounts`. Dismissed rows stay dismissed (a sighting only bumps count); a street a place now
  claims files nothing. REST (`places:write`): `POST /hub/places/suggestions/:id/accept|dismiss`;
  `GET /hub/places/suggestions?status=pending|accepted|dismissed|all` now also returns `counts`.
  Audit `place_suggestion_accepted` / `place_suggestion_dismissed` with ids, label, rev, rule type only.
- Admin API (session + X-Requested-With, errors `{ error, code }`, works while the domain is off, audited as
  `admin`): `GET /admin/api/places` (rules, ruleCount, revisions, lastChange, suggestion counts),
  `GET /places/:id` (`?rev=`, with history), `POST /places`, `PATCH|DELETE /places/:id`,
  `POST /places/:id/restore`, `POST /places/:id/rules`, `PATCH|DELETE /places/:id/rules/:ruleId`,
  `POST /places/resolve` (never files), `GET /places/suggestions`, `POST /places/suggestions/:id/accept|dismiss`.
  The activity filter `places` includes the two suggestion actions.
- Scopes: `places:edit` in `routes/admin/public/scopes.js` (key creation accepts any `domain:action`).
- Tests: `tests/mcpPlaces.test.js`, `tests/adminPlaces.test.js`, more in `places.test.js` and
  `placesHub.test.js`; 217 pass in node:20. End-to-end on a scratch hub (copy of a backup, throwaway
  container): read key sees list/get/resolve in both modes, write key gains suggest/add/edit after the admin
  switch; suggest, accept via admin API, resolve to the new place, edit; audit had no street or coordinate.

## Done (stage 3: dashboard)

- Places view in the admin app (`routes/admin/public/views/places.js`): table, drawer with rules, history and
  restore, Check a location, Needs a name queue; plum channel and queue count on the overview. Details and
  verification in `routes/admin/PROGRESS.md` (places view). No production data touched.

## Next

1. Import the real table into production (a person runs it; `--dry-run` first, then the exclude rules
   the manual step lists). Nothing in stage 2 touched production data.
2. Stage 4: daily-digest job resolves and suggests through the hub (`places_resolve.py` via
   `hub_client.mcp_call`; key needs places:read + places:suggest and Places in write mode for suggest),
   Workshop proposal for the skill, then retire `known-places.md`.
3. Open: an MCP `edit` with several steps makes several revisions (restore is per step); MCP add/edit are
   logged only as `mcp_call` (the revision keeps the key name), like digests edit.

## How to add a domain (what places needed)

1. Migration `db/migrations/NNN_<name>.sql` (applied in filename order at start).
2. `services/<name>.js`: plain functions taking the db connection; throw a subclass of `HubError`
   (status, code, message) for anything the caller did wrong; export `stats(db)`.
3. Registry entry in `services/domains.js` (title, sensitivity, storage, defaultEnabled, stats).
4. Routes in `routes/hub/<name>.js` as `module.exports = (handle) => router`, each route with
   `requireScope('<name>:read|write')` and `requireDomain('<name>')`; mount it in `routes/hub/hub.js`.
5. Scopes with plain-language text in `routes/admin/public/scopes.js`; audit action names in the
   activity filter list in `routes/admin/admin.js`.
6. Tests that pin the domain list (`tests/admin.test.js`, `tests/digests.test.js`) need the new name.
7. Optional: an agent tool in `services/mcp/domains/<name>.js` (the registry picks it up by domain name).
