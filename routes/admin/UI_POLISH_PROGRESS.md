# Admin UI polish: progress

## Run B audit (before the pass)
1. Type: 12 one-off font sizes in style.css (11, 11.5, 12, 13, 13.5, 14, 17.5, 18.5 px) next to the --fs-* scale.
2. Tables: row hover only on 4 of 8 tables (keys, places, flights, deadlines); no sticky header; header th and cell padding differ per table.
3. Surfaces: ten list containers (.queue-list, .events, .pref-list, .record, .top-list, .trip-card, .stat-grid, .counts, .source-row) repeat surface + line + r-panel with 12/14/16 px paddings vs .panel 20 px.
4. Filter bars: .toolbar (digests, places, flights tab bar) vs .toolbar.filter-bar (deadlines, flights, preferences); Activity puts a bare chipNav under the header with no toolbar; spacing under the page header differs.
5. Empty states: one emptyState() kit piece used everywhere, but .empty padding is 20px 4px and some panels add their own (.attention .empty); Overview Today/attention say the same thing twice.
6. Buttons: Add/primary in the header everywhere; drawer actions are an ad-hoc .row / .rev-actions / .row-actions with no shared footer; danger vs quiet-danger already follow the rule.
7. Forms: label grid gap 6 px, .field/.field-help/.field-error exist but errors and help sit at different gaps per drawer; no focus ring on .seg/.chip-link/.table rows beyond the global one; inputs lack a hover/focus border state.
8. Page frame: .content max 1180 / gutter 28 on every page; .settings 860, .reader 760 are deliberate; Overview had its own headline block instead of pageHeader.
9. Polish: no transitions on rail links, chips, rows; skeletons are View-shaped everywhere but the Today card; no prefers-reduced-motion rule for pulse/draw/slide animations.
10. Overview order: headline, Today, board, then Needs attention + Pulse; should be Needs attention, board, activity.

Plan: workspace memory/projects/personal-hub-ui-polish-plan.md. Local commits only, nothing deployed.

## Run A (structure): done
1. Grouped rail: `group` on `router.register()` (overview, data, access, system); `shell.js` `groupRoutes()` renders the rail
   and the phone More sheet by group. Labels (Data, Access, System) are `rail-label`s, so they hide when the rail is
   collapsed (a divider line replaces them). Registration order in `app.js` now follows the groups.
2. `pageHeader({ title, lede, actions, meta })` in `ui.js` (`.page-header`, `.page-header-main`, `.page-header-actions`,
   `.page-meta`). Used by activity, agents, backups, deadlines, digests, flights, keys, places, portfolio, preferences,
   trips, settings. Skeleton headers use the same classes. Overview has no lede and keeps its own layout (Run B).
3. Settings: `#/settings/<section>` with general (default), appearance, account, backups, webhooks, shortcuts, about;
   list in `settingsNav.js`; sub-nav on the left, horizontal chips on phones; palette entries "Settings: <section>".
   `settingsForms.js` and `webhooksSection.js` unchanged. Backups page links to `#/settings/backups`.

## Decisions
- pageHeader `title` is optional: the page title stays in the top bar; a heading only for sub-pages.
- Unknown `#/settings/<x>` shows General (no redirect).
- Moving between sub-sections is a soft render of the same view (refetches /overview, /session, /settings, /webhooks).
- e2e run-settings.mjs extended (rail groups, sub-sections, dark + collapsed rail, More sheet, Backups header); the tz and
  backup steps now visit `#/settings` and `#/settings/backups`.
- tests/adminTripsView.test.js: app.js register pattern gained `group: 'data'`.

## Next (Run B, not started)
Consistency pass: panels, tables, filter bars/tabs, chips, empty states, buttons, drawers; spacing/type audit; Overview
hierarchy; focus/hover polish; dark theme and 390 px checks.
