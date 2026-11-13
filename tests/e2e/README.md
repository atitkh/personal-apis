# Browser flows (tests/e2e)

Headless-browser checks of the admin dashboard: Flights, Passport, Globe, Keys, Deadlines, Trips, Preferences, Today card,
Overview, permanent Delete and Settings. Each flow gets its **own fresh scratch hub** (this repo's code in a `node:20`
container, a temp data dir, a random free port, admin key `eeee…`, invented seed data). Nothing here touches the live
hub: the scripts refuse port 3000, non-local hosts, and any data dir inside the repo or equal to `HUB_DATA_DIR`.

These are `.mjs` runners, not `*.test.js`, so jest (`testMatch: **/tests/**/*.test.js`) never picks them up.

## Prerequisites

| Need | How it is found | On this host |
| --- | --- | --- |
| docker | `docker` on PATH | Docker 29 |
| rsync | on PATH (copies the code into the scratch hub; `node_modules`, `.git`, `data`, `.env` are never copied) | yes |
| node_modules built for node 20, with `better-sqlite3` | `E2E_NODE_MODULES`, else `<repo>/node_modules`, `/tmp/pa-run4/node_modules`, `/tmp/pa-flights/node_modules` (first with `better-sqlite3`) | `/tmp/pa-run4/node_modules` (the jest scratch copy). The repo's own `node_modules` has no `better-sqlite3`. |
| `playwright-core` | `E2E_PLAYWRIGHT` (package dir), else the OpenClaw install `/home/voltex/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core`, else `require('playwright-core')` | the OpenClaw one; it is not in this repo's `package.json` and must not be added |
| Chrome/Chromium binary | `E2E_BROWSER`, default `/usr/bin/google-chrome` | Google Chrome from the OS package |
| python3 + Pillow (optional) | shrinks screenshots to about 900 px wide JPEG q70 (`shrink.py`); without it the raw PNG is kept | yes |

To make a node 20 `node_modules` when there is none (jest's scratch copy is the usual one):

```sh
rsync -a --exclude node_modules --exclude .git --exclude data --exclude .env ./ /tmp/pa-run4/
docker run --rm -v /tmp/pa-run4:/app -w /app node:20 npm ci
```

The same scratch copy runs jest (the host has neither jest nor a node 20): `sh /tmp/run4-test.sh`
(rsync to `/tmp/pa-run4`, then `docker run node:20 npx jest --coverage=false`).

## Run

```sh
node tests/e2e/run-all.mjs               # every flow, one PASS/FAIL line each and a total (about 8 minutes)
node tests/e2e/run-all.mjs keys globe    # chosen flows
node tests/e2e/run-all.mjs --list
```

Flows: `flights flights-empty sources passport passport-plain globe keys deadlines preferences briefing briefing-empty
overview overview-empty delete settings trips lifelog`. Output per flow looks like
`PASS keys            27 checks passed, 0 failed`; the per-check output of each flow is in `$E2E_LOGS/<flow>.log`
and screenshots in `$E2E_LOGS/shots/`. Exit code 1 when any flow fails.

Environment (all optional): `E2E_PORT` (fixed port instead of a random one; never 3000), `E2E_NODE_MODULES`,
`E2E_PLAYWRIGHT`, `E2E_BROWSER`, `E2E_LOGS` (default `/tmp/pa-e2e-logs`), `E2E_TMP` (where scratch dirs go, default
`/tmp`), `E2E_KEEP=1` (leave the scratch data dir for inspection; the container is still removed), `E2E_KEY`.

A runner can also be pointed at a scratch hub you started yourself:
`E2E_PORT=3999 E2E_OUT=/tmp/out E2E_DATA=/tmp/data node tests/e2e/run-keys.mjs` (the guards still apply).

## How a flow is built

* `lib.js`: `startHub({ seed })` (code copy, data dir, container, wait for `/health`), guards, browser launch,
  screenshot shrinking.
* `*-seed.js`: run inside the hub's container (`/app` = code copy, `/e2e` = this directory, `$E2E_OUT` = `/out`)
  before the hub starts; they write invented data through the services and may leave expected numbers in `$E2E_OUT`
  (`expected.json`, `expected-passport.json`, `sources-ids.json`), which the runner reads. `more.js` adds found flights
  mid-run (the Flights flow's Accept all / Added checks need it; `run-all.mjs` passes it as `MORE`).
* `dates.js`: `rel('2027-01-20')` keeps a future date the same distance from today as when it was written
  (2026-11-12), so seeds and runners never drift into the past. Write past dates literally.
* `run-*.mjs`: playwright-core scripts that print `PASS n name` / `FAIL n name :: reason` and exit non-zero on a failure.

## Add a flow

1. Write `run-<name>.mjs` (copy the head of a small one such as `run-overview.mjs`: `lib.assertScratchUrl`,
   `lib.launchBrowser()`, `lib.shotsDir()`, the `check` helper, exit code).
2. If it needs data, add `<name>-seed.js` (use `require('/app/db')` and `/app/services/...`; invented data only).
3. Add one line to `FLOWS` in `run-all.mjs`: `[runner, argument, seed file or null, { optional extras }]`.
4. Run `node tests/e2e/run-all.mjs <name>`, fix until green, commit.

## CI

There is none. The Gitea runner on the docker host (`gitea-runner-axis`) exists but its logs show it cannot reach
Gitea, so a workflow would never run. Run these by hand before a release or after touching `routes/admin/public`.
Adding CI later means: a runner that has docker and a browser, and the `run-all.mjs` call above.

## Known quirks

* Checks are time-sensitive (8 s waits). On a loaded host a flow can fail once on a slow first paint; rerun that flow
  alone before treating it as a regression.
* The `keys` flow flaked twice in four runs (a rename/activity check) and passed on rerun; `run-all.mjs` retries only a runner that died before its first check, not a failed check, so rerun a flow by name before calling it a regression.
* The hub only trusts estimated times and delay within 72 h of departure (`services/enrich.js`), so `sources-seed.js` puts its live flight 2 days out.
* The hub container runs as your uid so the data dir is removable without root.
