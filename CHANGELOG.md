# Changelog

Versioned from 1.1.0 on (earlier history is in the git log). Each release is a `vX.Y.Z` tag; deploys name the tag they ran.
Rule: minor for a new feature or view, patch for fixes. One entry per release, newest first.

## 1.1.0 - 2026-11-15

### Added
- Graph view (`#/graph`): Obsidian-style whole-graph overview (capped at 400 records, domain-clustered, live force simulation that sleeps), Global | Local switch, floating settings panel (filters, groups, display, forces), zoom/pan/drag/hover/select, soft focus with Back, touch and keyboard.
- Link labels on the graph (relation word on the lines, hover/select with direction), Link types filter (`?hiderel=`).
- Edit links mode in the graph (off by default; drag between records, remove with confirm; audited through the existing link endpoints).
- `GET /admin/api/graph/overview`, `/neighborhood`, `/hubs`, `/unlinked`; graph edges carry `note`.

### Fixed
- Linked panel: adding a duplicate link now says "Already linked" (the API answers `unchanged`).
