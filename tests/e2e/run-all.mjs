#!/usr/bin/env node
// Runs the browser flows, each against its own fresh scratch hub (docker node:20, temp data dir, random free port,
// never port 3000). Usage: node tests/e2e/run-all.mjs [flow ...]      (no names = every flow)
//   node tests/e2e/run-all.mjs --list
// Output: one PASS/FAIL line per flow and a total; the full per-check output of each flow is in $E2E_LOGS/<flow>.log.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import lib from './lib.js';

// name: [runner, argument, seed file run inside the hub container before start (null = empty hub), extra setup]
const FLOWS = {
    flights: ['run.mjs', 'main', 'seed.js', { more: 'more.js' }],
    'flights-empty': ['run.mjs', 'empty', null],
    sources: ['run-sources.mjs', null, 'sources-seed.js'],
    passport: ['run-passport.mjs', 'main', 'passport-seed.js'],
    'passport-plain': ['run-passport.mjs', 'plain', 'seed.js'],
    globe: ['run-globe.mjs', null, 'passport-seed.js'],
    keys: ['run-keys.mjs', null, null],
    deadlines: ['run-deadlines.mjs', null, 'deadlines-seed.js'],
    preferences: ['run-preferences.mjs', null, 'preferences-seed.js'],
    briefing: ['run-briefing.mjs', null, 'briefing-seed.js'],
    'briefing-empty': ['run-briefing.mjs', 'empty', null],
    overview: ['run-overview.mjs', null, 'briefing-seed.js'],
    'overview-empty': ['run-overview.mjs', 'empty', null, { backupToday: true }],
    delete: ['run-delete.mjs', null, 'delete-seed.js'],
    settings: ['run-settings.mjs', null, null],
};

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(Object.keys(FLOWS).join('\n')); process.exit(0); }
const names = args.length ? args : Object.keys(FLOWS);
for (const n of names) if (!FLOWS[n]) { console.error(`unknown flow ${n}; --list shows them`); process.exit(2); }

const logs = process.env.E2E_LOGS || path.join(os.tmpdir(), 'pa-e2e-logs');
fs.mkdirSync(logs, { recursive: true });

function run(cmd, argv, env, logFile) {
    return new Promise((resolve) => {
        const p = spawn(cmd, argv, { env: { ...process.env, ...env }, cwd: lib.E2E_DIR });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('close', (code) => { fs.writeFileSync(logFile, out); resolve({ code, out }); });
    });
}

let totalPass = 0; let totalFail = 0; let flowsFailed = 0;
for (const name of names) {
    const [script, arg, seed, extra = {}] = FLOWS[name];
    let hub;
    let line;
    try {
        hub = await lib.startHub({ seed });
        if (extra.backupToday) {
            // "all clear" overview needs a backup from today (the scratch hub has made none)
            const dir = path.join(hub.dataDir, 'backups');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `hub-${new Date().toISOString().slice(0, 10)}.db`), '');
        }
        const env = { E2E_PORT: String(hub.port), E2E_OUT: hub.outDir, E2E_DATA: hub.dataDir, SHOTS: path.join(logs, 'shots') };
        if (extra.more) env.MORE = hub.seedCmd(extra.more);
        const r = await run('node', [script, ...(arg ? [arg] : [])], env, path.join(logs, `${name}.log`));
        const seen = new Map();
        for (const l of r.out.split('\n')) { const m = /^(PASS|FAIL) (\d+) /.exec(l); if (m) seen.set(m[2], m[1]); }
        const pass = [...seen.values()].filter((v) => v === 'PASS').length;
        const fail = [...seen.values()].filter((v) => v === 'FAIL').length;
        const ok = r.code === 0 && fail === 0 && pass > 0;
        totalPass += pass; totalFail += fail + (r.code !== 0 && fail === 0 ? 1 : 0);
        if (!ok) flowsFailed += 1;
        line = `${ok ? 'PASS' : 'FAIL'} ${name.padEnd(15)} ${pass} checks passed, ${fail} failed${r.code !== 0 && fail === 0 ? ` (exit ${r.code}, see ${name}.log)` : ''}`;
    } catch (e) {
        flowsFailed += 1; totalFail += 1;
        line = `FAIL ${name.padEnd(15)} could not run: ${String(e.message).split('\n')[0].slice(0, 160)}`;
    } finally {
        if (hub) hub.stop();
    }
    console.log(line);
}
console.log(`TOTAL ${names.length - flowsFailed}/${names.length} flows passed; ${totalPass} checks passed, ${totalFail} failed; logs in ${logs}`);
process.exit(flowsFailed ? 1 : 0);
