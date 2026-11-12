# Run 4 progress (Settings: timezone + backups)
Tests run via /tmp/run4-test.sh (rsync to /tmp/pa-run4, jest in node:20; host node_modules has no jest).

## Done
- 014 hub_settings migration, services/settings.js, services/lib/tz.js; briefing/deadlines/adminStats read the hub tz

## Next
- settings/tz tests; backup.js rewrite (naming, prune, scheduler, pre-migration); admin API settings+backups; views; health; docs; live check
- backup service rewrite (scheduler, both name forms, pre-migration, dir check, verify), db.open pre-migration hook, /health backups line
- admin API: settings (GET/PUT, dir test), backups (now, verify); route table regenerated; tests (598 green)
- UI: Settings (timezone + backups sections), Backups view, Overview 'Backups failing' line, activity sentences
## Next
- scratch-hub browser check (port 3998), docs note in PROGRESS.md (second destination), final report
