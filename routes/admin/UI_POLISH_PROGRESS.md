# Admin UI polish: progress

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
