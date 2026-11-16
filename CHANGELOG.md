# Changelog

Versioned from 1.1.0 on (earlier history is in the git log). Each release is a `vX.Y.Z` tag; deploys name the tag they ran.
Rule: minor for a new feature or view, patch for fixes. One entry per release, newest first.

## 1.3.0 - 2026-11-16

### Added
- Switched-off domains show in the admin: the rail link is dimmed, struck through, with a power glyph and the accessible name "<Domain>, switched off"; the collapsed rail, phone tab bar, More sheet and command palette mark them too.
- A domain page that is off shows a notice above the page header with Turn on and an Agent access select (off / read / write). A domain that is on has a quiet Switch off button (with confirm) in the page header.
- The Overview board, the notice and the rail share one live state, so a change shows everywhere without a reload.

## 1.2.0 - 2026-11-15

### Added
- Graph timeline (`T` or the clock button): a playhead over dated records or recorded links, play/pause/step/speed, a Records | Links switch, undated records shown next to their first visible neighbour. Records grow in beside their neighbours and fade out when scrubbing back; zoom, pan and dragged positions are kept. `?at=YYYY-MM-DD` keeps the playhead in the URL.
- Agent access to the graph: the `links` tool gains `neighbors` (a record's surroundings, 1 or 2 steps, with how each is linked), `hubs` and `unlinked`. Read only, limited to the domains the key can read; nothing is reached through a record the key cannot read (hidden ones are counted, not named).
- Graph payload: nodes carry `t` (one sortable day or null; weekly digest periods resolve to the week's last day), edges carry `created_at`.

## 1.1.0 - 2026-11-15

### Added
- Graph view (`#/graph`): Obsidian-style whole-graph overview (capped at 400 records, domain-clustered, live force simulation that sleeps), Global | Local switch, floating settings panel (filters, groups, display, forces), zoom/pan/drag/hover/select, soft focus with Back, touch and keyboard.
- Link labels on the graph (relation word on the lines, hover/select with direction), Link types filter (`?hiderel=`).
- Edit links mode in the graph (off by default; drag between records, remove with confirm; audited through the existing link endpoints).
- `GET /admin/api/graph/overview`, `/neighborhood`, `/hubs`, `/unlinked`; graph edges carry `note`.

### Fixed
- Linked panel: adding a duplicate link now says "Already linked" (the API answers `unchanged`).
