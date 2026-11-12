# Run 4 progress (Settings: timezone + backups): DONE
Tests run via a scratch copy (host node_modules has no jest): rsync to /tmp/pa-run4, jest in node:20. 598 pass (558 before).

## Done
- 014 hub_settings, services/settings.js, services/lib/tz.js; briefing/deadlines/adminStats/backups read the hub tz
- services/backup.js: settings-driven scheduler (5 min wake), both name forms, pre-delete/pre-migration kept apart, folder check, verify, loud failures
- db.open: pre-migration copy; /health backups line; admin API settings + backups/verify; route table +4
- UI: Settings (timezone, backups), Backups view, Overview 'Backups failing', activity sentences
- docs in routes/admin/PROGRESS.md (incl. compose volume example, no compose change)
- browser check on scratch hub (port 3998): tmp/hub-flights-e2e/run-settings.mjs, 17/17

## Left for the planner
- deploy, push; off-box host path decision
