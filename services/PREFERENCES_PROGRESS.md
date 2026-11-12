# Preferences (stage 4 of the briefing / deadlines / preferences plan)

Plain facts about how Atit likes things (seat, call hours, favourite airline), grouped by area. Context for agents, not
attention: no briefing hook. Plan: `workspace/memory/projects/personal-hub-briefing-renewals-plan.md` section 3. Template: deadlines.

## Done
- Migration `012_preferences.sql`: `preferences` (area CHECK of 8, key 1-60, value 1-500, notes <= 300, `removed_at`, UNIQUE
  (area, key)) and `preference_revisions` (rev 1 immutable, restore is a new revision).
- `services/preferences.js`: list, get, getByKey, history, create, update, set (upsert), unset, unsetByKey, restore, stats,
  looksSecret, auditDetail. Registry entry `preferences` (private, db, default on, no briefing hook).
- REST `/hub/preferences`, admin API `/admin/api/preferences`, MCP tool `preferences`, scope text, audit actions, Activity
  chip "Preferences" and sentences.
- Dashboard view `views/preferences.js`, nav item, `g e`, palette action "Add preference", `DOMAIN_HUES.preferences = 'brick'`
  (an existing spare hue; no new colour), icon `preferences` (two sliders), skeleton, `WRITE_WARNING.preferences`.

## API
- Areas: travel, communication, work, food, health, devices, home, other.
- Scopes: `preferences:read` (list, get, history), `preferences:write` (REST create, patch, unset, restore; also needs read),
  `preferences:edit` (MCP set and unset in write mode).
- REST: `GET /hub/preferences` (area, q, removed=true for removed only, limit <= 200, offset; ordered by area then key), `POST /`
  (201, 409 `exists` with the id), `GET /:id[?rev=]`, `GET /:id/history`, `PATCH /:id`, `POST /:id/unset`, `POST /:id/restore
  {rev?}` (no rev = the current revision, which also un-removes). No DELETE. 503 when the domain is off.
- Admin: same paths under `/admin/api/preferences`; `GET /:id` adds `history`; works while the domain is off; errors are
  `{ error, code, field? }`.
- MCP `preferences`: read `list` (area, q, limit), `get` (area + key, or id); write mode + preferences:edit `set` (upsert by
  area and key; notes kept when not sent; a removed one comes back), `unset` (area + key, or id). Results marked as stored data.

## Rules
- Key: trimmed, lowercased, spaces and dashes become underscores, `[a-z0-9_]{1,60}`. Keys with the words password, passcode,
  secret, token, pin, ssn, card(s) (or containing password, passcode, passwd, secret, token) are refused: `secret_like`,
  field `key`.
- Value and notes are refused (`secret_like`, field `value` or `notes`) when they contain 8+ digits (spaces or dashes between
  allowed), `pak_`, `sk-` (at a word start), `AKIA` + 4 letters or digits, or a 24+ character token without spaces that mixes
  letters and digits. Email addresses are exempt. Message ends with "Keep passwords, numbers and keys in the vault, not here."
  Dates like 2026-11-11 also trip the digit rule (8 digits); say "Nov 11" instead.
- Unset stamps `removed_at`, keeps history, hides from lists. `create`/`set` on a removed key revives the same row (revision
  note "Added again after it was removed"). Restore always un-removes.
- Audit rows `preference_set` (create), `_updated`, `_unset`, `_restored`: id, area, key only. MCP writes only leave `mcp_call`.

## Dashboard
- `#/preferences` (grouped list, `?q=`), `?removed=1` (Removed toggle, each with Restore), `#/preferences/<id>` (drawer: edit,
  history with Restore, Remove with confirm), `?new=1` (Add drawer, used by the palette). Empty state has three example chips
  that prefill the Add drawer. The API's error appears under the field it names and that field is focused. Key shows with
  spaces. Hint under the value: "Plain facts only: no passwords, numbers or keys."
- Browser checks (scratch hub, `tmp/hub-flights-e2e/`): `SEED=preferences-seed.js ./reset.sh` then `node run-preferences.mjs`:
  25 checks, 25 pass.

## Checks
- Whole jest suite (30 suites): 497 tests green (baseline 454, +43: preferences 20, preferencesHub 9, mcpPreferences 8,
  adminPreferences 6; existing domain-list tests updated).
- Open: deploy is not done (local commits only); no briefing hook by design; hub_overview already counts records via stats.
