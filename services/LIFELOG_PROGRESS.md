# Lifelog domain: progress

Plan: `~/.openclaw/workspace/memory/projects/personal-hub-lifelog-plan.md` (decisions 1-10, stages A-C).

## Stage A (backend core): done, local commits only, not deployed
- Migration `018_lifelog.sql`: `lifelog_observations` (append-only), `lifelog_forget_guard`, `lifelog_episodes`,
  `lifelog_episode_revisions`, `lifelog_episode_observations` (cascade on both sides), FTS5 tables
  `lifelog_observations_fts` (text, tags, kind, source) and `lifelog_episodes_fts` (title, detail, kind), both with
  external content and sync triggers. All statements use IF NOT EXISTS.
- Append-only: BEFORE UPDATE always aborts; BEFORE DELETE aborts unless `lifelog_forget_guard` has a row. Only
  `lifelog.forget` writes that row, inside the same transaction as the deletes, and removes it again. The FTS
  delete trigger runs AFTER the guarded delete, so external content works with the guard (tested).
- `services/lifelog.js`: push (1..100, each item checked alone, one transaction, dedupe per source skipped and
  counted, `{ accepted, duplicates, rejected: [{index, code, error}], ids, sources }`), addObservation (dashboard
  note), listObservations, day, episodes CRUD with revisions/restore, link/unlink, sources, stats, forgetPreview,
  forget. Times are stored as `toISOString()`; a bare date in from/to means that whole day in the hub zone.
- Scopes: `lifelog:push`, `lifelog:read`, `lifelog:agent-write` (for stage B), `lifelog:api-write`.
  `apiKeys.SENSITIVE_DOMAINS = ['lifelog']`: `*` does not grant lifelog; `lifelog:*` and named scopes do. No key
  was changed. The Agent access view's own hasScope copy follows the same rule. Keys catalogue: lifelog entry and
  the `*` text says it excludes Lifelog.
- REST `/hub/lifelog` (push, observations, day, episodes, history, create, patch, restore, link, unlink). No DELETE,
  no forget. Admin API `/admin/api/lifelog/...` including forget-preview and `DELETE /lifelog/observations`
  (confirm, optional pre-delete backup through routes/lib/remove.js).
- Audit: `lifelog_pushed` (one row per batch: sources, accepted, duplicates, rejected count), `lifelog_observation_added`,
  `lifelog_episode_created/updated/restored/linked/unlinked`, `lifelog_forgotten` (from, to, source, counts).
  Activity filter `lifelog` and labels added.
- Setting `lifelog.retention_days` (1..36500, default null = forever) in services/settings.js only; no UI, no job.
- Domain registry entry `lifelog` (private, stats hook, no briefing, no MCP tool yet).

## Where stage A differs from the plan / brief
- Audit rows for episodes carry id, kind, revision and field names but NOT the title (titles like "ate biryani"
  are content too); trips audit titles, lifelog does not.
- Body limit: the `/hub` router's 256 KB JSON limit never applies, because app.js parses JSON app-wide with a
  10 MB limit first (pre-existing, unchanged). The push route has its own 1 MB cap (413 too_large in plain words);
  a full batch of 100 x 2000 characters + 2 KB data fits. More than 100 items is a 413 too_many.
- Place resolution: a places id, a place label (ignoring case) or a zone rule the places resolver calls exact.
  Street-text matches are not used (free text like "kitchen" is not an address).
- Registry sensitivity stays 'private' (the registry has only public/private); the sensitivity lives in the scope rule.
- `forget` with a source deletes only episodes whose own source is that label (and that lie fully inside the range).
- Extra audit actions `lifelog_episode_linked` / `lifelog_episode_unlinked` (link changes are not revisions).

## Stage B (done): MCP tool `lifelog`
- services/mcp/domains/lifelog.js (read scope lifelog:read, untrusted preamble). Reads: day (episodes + observation
  counts by source/kind, first/last; no raw lines; date defaults to today in the hub zone), episodes, observations
  (only action with raw lines; newest first, limit <= 50 default 20), search (FTS over both, limit <= 20, results
  carry `type`), sources. Text/detail clipped to 300 characters with textTruncated/detailTruncated; observation
  `data` and `dedupe` are left out. Writes (lifelog:agent-write, mcp_mode write): add_episode, edit_episode,
  add_observation (source is always the key's name; a `source` argument is ignored), link, unlink. No forget,
  delete, restore or batch push over MCP. Service errors pass through the registry's HubError mapping.
- `*` keys do not see the tool (apiKeys scope rule); lifelog:read and lifelog:* do. Overview shows the tool
  automatically (hasTool); WRITE_WARNING.lifelog added in routes/admin/public/views/overview.js.
- Deviation: add_episode takes an optional `source` limited to manual (default) or derived, so the later
  derivation job can mark its episodes; any other value is refused.
- Tests: tests/mcpLifelog.test.js. No existing test needed changing ('everything' key lists stay without lifelog).

## Next
- Stage C: dashboard page.
