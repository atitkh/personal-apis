# Run 4 progress (Settings: timezone + backups)
Tests run via /tmp/run4-test.sh (rsync to /tmp/pa-run4, jest in node:20; host node_modules has no jest).

## Done
- 014 hub_settings migration, services/settings.js, services/lib/tz.js; briefing/deadlines/adminStats read the hub tz

## Next
- settings/tz tests; backup.js rewrite (naming, prune, scheduler, pre-migration); admin API settings+backups; views; health; docs; live check
