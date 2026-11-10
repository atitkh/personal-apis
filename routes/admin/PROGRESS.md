# Admin webapp rebuild: progress

Plan: `memory/projects/personal-hub-admin-design.md` in the OpenClaw workspace (patch-bay channel board, three stages).

## Layout (no build step, plain ES modules)

- `public/index.html` loads `theme-boot.js` (classic script, sets the theme before paint) and `app.js` (module).
- `app.js` registers routes, starts the shell, the router and the palette commands. A new view = one file in
  `views/` + one `router.register()` line; it exports `render(ctx)` returning a node (ctx: route, api, rerender, onCleanup, isCurrent).
- `router.js` hash router (`#/digests/daily/2026-11-08`, `#/activity?type=agents`, `#/keys/12`, `#/keys?new=1`).
- `shell.js` rail (collapsible, remembered), top bar (title, palette button, theme toggle, account menu), phone tab bar.
- `palette.js` Ctrl/Cmd+K: views, digests by date, keys by name, Back up now, Create key, theme, sign out.
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

## Open

- Segmented options are 42 px tall on phones inside a 46 px control (the switch has a 44 px hit area);
  fine in use, short of a strict 44 px per option.
- Skeletons match the first screen; long lists (activity, portfolio) are naturally taller once loaded.
- The admin rate limit (600 requests per 15 minutes) counts static files; heavy reloading can hit it.
