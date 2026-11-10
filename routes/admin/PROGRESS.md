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

## Next

- Stage 3: shortcuts (`g o`, `g d`, `g k`, `/`, `?`), mobile tables as stacked rows, contrast pass, error states.
- Small open points: the rail is not collapsible by keyboard shortcut yet; at 390 px activity times sit under the
  sentence (fine, could be tighter).
