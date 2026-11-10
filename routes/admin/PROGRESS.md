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

## Next

- Stage 2: Digests (coverage calendar, reader, history/compare/restore in a drawer), Keys (table + detail drawer,
  create flow with copy), Agent access, Activity (day groups, chips), Backups, Portfolio, Settings.
- Stage 3: shortcuts (`g o`, `g d`, `g k`, `/`, `?`), mobile tables as stacked rows, contrast pass, error states.
- Small open points: the 30-day strip is 30 tab stops (make it one stop with arrow keys); the theme toggle is hidden
  under 760 px (reachable through the palette); the rail is not collapsible by keyboard shortcut yet.
