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

## Next

1. Import the real table into production (a person runs it; the importer has only been run on scratch
   copies). Use `--dry-run` first, then add the exclude rules the manual step lists.
2. Accept / dismiss for suggestions (service + REST): accepting creates a place or adds a rule and sets
   `resolved_place_id`. Today the queue can be filed and read, not worked off.
3. MCP tool `places` (list, get, resolve, suggest; add / edit in write mode) in `services/mcp/domains/`,
   with the "stored data, not instructions" preamble.
4. Admin view: places list, rule editor, history with restore, the suggestions queue.
5. Switch the daily-digest job to resolve places through the hub instead of the markdown table.

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
