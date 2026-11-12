// Browser flow checks for permanent delete in every domain, against a SCRATCH hub seeded by delete-seed.js
// (SEED=delete-seed.js ./reset.sh). Headless Chrome through playwright-core. Usage: node run-deadlines.mjs
// Env: BASE (default http://localhost:3999/admin/), KEY (admin key), SHOTS (output dir).
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/voltex/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core');

const BASE = process.env.BASE || 'http://localhost:3999/admin/';
const KEY = process.env.KEY || 'e'.repeat(40);
const SHOTS = process.env.SHOTS || '/home/voltex/.openclaw/workspace/tmp/hub-flights-shots';
const MORE = process.env.MORE || '';
const phase = process.argv[2] || 'main';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const errors = [];
let n = 0;
async function check(name, fn) {
    n += 1;
    try {
        const r = await fn();
        if (r === false) throw new Error('returned false');
        results.push(['PASS', n, name]);
    } catch (e) {
        const st = await page.evaluate(() => `hash=${location.hash} dialogs=${[...document.querySelectorAll('dialog[open]')].map((d) => d.className + ':' + (d.querySelector('h2') ? d.querySelector('h2').innerText.slice(0, 30) : '')).join(';')} focus=${document.activeElement && document.activeElement.getAttribute('data-key')}`).catch(() => '');
        results.push(['FAIL', n, `${name} :: ${String(e.message).split('\n')[0].slice(0, 200)} [${st}]`]);
    }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what || 'not true'); };

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

const go = async (hash) => { await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); await page.waitForSelector('.content .view, .content .overview, .content h2', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(250); };
const hashNow = () => page.evaluate(() => location.hash);
const text = (sel) => page.locator(sel).first().innerText();
const toasts = () => page.locator('.toast-stack').innerText().catch(() => '');
const waitToast = (re) => page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('.toast-stack') ? document.querySelector('.toast-stack').innerText : ''), re.source, { timeout: 6000 });
const api = (path) => page.evaluate(async (p) => (await fetch(`/admin/api${p}`, { headers: { 'X-Requested-With': 'hub-admin' } })).json(), path);
const confirmYes = async () => { await page.locator('dialog[open] .dialog-actions .btn').last().click(); await page.waitForTimeout(250); };
const shot = async (name) => {
    const raw = `/tmp/${name}-raw.png`;
    await page.screenshot({ path: raw, fullPage: false });
    execSync(`python3 -I /home/voltex/.openclaw/workspace/tmp/hub-flights-e2e/shrink.py ${raw} ${SHOTS}/${name}.jpg && rm ${raw}`);
    return fs.statSync(`${SHOTS}/${name}.jpg`).size;
};
async function signIn() {
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav');
    await page.waitForLoadState('networkidle');
}


const BACKUPS = '/tmp/pa-scratch-data/backups';
const backupFiles = () => { try { return fs.readdirSync(BACKUPS).filter((f) => /^hub-pre-delete-/.test(f)); } catch (e) { return []; } };
const dlg = () => page.locator('dialog.delete-dialog[open]');
const dlgText = async () => (await dlg().innerText()).replace(/\s+/g, ' ');
const apiStatus = (path) => page.evaluate(async (p) => (await fetch(`/admin/api${p}`, { headers: { 'X-Requested-With': 'hub-admin' } })).status, path);
const cancelDlg = async () => { await dlg().getByRole('button', { name: 'Cancel' }).click(); await page.waitForTimeout(250); };
const confirmDel = async () => { await dlg().getByRole('button', { name: 'Delete permanently' }).click(); };
const gone = () => page.waitForSelector('dialog.delete-dialog[open]', { state: 'detached', timeout: 6000 });
const flightByNo = async (no) => (await api('/flights?limit=200')).flights.find((f) => f.flight_number === no);
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(300); };

await signIn();

// ---- flights ----
const f1 = await flightByNo('500');
await check('flight drawer: Delete permanently opens the confirm with counts, what stays, backup ON, red button', async () => {
    await go(`flights/${f1.id}`);
    await page.waitForSelector('[data-key="delete-flight"]');
    await page.locator('[data-key="delete-flight"]').click();
    await dlg().waitFor();
    const t = await dlgText();
    ok(/AA 500 DFW-LIT/.test(t), `label: ${t.slice(0, 80)}`);
    ok(/2 revisions/.test(t), '2 revisions'); ok(/1 live-data lookup/.test(t), '1 observation');
    ok(/Gmail/.test(t) && /cannot be undone/i.test(t), 'stays + cannot be undone');
    ok(await dlg().locator('input[name="backup"]').isChecked(), 'backup default on');
    ok(await dlg().locator('input[name="forget_candidate"]').isChecked(), 'forget default on');
    const bg = await dlg().getByRole('button', { name: 'Delete permanently' }).evaluate((b) => getComputedStyle(b).backgroundColor);
    ok(/^rgb\(/.test(bg) && bg !== 'rgba(0, 0, 0, 0)', `red button ${bg}`);
});
await shot('delete-flight-dialog');
await check('Cancel keeps the flight', async () => {
    await cancelDlg();
    eq(await apiStatus(`/flights/${f1.id}`), 200);
    eq(await dlg().count(), 0, 'dialog closed');
});
await check('Escape closes the dialog and focus returns to the button', async () => {
    await page.locator('[data-key="delete-flight"]').click();
    await dlg().waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    eq(await dlg().count(), 0, 'closed');
    eq(await page.evaluate(() => document.activeElement.getAttribute('data-key')), 'delete-flight');
});
await check('confirm: backup file appears, toast, list refreshed, flight gone', async () => {
    const before = backupFiles().length;
    await page.locator('[data-key="delete-flight"]').click();
    await dlg().waitFor();
    await confirmDel();
    await waitToast(/Deleted AA 500/);
    await quiet();
    eq(backupFiles().length, before + 1, 'backup files');
    eq(await apiStatus(`/flights/${f1.id}`), 404);
    ok(!(await page.locator('.content').innerText()).includes('500'), 'row gone from list');
    ok(!(await hashNow()).includes(String(f1.id)), `hash ${await hashNow()}`);
});
const f2 = await flightByNo('2210');
await check('flight from an accepted Gmail candidate: delete forgets the candidate (scan may find it again)', async () => {
    await go(`flights/${f2.id}`);
    await page.locator('[data-key="delete-flight"]').click();
    await dlg().waitFor();
    ok(/1 found-flight record/.test(await dlgText()), 'mentions the record');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted UA 2210/);
    await quiet();
    const c = await api('/flights/candidates?status=all&limit=200');
    ok(!c.candidates.some((x) => x.flight_number === '2210'), 'candidate row gone');
});

// ---- trip ----
const dl = await flightByNo('10');
await check('trip with flights: 409 text in the dialog, then unassign deletes the trip and keeps the flights', async () => {
    await go(`flights/${dl.id}`);
    await page.waitForSelector('[data-key="delete-trip"]');
    await page.locator('[data-key="delete-trip"]').click();
    await dlg().waitFor();
    ok(/Unassign 2 flights/.test(await dlgText()), 'unassign option');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await page.waitForFunction(() => /still has 2 flights/.test(document.querySelector('dialog.delete-dialog[open] .error')?.innerText || ''), null, { timeout: 5000 });
    eq((await api('/flights/trips')).trips.length, 1, 'trip still there');
    await dlg().locator('input[name="unassign"]').check();
    await confirmDel();
    await waitToast(/Deleted the trip Spring break/);
    await quiet();
    eq((await api('/flights/trips')).trips.length, 0, 'trip gone');
    ok(await flightByNo('10') && await flightByNo('11'), 'flights stay');
});

// ---- found flights ----
await check('Found flights: Delete all dismissed (3) with a count confirm; pending one untouched', async () => {
    await go('flights?tab=found&show=dismissed');
    await page.waitForSelector('[data-key="delete-dismissed"]');
    ok(/Delete all dismissed \(3\)/.test(await text('[data-key="delete-dismissed"]')), 'button count');
    await page.locator('[data-key="delete-dismissed"]').click();
    await dlg().waitFor();
    ok(/3 dismissed found-flight records/.test(await dlgText()), 'count in confirm');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted 3 dismissed found flights/);
    await quiet();
    const c = await api('/flights/candidates?status=all&limit=200');
    eq(c.counts.dismissed, 0); eq(c.counts.pending, 1);
});
await check('Found flights: one pending row Delete', async () => {
    await go('flights?tab=found');
    const del = page.locator('[data-key$=":delete"]').first();
    await del.waitFor();
    await del.click();
    await dlg().waitFor();
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted WN/);
    await quiet();
    eq((await api('/flights/candidates?status=all&limit=200')).counts.pending, 0);
});

// ---- places ----
await check('place drawer: counts, delete, toast, list refreshed', async () => {
    const p = (await api('/places')).places.find((x) => x.label === 'Pottery studio');
    await go(`places/${p.id}`);
    await page.waitForSelector('[data-key="delete-place"]');
    await page.locator('[data-key="delete-place"]').click();
    await dlg().waitFor();
    const t = await dlgText();
    ok(/2 rules/.test(t) && /revisions?/.test(t), `counts ${t.slice(0, 120)}`);
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted Pottery studio/);
    await quiet();
    eq(await apiStatus(`/places/${p.id}`), 404);
    ok(!(await page.locator('.content').innerText()).includes('Pottery studio'), 'gone from list');
});
await check('Needs a name: Delete all dismissed (2)', async () => {
    await go('places?tab=queue&show=dismissed');
    await page.waitForSelector('[data-key="delete-dismissed"]');
    ok(/\(2\)/.test(await text('[data-key="delete-dismissed"]')), 'count');
    await page.locator('[data-key="delete-dismissed"]').click();
    await dlg().waitFor();
    ok(/2 dismissed spots/.test(await dlgText()), 'confirm count');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted 2 dismissed spots/);
    await quiet();
    eq((await api('/places/suggestions?status=all')).counts.dismissed, 0);
    eq((await api('/places/suggestions?status=all')).counts.pending, 1);
});

// ---- deadlines ----
await check('deadline drawer: Delete permanently beside End; counts; toast', async () => {
    const d = (await api('/deadlines?status=all&limit=200')).deadlines.find((x) => x.title === 'Library card');
    await go(`deadlines/${d.id}`);
    await page.waitForSelector('[data-key="drawer-delete"]');
    ok(await page.locator('[data-key="drawer-end"]').count(), 'End is there too');
    await page.locator('[data-key="drawer-delete"]').click();
    await dlg().waitFor();
    ok(/1 revision/.test(await dlgText()), 'revision count');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted Library card/);
    await quiet();
    eq(await apiStatus(`/deadlines/${d.id}`), 404);
});
await check('Done tab row Delete', async () => {
    const d = (await api('/deadlines?status=all&limit=200')).deadlines.find((x) => x.title === 'Washer warranty claim');
    await go('deadlines?tab=done');
    await page.locator(`[data-key="delete:${d.id}"]`).click();
    await dlg().waitFor();
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted Washer warranty claim/);
    await quiet();
    eq(await apiStatus(`/deadlines/${d.id}`), 404);
    ok((await api('/deadlines?status=all&limit=200')).deadlines.some((x) => x.title === 'Keep me'), 'others stay');
});

// ---- preferences ----
await check('preference drawer: Delete permanently', async () => {
    const p = (await api('/preferences?limit=200')).preferences.find((x) => x.key === 'airline_seat');
    await go(`preferences/${p.id}`);
    await page.waitForSelector('[data-key="drawer-delete"]');
    await page.locator('[data-key="drawer-delete"]').click();
    await dlg().waitFor();
    ok(/2 revisions|1 revision/.test(await dlgText()), 'revision count');
    ok(!(await dlgText()).includes('aisle'), 'value not shown in the confirm');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted Airline seat/);
    await quiet();
    eq(await apiStatus(`/preferences/${p.id}`), 404);
});
await check('Removed list: row Delete works on a removed preference', async () => {
    const p = (await api('/preferences?removed=true&limit=200')).preferences.find((x) => x.key === 'spice_level');
    await go('preferences?removed=1');
    await page.locator(`[data-key="delete:${p.id}"]`).click();
    await dlg().waitFor();
    ok(/already removed/.test(await dlgText()), 'says removed');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted Spice level/);
    await quiet();
    eq(await apiStatus(`/preferences/${p.id}`), 404);
});

// ---- digests ----
await check('digest reader: strong confirm says the nightly job will not recreate a past day', async () => {
    await go('digests/daily/2026-03-01');
    await page.waitForSelector('[data-key="delete-digest"]');
    await page.locator('[data-key="delete-digest"]').click();
    await dlg().waitFor();
    const t = await dlgText();
    ok(/nightly job will not write this day again/.test(t) && /yesterday/.test(t), 'warning text');
    ok(/1 revision/.test(t), 'revision count');
    await dlg().locator('input[name="backup"]').uncheck();
    await confirmDel();
    await waitToast(/Deleted/);
    await quiet();
    eq(await apiStatus('/digests/daily/2026-03-01'), 404);
    eq(await apiStatus('/digests/daily/2026-03-02'), 200);
    ok(!(await hashNow()).includes('2026-03-01'), `left the reader: ${await hashNow()}`);
});

// ---- activity ----
await check('Activity shows the delete sentences', async () => {
    await go('activity');
    await page.waitForSelector('.content ul, .content ol');
    const t = (await page.locator('.content').innerText()).replace(/\s+/g, ' ');
    ok(/deleted the flight AA 500 DFW-LIT/.test(t), 'flight sentence');
    ok(/deleted the trip Spring break/.test(t), 'trip sentence');
    ok(/deleted the deadline Library card/.test(t), 'deadline sentence');
    ok(/deleted the preference/.test(t), 'preference sentence');
    ok(/deleted the place Pottery studio/.test(t), 'place sentence');
    ok(/deleted 3 dismissed found flights/.test(t), 'bulk sentence');
    ok(!/SECRETREF1|aisle|LC-INVENTED/.test(t), 'no private values');
});
await check('Activity filter Flights keeps the delete rows', async () => {
    await go('activity?type=flights');
    await page.waitForTimeout(400);
    ok(/deleted the flight/.test(await page.locator('.content').innerText()), 'sentence under Flights');
});

// ---- dark mode and 390 px: a fresh entry so the dialog can be opened again ----
await check('dark mode: the delete dialog is readable (red button, dark surface)', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await go('digests/daily/2026-03-02');
    await page.waitForSelector('[data-key="delete-digest"]');
    await page.locator('[data-key="delete-digest"]').click();
    await dlg().waitFor();
    const bg = await dlg().evaluate((d) => getComputedStyle(d).backgroundColor);
    const m = bg.match(/\d+/g).map(Number);
    ok(m[0] + m[1] + m[2] < 300, `dark surface ${bg}`);
});
await shot('delete-dialog-dark');
await check('390 px: the dialog fits, no sideways scroll, the red button is reachable', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(300);
    const box = await dlg().evaluate((d) => { const r = d.getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
    ok(box.l >= 0 && box.r <= box.w + 1, `dialog box ${JSON.stringify(box)}`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow');
    await dlg().getByRole('button', { name: 'Delete permanently' }).scrollIntoViewIfNeeded();
    ok(await dlg().getByRole('button', { name: 'Delete permanently' }).isVisible(), 'button visible');
});
await shot('delete-dialog-mobile');
await cancelDlg();
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 1280, height: 900 });
await check('Cancelled dialog deleted nothing: digest 2026-03-02 is still there', async () => eq(await apiStatus('/digests/daily/2026-03-02'), 200));
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
