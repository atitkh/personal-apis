// Browser flow checks for flight data sources (stage B): Live details, locks, Refresh, Data sources card. SCRATCH hub only.
// Run: ./reset.sh; seed with sources-seed.js (see FLIGHTS_PROGRESS.md), then node run-sources.mjs. Env: BASE, KEY, SHOTS as in run.mjs.
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import lib from './lib.js';

const require = createRequire(import.meta.url);

const BASE = lib.assertScratchUrl(process.env.BASE || `http://localhost:${process.env.E2E_PORT || 3999}/admin/`);
const KEY = process.env.KEY || lib.KEY;
const SHOTS = lib.shotsDir();
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

const browser = await lib.launchBrowser();
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
    execSync(`python3 -I ${new URL('./shrink.py', import.meta.url).pathname} ${raw} ${SHOTS}/${name}.jpg && rm ${raw}`);
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
const ids = JSON.parse(fs.readFileSync(`file://${process.env.E2E_OUT}/sources-ids.json`, 'utf8'));
const drawer = 'dialog.drawer[open]';
const openFlight = async (id) => { await go(`flights/${id}`); await page.waitForSelector(`${drawer} .live-details`); };
const closeDrawer = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]') && !/#\/flights\/\d+/.test(location.hash)); };
await signIn();

/* ---------- drawer: live details ---------- */
await openFlight(ids.live);
await check('Live details: estimated time, terminal, gate, belt, aircraft and registration render, with a +25 min chip', async () => {
    const t = await text(`${drawer} .live-details`);
    ok(t.includes('08:35'), `estimated departure 08:35 in ${t.slice(0, 200)}`);
    ok(/Gate\s*B12/.test(t) && /Terminal\s*B/.test(t), 'dep gate and terminal');
    ok(/Gate\s*C27/.test(t), 'arr gate');
    ok(/Baggage belt\s*4/.test(t), 'belt');
    ok(t.includes('B738') && t.includes('N123AA'), 'aircraft');
    eq((await text(`${drawer} .delay-chip`)).trim(), '+25 min');
});
await check('Live details: no cancelled hint on a flight no source cancelled', async () => eq(await page.locator(`${drawer} .cancel-hint`).count(), 0));
await check('Edit fields show the values the source filled and no lock chip yet', async () => {
    eq(await page.locator(`${drawer} input[name="dep_gate"]`).inputValue(), 'B12');
    eq(await page.locator(`${drawer} input[name="est_dep"]`).inputValue(), '2026-12-24T08:35');
    eq(await page.locator(`${drawer} .lock-note`).count(), 0);
});
await shot('live-drawer');
await closeDrawer();

await openFlight(ids.cancelled);
await check('Cancelled hint shows its text, status stays Automatic', async () => {
    const hint = await text(`${drawer} .cancel-hint`);
    eq(hint, 'A data source reports this flight as cancelled. Set the status yourself if it is true.');
    ok((await text(`${drawer} .cancel-hint-chip`)).includes('A source says cancelled'));
    eq(await page.locator(`${drawer} select[name="status"]`).inputValue(), 'auto');
    ok(!(await api(`/flights/${ids.cancelled}`)).status.includes('cancelled'), 'status not changed by the source');
});
await closeDrawer();

/* ---------- refresh with no key ---------- */
await openFlight(ids.plain);
await check('Refresh from sources with no key: per-source result says not configured, Gmail is not asked', async () => {
    ok(/No source has a key yet/.test(await text(`${drawer} .refresh-bar`)), 'hint');
    await page.locator(`${drawer} [data-key="refresh-flight"]`).click();
    await page.waitForSelector(`${drawer} [data-key="refresh-result"]`);
    const r = await text(`${drawer} [data-key="refresh-result"]`);
    ok(/AeroDataBox:\s*not configured/.test(r), r);
    ok(!/Gmail/.test(r), 'gmail is push only');
});
await check('Force option is a checkbox and Refresh stays enabled', async () => {
    ok(await page.locator(`${drawer} [data-key="refresh-force"]`).count());
    eq(await page.locator(`${drawer} [data-key="refresh-flight"]`).isDisabled(), false);
});

/* ---------- lock chip ---------- */
await check('Hand-editing a gate locks it: lock chip with Unlock, one-line explanation, API agrees', async () => {
    await page.locator(`${drawer} details.live-edit summary`).click();
    await page.fill(`${drawer} input[name="dep_gate"]`, 'a7');
    await page.locator(`${drawer} [data-key="ff-save"]`).click();
    await waitToast(/Changes saved/);
    await page.waitForSelector(`${drawer} [data-lock="dep_gate"]`);
    const note = await text(`${drawer} [data-lock="dep_gate"]`);
    ok(/Edited by hand/.test(note) && /Sources will not overwrite it/.test(note) && /Unlock/.test(note), note);
    ok((await text(`${drawer} .lock-hint`)).includes('Fields you edit here are locked so sources do not overwrite them.'));
    ok((await api(`/flights/${ids.plain}`)).locked_fields.includes('dep_gate'));
    ok(/Gate\s*A7/.test(await text(`${drawer} .live-details`)), 'live details show A7');
});
await check('Unlock clears the lock and keeps the value', async () => {
    await page.locator(`${drawer} [data-key="unlock:dep_gate"]`).click();
    await waitToast(/unlocked/);
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open] [data-lock="dep_gate"]'));
    const f = await api(`/flights/${ids.plain}`);
    ok(!f.locked_fields.includes('dep_gate'), 'lock gone');
    eq(f.dep_gate, 'A7');
});
await closeDrawer();

/* ---------- list ---------- */
await go('flights?tab=flights');
await check('List row shows gate text and the delay chip only where known', async () => {
    const row = page.locator('tr', { has: page.locator(`[data-key="flight:${ids.live}"]`) });
    ok(/Terminal B, gate B12/.test(await row.innerText()), 'gate text');
    eq((await row.locator('.delay-chip').innerText()).trim(), '+25 min');
    const other = page.locator('tr', { has: page.locator(`[data-key="flight:${ids.cancelled}"]`) });
    eq(await other.locator('.delay-chip, .live-note').count(), 0);
    eq((await row.locator('.status-chip').innerText()).trim(), 'Scheduled');
});

/* ---------- Data sources card ---------- */
await check('Data sources card lists both sources with chips, hints, usage; no key anywhere', async () => {
    const card = page.locator('.sources-card');
    eq(await card.locator('.source-row').count(), 2);
    const t = await card.innerText();
    ok(t.includes('AeroDataBox') && t.includes('Gmail'), 'names');
    ok(/Needs AERODATABOX_API_KEY in the hub \.env/.test(t), 'aero hint');
    ok(t.includes('Filled by the Gmail status scan, no key'), 'gmail hint');
    ok(/Not configured/.test(await card.locator('[data-source="aerodatabox"] .chip').first().innerText()), 'aero chip');
    ok(/^Configured/.test(await card.locator('[data-source="gmail"] .chip').first().innerText()), 'gmail chip');
    ok(/0 \/ 80 calls this month/.test(t), 'usage text');
    ok(/on demand only/i.test(t), 'on demand sentence');
    ok(!/\bnull\b|undefined/.test(t), 'no stray null text');
    const names = (await api('/flights/sources')).sources.flatMap((x) => Object.keys(x));
    ok(!names.some((k) => /key|secret|token/i.test(k)), `source fields ${names.join()}`);
});
await check('Cap field refuses nonsense with a message and saves nothing', async () => {
    await page.fill('[data-key="src-cap:aerodatabox"]', '-5');
    await page.locator('[data-key="src-save"]').click();
    ok(/whole number/.test(await text('.sources-card .error')), 'error text');
    const s = await api('/flights/sources');
    eq(s.sources.find((x) => x.name === 'aerodatabox').monthly_cap, 80);
});
await check('Switch, priority and cap save and survive a reload', async () => {
    await go('flights?tab=flights');
    await page.locator('[data-key="src-on:aerodatabox"]').click();
    await page.locator('[data-key="down:aerodatabox"]').click();
    await page.fill('[data-key="src-cap:aerodatabox"]', '50');
    await page.locator('[data-key="src-save"]').click();
    await waitToast(/Data sources saved/);
    await page.reload();
    await page.waitForSelector('.sources-card .source-row');
    const names = await page.locator('.sources-card .source-row').evaluateAll((els) => els.map((e) => e.dataset.source));
    eq(names.join(','), 'gmail,aerodatabox');
    eq(await page.locator('[data-key="src-on:aerodatabox"]').getAttribute('aria-checked'), 'false');
    eq(await page.locator('[data-key="src-cap:aerodatabox"]').inputValue(), '50');
    ok(/0 \/ 50 calls this month/.test(await text('.sources-card')), 'usage reads the new cap');
    const s = await api('/flights/sources');
    const a = s.sources.find((x) => x.name === 'aerodatabox');
    eq(a.enabled, false); eq(a.monthly_cap, 50); ok(a.priority > s.sources.find((x) => x.name === 'gmail').priority, 'priority order');
});
await page.locator('.sources-card').scrollIntoViewIfNeeded();
await shot('sources-card');
await check('With every pull source off the drawer Refresh is disabled with a hint', async () => {
    await openFlight(ids.plain);
    eq(await page.locator(`${drawer} [data-key="refresh-flight"]`).isDisabled(), true);
    ok(/No source is switched on/.test(await text(`${drawer} [data-key="refresh-hint"]`)));
    await closeDrawer();
});
await check('Switching AeroDataBox back on re-enables Refresh', async () => {
    await go('flights?tab=flights');
    await page.locator('[data-key="src-on:aerodatabox"]').click();
    await page.locator('[data-key="src-save"]').click();
    await waitToast(/Data sources saved/);
    await openFlight(ids.plain);
    eq(await page.locator(`${drawer} [data-key="refresh-flight"]`).isDisabled(), false);
    await closeDrawer();
});

/* ---------- dark mode and 390 px ---------- */
await page.emulateMedia({ colorScheme: 'dark' });
await openFlight(ids.live);
await check('Dark mode: Live details and chips use dark surfaces and stay readable', async () => {
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('dialog.drawer[open]')).backgroundColor);
    const m = bg.match(/\d+/g).map(Number);
    ok(m[0] < 80 && m[1] < 80 && m[2] < 90, `drawer background ${bg}`);
    const chip = await page.evaluate(() => getComputedStyle(document.querySelector('dialog.drawer[open] .delay-chip')).backgroundColor);
    ok(chip !== 'rgba(0, 0, 0, 0)' && chip !== bg, `chip ${chip}`);
});
await shot('live-dark');
await closeDrawer();
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 390, height: 844 });
await openFlight(ids.live);
await check('390 px: drawer Live details stack in one column, no sideways scroll', async () => {
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('dialog.drawer[open] .live-grid')).gridTemplateColumns.split(' ').length);
    eq(cols, 1);
    const w = await page.evaluate(() => { const d = document.querySelector('dialog.drawer[open]'); return [d.scrollWidth, d.clientWidth]; });
    ok(w[0] <= w[1], `drawer scrollWidth ${w[0]} > ${w[1]}`);
});
await closeDrawer();
await go('flights?tab=flights');
await check('390 px: Data sources card stacks and the page does not scroll sideways', async () => {
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    ok(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
    const box = await page.locator('.sources-card').boundingBox();
    ok(box.width <= 390, `card width ${box.width}`);
    const r = await page.locator('.source-row').first().boundingBox();
    ok(r.x >= 0 && r.x + r.width <= 390, 'row inside the screen');
});
await page.locator('.sources-card').scrollIntoViewIfNeeded();
await shot('sources-mobile');
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
