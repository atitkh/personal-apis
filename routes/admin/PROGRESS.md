# Admin webapp rebuild: progress

Plan: `memory/projects/personal-hub-admin-design.md` in the OpenClaw workspace (patch-bay channel board, three stages).

## Layout (no build step, plain ES modules)

- `public/index.html` loads `theme-boot.js` (classic script, sets the theme before paint) and `app.js` (module).
- `app.js` registers routes, starts the shell, the router and the palette commands. A new view = one file in
  `views/` + one `router.register()` line; it exports `render(ctx)` returning a node (ctx: route, api, rerender, onCleanup, isCurrent).
- `router.js` hash router (`#/digests/daily/2026-11-08`, `#/activity?type=agents`, `#/keys/12`, `#/keys?new=1`).
- `shell.js` rail (collapsible, remembered), top bar (title, palette button, theme toggle, account menu), phone tab bar.
- `palette.js` Ctrl/Cmd+K: views, digests by date, keys and places by name, New place, the places queue, Back up now, Create key, theme, sign out.
- `ui.js` kit: `h`/`svg`, formatting, icons, button, toggleSwitch, segmented, confirmDialog, openDrawer, toast (aria-live), skeleton, emptyState, keepFocus, domainHue.
- `charts.js` dayBars (stacked SVG bars), coverageStrip, legend.
- `theme.js` system/light/dark in localStorage `hub-theme`.
- `fonts/` Instrument Sans and Source Serif 4 variable woff2 (latin, normal + italic) with their OFL texts.

## Done (stage 1)

- Fonts self-hosted; CSP gained only `font-src 'self'` (test checks no remote sources).
- Tokens (Fog/Deep, Ultramarine, domain hues, status colours), light/dark/system theme.
- Shell, hash router with deep links, command palette, sign-in screen, toasts, dialogs, drawer, skeletons, empty states.
- Overview: channel board (power switch, cable solid/dashed/cut, Off/Read/Read and write with the confirm dialog),
  optimistic updates with rollback and toast, attention list, agent calls per day (14 days), digest coverage strip,
  system facts; refetch on tab focus and every 60 s while visible; cables draw in once per page load.
- `GET /admin/api/series?days=14`: agent calls per local day by tool, failures, last call time (tested).
- Digests, Keys, Agent access, Backups, Portfolio, Activity ported into `views/` with minimal changes
  (filters and search in the URL, revoke uses the confirm dialog, toasts on actions).
- Tests: 137 pass in node:20 (CSP font-src, module/font MIME types, series endpoint).
- Checked in headless Chrome on a scratch hub: light, dark, 390 px; Ctrl+K, Tab order, focus rings, board dialogs, rollback.

## Done (stage 2)

- API: `/activity?type=&before=` (chips, paging, `more`), `/digests?from=&to=` with `bounds`, `/keys/:id/calls`
  (tool, action, outcome, time; never content). Tested (140 pass in node:20).
- `scopes.js` explains scopes in plain words and groups them by domain for chips and the create picker.
- Digests: month calendar (missing days marked, one tab stop, arrows/Home/End/Page Up/Down, crosses months), list,
  search with highlighted matches, serif reader (under 70ch), edit (Ctrl Enter, Esc), history/compare/restore in a
  right drawer, deep links `#/digests/daily/2026-11-08` and `#/digests/weekly/2026-W45`, previous/next day or week.
  The Overview 30-day strip is also one tab stop with arrows.
- Keys: table (name, scope chips, last used, calls), row opens `#/keys/:id` drawer (plain scopes, reach through the
  agent endpoint, recent calls, revoke via confirm dialog), create drawer with grouped scope picker, secret shown
  once with Copy key and "You won't see it again".
- Agent access per key and domain (read/edit/publish with the reason when not), recent calls, links to key drawers.
- Activity grouped by day, chips in the URL, event sentences, Show older events (keeps focus).
- Backups (list, Back up now + toast, restore steps as text), Portfolio (counts, missing/orphan to-do list),
  Settings (`#/settings`: theme, session expiry and sign out, version/uptime/db size, shortcut list).
- Theme toggle visible on phones; drawers are full sheets under 760 px.
- Checked in headless Chrome on a seeded scratch hub: every view light/dark at 1280 and 390 (no overflow, no
  console errors, text contrast 4.5:1), calendar and strip arrows, drawer focus trap/Esc/focus return, revoke
  dialog focus return, copy button.

## Done (stage 3)

- Web app manifest and icons (CSP gains only `manifest-src 'self'`), theme-color per theme, titles "View - Personal hub".
- Overview: bolder channel board on one subgrid; System facts moved to the rail foot and Settings.
- Digests: month calendar beside the reader from 1100 px (sticky), below it on narrower screens.
- Keyboard shortcuts in `shortcuts.js`: `g o/d/k/a/s`, `/` (page search or the palette), `?` (list), `[` (rail);
  ignored while typing or with a dialog open. Listed in Settings, the palette and the `?` dialog.
- Phones: tables as stacked rows, More bottom sheet (other sections, search, sign out), 44 px targets.
- A 401 mid-session shows sign-in with "Your session ended" and returns to the same `#/route` (drawers too).
  Failed loads show an inline error with Retry; a view file that failed to download is imported again under a
  fresh URL on Retry (browsers keep failed modules). Every empty state names the next action.
- `skeletons.js`: loading placeholders shaped like each view (board, digests list and reader with calendar,
  keys, agent access, backups, portfolio, activity, settings), measured against the loaded page at 1280 and 390 px.
- Contrast and motion: text 4.5:1, control borders and cables 3:1 vs page and surface, in light and dark, at
  1280 and 390 (scripted audit of every view, drawer, palette and `?` dialog: no failures). Focus rings on every
  focusable in views, drawers, palette, calendar and switches. `prefers-reduced-motion` turns off cable draw-in,
  drawer and sheet slides, toasts and skeleton pulse (one CSS rule plus a JS check for the draw-in).
- Tests: 143 pass in node:20, including CSP manifest-src, manifest/icon serving, and a check that every admin
  module parses, is served as JavaScript and imports only files that exist.
- Verified in headless Chrome on a seeded scratch hub and an empty one: every shortcut, the 401 flow (cookies
  cleared, sign in, back on `#/activity?type=agents` and on an open key drawer), Retry offline and on a 500,
  stacked rows and the More sheet at 390 px, calendar beside at 1280/1400 and below at 900, empty states.

## Done (places view, 2026-11-10)

- `views/places.js` (`#/places`, `#/places/12`, `?tab=queue&show=`, `?q=`, `?kind=`, `?new=1`): tablist Places /
  Needs a name (pending badge, arrows/Home/End), table with kind and rule-count chips, right drawer (details,
  rules with Not this place and priority, history with compare and restore, delete dialog), Check a location
  (address, point or zone; match, rule, confidence, alternatives, ruled out; never files), queue with Name it,
  Add to existing place, Dismiss and the Named/Dismissed/All views. Rule values only in the drawer and the check.
- Overview: Places channel in plum, "N spots need a name" in the attention list, headline counts domains, the
  write-mode confirm says what write means for each domain. `g p`, palette (places by name, New place, queue).
- Verified in headless Chrome on a scratch hub with invented places: 29 keyboard/flow checks (tabs, drawer trap,
  Esc and focus return, dialogs, restore, delete, 401 back to an open drawer, toasts carry no rule value),
  contrast and focus audit light/dark at 1280 and 390, stacked rows and full-sheet drawer at 390, empty states,
  offline error with Retry, skeletons per tab, switch and selector on the board. Tests: 218 pass in node:20.

## Done (flights view, 2026-11-10)

- `views/flights.js` + `passport.js` + `worldmap.js` (`#/flights`): Passport, Flights, Found flights; details in
  `services/FLIGHTS_PROGRESS.md` (stage 3). Teal channel, `g f`, nav and tab badges for found flights, palette entries.
- Verified in headless Chrome on a scratch hub: 36 flow checks and 5 empty-hub checks (see the progress file). Tests: 294 pass.

## Key scope editing (2026-11-11)

- `apiKeys.update(db, id, { name?, scopes?, confirmAll? })` changes a live key in place; the secret and hash stay. Errors carry
  `.status`: 400 (empty/invalid scopes, name not 1-60 chars, nothing to change, `*` without confirm), 404, 409 (revoked, or
  the name is taken by another live key). `PATCH /admin/api/keys/:id` returns the key in `list()` shape, never the secret.
- Granting `*` needs `confirm_all: true` in the body (the UI asks first). Narrowing, or renaming a key that already has `*`, does not.
- Audit row `key_updated`: `{ id, name, renamed_from?, added: [...], removed: [...] }`, scope names only. A request that
  changes nothing writes no row. It is in the Activity `keys` filter and has a sentence ("updated key x (added Flights observe; removed Places edit)").
- No caching: `verify()` reads the key row on every request, so a change applies to the key's next call (tested on `/hub/places`,
  `/hub/digests` and MCP `tools/list`).
- Calls are logged by key name (`mcp_call` actor), so after a rename earlier calls stay under the old name and the drawer's
  recent calls and the 30-day count start again under the new one. The rename help text says so.
- UI: `public/scopeEditor.js` is the shared piece (checkboxes per domain from `scopes.js`, `domain:*` and `*` options, scopes not in the
  catalogue shown as "Other scopes on this key" so they are never dropped, the diff sentence "Adds x. Removes y.", `saveKey` with the
  all-access confirm). Keys drawer (`views/keys.js`): Access form with rename, Save and Cancel, discard guard on close; revoked keys
  show the read-only list and no controls. Agent access (`views/agents.js`): each key x domain cell is a `<button data-cell="id:tool">`
  that opens a drawer (native modal dialog: page inert, Esc closes, focus returns to the cell) with only that domain's checkboxes and the
  domain mode as context; the PATCH sends the key's full scope list with only that domain's scopes changed. A key with `*` gets a pointer
  to the Keys page instead of checkboxes. "New key" shortcut next to the matrix heading.
- Tests: 365 pass in node:20 (347 before): service (update, name, empty, 409/404, `*` confirm, uniqueness, next-request effect on
  `/hub/places` and `/hub/digests`), admin PATCH route (auth, validation, audit names, no secret, activity filter, matrix), MCP
  `tools/list` follows a scope change.
- Browser checks on a scratch hub: `workspace/tmp/hub-flights-e2e/run-keys.mjs` (25 checks: create, edit with diff, Cancel, discard
  guard, save + curl 200/403 with the same secret, reload persistence, empty refused, rename and duplicate name, `*` confirm and
  back-out, legacy scope kept, cell drawer + focus trap + Esc, cell edit touches one domain, `*` key in a cell, New key shortcut,
  revoked key, Activity sentence, dark, 390 px, no console errors). Run `sh reset.sh empty && node run-keys.mjs`.

## Briefing framework (2026-11-11)

What needs the user now (`attention`) and what is coming (`upcoming`), collected from the domains. Deterministic, no model, stateless (no "seen" tracking). No `recent` section.

- **Code**: `services/briefing.js` (`collect(db, { now, days, domains, visibleDomains })`), first hooks in `services/briefingHooks.js` (flights, places, digests; portfolio has none).
- **Output**: `{ generated_at, days, attention: [...], upcoming: [...], more: N }`. `days` default 14, clamped 1..90. About 20 items kept (attention first), ordered by severity (urgent, attention, info), then date, then id; `more` counts the dropped.
- **Item**: `{ id, domain, severity: 'info'|'attention'|'urgent', text, date?, ref?: { domain, id } }`.
  - `id` is stable and built from the thing and its state: `flights:candidates:pending`, `flights:42:departs-2026-12-17`, `flights:42:source-cancelled-2026-12-17`, `places:suggestions:pending`, `digests:missing:2026-11-10`. A later webhook can fire once per id.
  - `text` is one plain line. Privacy rule: never a booking reference, address, street, document or account number, passenger name or note. Flights say airline code + number, airport codes and dates; places and digests say counts and dates only. `ref` is the record, never its content. Tests seed a booking ref and a street and grep the JSON.
- **Hook**: a domain adds an optional `briefing: (db, { now, days }) => ({ attention: [], upcoming: [] })` to its entry in `services/domains.js` REGISTRY (a flat list is accepted and goes to `upcoming`). Rules: items inside the horizon go to `upcoming`; anything that needs action goes to `attention`; use `severity: 'urgent'` only for something breaking now. The collector wraps every hook (a throw is logged and the hook skipped), drops malformed items, de-duplicates ids, and skips a domain that is off, not visible to the key, or not in the `domains` filter (its hook does not run). A new domain (deadlines) adds only its own hook.
- **Hooks now**: flights (departures within `days`, by airport-local date, "today" = America/Chicago, wording `CX 891 DFW to HKG departs in 36 days (2026-12-17)`; pending found flights: attention; an upcoming flight a source says is cancelled: urgent, any horizon, not repeated under upcoming), places (pending suggestions: attention), digests (reuses `adminStats.digestWatch`: yesterday's daily missing after 6 AM Chicago once any daily exists: attention).
- **Access**: `briefing.visibleDomainsFor(conn, key)` is `registry.visibleTools` (the exact rule `hub_overview` uses: domain on, MCP mode not off, key has the read scope). A key with no readable domain gets an empty briefing, not an error.
- **Endpoints**: MCP tool `hub_briefing` (`{ days?, domains? }`, read-only, DATA_NOTE preamble, audited as `mcp_call` / `hub_briefing`, listed for every key); `GET /hub/briefing?days=&domains=a,b` (any live key); `GET /admin/api/briefing?days=` (admin session, every domain that is on).
- **Dashboard**: a "Today" card at the top of Overview (`views/overview.js`): Needs you (severity chips: Urgent red, Attention amber) then Coming up with dates, each row linking to the record (`#/flights/<id>`, `#/flights?tab=found`, `#/places?tab=queue`, `#/digests`), empty state "Nothing needs you right now.", segmented Next 14 / 30 / 60 days kept in localStorage `hub-briefing-days`, skeleton while loading, error state with Retry, refreshed with the page's 60 s refresh. The existing "Needs attention" panel stays: it also covers the database, backups and portfolio files, which the briefing does not (merging would lose those lines).
- **Verified**: suite 390 pass (365 + 25 new in `tests/briefing.test.js`; six tool-list expectations in `tests/mcp.test.js` now include `hub_briefing`). Browser checks on the scratch hub (`workspace/tmp/hub-flights-e2e/run-briefing.mjs`, seed `briefing-seed.js`): seeded 16/16, empty hub 6/6 (empty state, skeleton, error + Retry, no console errors). Screenshots in `workspace/tmp/hub-flights-shots/briefing-*.jpg`.
- **Open**: `hub_overview` text unchanged; the morning-briefing cron job still reads the digest (stage 5); flights departing today that are already in the air are not listed.

## Open

- Key scope editing: a rename does not move earlier agent calls (logged by key name); the 30-day count and recent calls restart under the new name.

- Segmented options are 42 px tall on phones inside a 46 px control (the switch has a 44 px hit area);
  fine in use, short of a strict 44 px per option.
- Skeletons match the first screen; long lists (activity, portfolio) are naturally taller once loaded.
- The admin rate limit (600 requests per 15 minutes) counts static files; heavy reloading can hit it.
- Places skeletons match at 1280; at 390 the loaded list (stacked rows) is taller than its skeleton.
- Deleting a place from a drawer opened off a list goes back to that list view (history back), queue included.
