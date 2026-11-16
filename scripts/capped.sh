#!/bin/sh
# Run a command with all output going to a log file; print only a short summary.
# usage: scripts/capped.sh <command...>   (log path is printed; read more with sed -n / grep on it)
LOG=$(mktemp /tmp/capped-XXXXXX.log)
"$@" > "$LOG" 2>&1
RC=$?
echo "exit=$RC log=$LOG lines=$(wc -l < "$LOG")"
grep -n '^Tests:\|^Test Suites:\|^FAIL\|✕\|passed\|failed' "$LOG" | head -30 | cut -c1-200
echo '--- tail ---'
tail -n 25 "$LOG" | cut -c1-200
exit $RC
