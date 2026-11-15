# Entities domain: progress

Plan: `~/.openclaw/workspace/memory/projects/personal-hub-search-links-plan.md` (stage 4). Local commits only.

## Done
- Migration `022_entities.sql`: `entities` (kind, name, aliases JSON, notes, unique kind + name, case-insensitive),
  `entity_revisions`, trigger `links_gone_entities`.
- `services/entities.js`: list (kind, q), get (+link_count), find (name or alias, any case), history, create, update
  (partial, unchanged detection), restore, stats, removalPreview/remove (confirm: true). Audit detail = id, kind, rev,
  field names only.
- `services/links.js` DESCRIBE has `entities` inline (title = name, kind), so it is always registered (no require cycle).
- Registry entry `entities` (private), scopes entities:read / agent-write / api-write in the Keys catalogue.
- REST `/hub/entities` (no DELETE), MCP tool `entities` (list, get with links, find; add, edit), admin API with delete.
- Search adapter + embeddings source (name, aliases, kind, notes). Palette entries, nav (Data group), `g n`, `.hue-sky`.
- Dashboard `views/entities.js`: list with kind chips and search, New entity drawer, entity drawer (edit, Linked, history, delete).

## Next
- Review, deploy, push (not done here).

## Verified
- Full jest: 63 suites, 793 tests passed (was 59 / 773). New: entities, entitiesHub, mcpEntities, adminEntities.
- Changed on purpose: tests/admin.test.js, tests/digests.test.js, tests/mcp.test.js (domain and tool lists now include
  `entities`); route snapshot regenerated (only /admin/api/entities and /hub/entities routes added).
- e2e: `node tests/e2e/run-all.mjs entities` 11 checks passed.
