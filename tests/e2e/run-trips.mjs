// Browser flow for the Trips dashboard page, against a SCRATCH hub seeded by trips-seed.js. Headless Chrome through
// playwright-core. Usage: node run-all.mjs trips (or node run-trips.mjs with BASE/KEY for a scratch hub).
// Env: BASE (default http://localhost:3999/admin/), KEY (admin key), SHOTS (output dir).
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
page.setDefaultTimeout(8000);
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

// Closing a drawer navigates back asynchronously; navigating before that settles can re-open it.
const settleDrawer = async () => {
    if (!(await page.locator('dialog.drawer[open]').count())) return;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
};
const go = async (hash) => { await settleDrawer(); await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); await page.waitForSelector('.content .view, .content .overview, .content h2', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(250); };
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

const shift = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };
const tripsApi = async () => (await api('/trips?limit=200')).trips;
const byTitle = async (title) => (await tripsApi()).find((t) => t.title === title);
const count = async (tab) => Number(await page.locator(`[data-count="${tab}"]`).innerText());
const card = (title) => page.locator('.trip-card', { has: page.locator(`a.row-link:text-is("${title}")`) });
const drawerOpen = () => page.waitForSelector('dialog.drawer[open] .drawer-section');
const closeDrawer = async () => { await settleDrawer(); };

await signIn();

// ---- navigation, tabs, cards ----
await check('g t opens Trips; nav item present', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g'); await page.keyboard.press('t');
    await page.waitForSelector('.view.trips');
    eq(await hashNow(), '#/trips', 'hash');
    ok(await page.locator('.rail-nav a', { hasText: 'Trips' }).count(), 'nav item');
});
await check('tab counts 1 / 1 / 2, Upcoming selected', async () => {
    eq(await count('upcoming'), 1); eq(await count('ongoing'), 1); eq(await count('past'), 2);
    eq(await page.locator('#tab-upcoming').getAttribute('aria-selected'), 'true');
});
await check('upcoming card: countdown, flight count, route, kind and phase chips; notes and reference not in the list', async () => {
    const t = await card('Spring break').innerText();
    ok(/Starts in \d+ days/.test(t), `countdown: ${t}`); ok(t.includes('1 flight') && t.includes('LIT → MCO'), 'flight and route');
    ok(t.includes('Leisure') && t.includes('Upcoming') && t.includes('Orlando') && t.includes('1 item'), 'chips, destination, items');
    ok(!(await page.locator('.content').innerHTML()).includes('HTL-INVENTED-77'), 'reference leaked');
});
await check('ongoing tab: day 2 of 5', async () => {
    await page.locator('#tab-ongoing').click(); await page.waitForSelector('#panel-ongoing');
    ok((await card('Conference week').innerText()).includes('Day 2 of 5'), 'countdown');
});
await check('past tab: past and cancelled with a Cancelled chip', async () => {
    await page.locator('#tab-past').click(); await page.waitForSelector('#panel-past');
    eq(await page.locator('.trip-card').count(), 2, 'cards');
    ok((await card('Called off trip').innerText()).includes('Cancelled'), 'chip');
    ok((await card('Old research visit').innerText()).includes('Past'), 'past chip');
});
await check('arrow keys move between tabs', async () => {
    await page.locator('#tab-past').focus(); await page.keyboard.press('Home');
    await page.waitForSelector('#panel-upcoming');
    eq(await hashNow(), '#/trips', 'hash');
});

// ---- suggestions ----
await check('a suggestion shows title, dates, route; dismiss hides it, Show dismissed again brings it back', async () => {
    await go('trips');
    const sug = page.locator('.sug-item');
    eq(await sug.count(), 1, 'suggestions');
    const t = await sug.innerText(); ok(/\d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d/.test(t) && t.includes('2 flights') && t.includes('LIT → ORD → LIT'), `text: ${t}`);
    ok((await sug.locator('input').inputValue()).includes('Mar 2027'), 'proposed title');
    await sug.getByRole('button', { name: /^Dismiss/ }).click(); await waitToast(/dismissed/); await quiet();
    eq(await page.locator('.sug-item').count(), 0, 'gone');
    await page.getByRole('button', { name: /dismissed suggestion again/ }).click(); await quiet();
    eq(await page.locator('.sug-item').count(), 1, 'back');
});
await shot('trips-list');

// ---- create, link a flight, items ----
let tripId;
await check('New trip: validation, then create', async () => {
    await page.locator('[data-key="new-trip"]').click();
    await page.waitForSelector('dialog.drawer[open] input[name="title"]');
    await page.locator('dialog.drawer[open] button[type="submit"]').click();
    ok((await text('dialog.drawer[open] .error')).includes('Give the trip a title'), 'title error');
    await page.fill('dialog.drawer[open] input[name="title"]', 'E2E trip');
    await page.fill('dialog.drawer[open] input[name="destination"]', 'Denver');
    await page.fill('dialog.drawer[open] input[name="start_date"]', shift(40));
    await page.fill('dialog.drawer[open] input[name="end_date"]', shift(35));
    await page.locator('dialog.drawer[open] button[type="submit"]').click();
    ok((await text('dialog.drawer[open] .error')).includes('end date cannot be before'), 'date error');
    await page.fill('dialog.drawer[open] input[name="end_date"]', shift(44));
    await page.locator('dialog.drawer[open] button[type="submit"]').click();
    await waitToast(/E2E trip added/); await quiet();
    const t = await byTitle('E2E trip'); ok(t && t.destination === 'Denver' && t.phase === 'upcoming', `created: ${JSON.stringify(t)} err=${await page.locator('dialog.drawer[open] .error').allInnerTexts()} toasts=${await toasts()}`);
    tripId = t.id;
    ok(await card('E2E trip').count(), 'card in Upcoming');
});
await check('the drawer opens from the card at #/trips/<id>', async () => {
    await card('E2E trip').locator('a.row-link').click(); await drawerOpen();
    eq(await hashNow(), `#/trips/${tripId}`);
    ok((await text('dialog.drawer[open] .trip-state')).includes('Upcoming'), 'state');
});
await check('link a loose flight; picker says when a flight would move; linking moves it from another trip', async () => {
    const picker = page.locator('[data-key="flight-picker"]');
    const opts = await picker.locator('option').allInnerTexts();
    ok(opts.some((o) => o.includes('AA 900')) && opts.some((o) => o.includes('AA 500') && o.includes('on Spring break')), `options: ${opts.join(' | ')}`);
    const v500 = await picker.locator('option', { hasText: 'AA 500' }).getAttribute('value');
    await picker.selectOption(v500);
    ok((await text('dialog.drawer[open] .drawer-section [aria-live="polite"]')).includes('moves it here'), 'move note');
    const v900 = await picker.locator('option', { hasText: 'AA 900' }).getAttribute('value');
    await picker.selectOption(v900);
    await page.locator('[data-key="link-flight"]').click(); await waitToast(/AA 900/); await quiet();
    ok((await text('dialog.drawer[open] #td-flights')).includes('Flights, 1'), 'heading');
    ok((await page.locator('dialog.drawer[open] [data-flight]').innerText()).includes('AA 900'), 'row');
    eq((await byTitle('E2E trip')).flight_count, 1, 'api');
    await picker.selectOption(await picker.locator('option', { hasText: 'AA 500' }).getAttribute('value'));
    await page.locator('[data-key="link-flight"]').click(); await waitToast(/Moved/); await quiet();
    eq((await byTitle('Spring break')).flight_count, 0, 'moved off Spring break');
    await page.getByRole('button', { name: /Take AA 500.* off this trip/ }).click(); await waitToast(/off this trip/); await quiet();
    eq((await byTitle('E2E trip')).flight_count, 1, 'unlinked AA 500, AA 900 stays');
});
await check('add an item; its reference is hidden until Show reference', async () => {
    await page.locator('[data-key="add-item"]').click();
    await page.waitForSelector('.trip-item-form input[name="title"]');
    await page.locator('.trip-item-form button[type="submit"]').click();
    ok((await text('.trip-item-form .error')).includes('Give the item a title'), 'title error');
    await page.fill('.trip-item-form input[name="title"]', 'Airport shuttle');
    await page.locator('.trip-item-form select[name="kind"]').selectOption('ground');
    await page.fill('.trip-item-form input[name="reference"]', 'SHUTTLE-INVENTED-1');
    await page.locator('.trip-item-form button[type="submit"]').click(); await waitToast(/Item added/); await quiet();
    const li = page.locator('dialog.drawer[open] [data-item]');
    ok((await li.innerText()).includes('Airport shuttle') && (await li.innerText()).includes('Ground travel'), 'row');
    ok(!(await page.locator('dialog.drawer[open]').innerHTML()).includes('SHUTTLE-INVENTED-1'), 'reference in the DOM before Show');
    await li.getByRole('button', { name: /Show the reference/ }).click(); await page.waitForSelector('.item-ref:not(:empty)');
    ok((await text('.item-ref')).includes('SHUTTLE-INVENTED-1'), 'shown');
    await li.getByRole('button', { name: /Hide the reference/ }).click();
    ok(!(await page.locator('dialog.drawer[open]').innerHTML()).includes('SHUTTLE-INVENTED-1'), 'hidden again');
});
await check('edit an item, then remove it after a confirm', async () => {
    await page.getByRole('button', { name: 'Edit Airport shuttle' }).click();
    await page.waitForSelector('.trip-item-form input[name="title"]');
    ok((await page.inputValue('.trip-item-form input[name="reference"]')) === 'SHUTTLE-INVENTED-1', 'reference prefilled');
    await page.fill('.trip-item-form input[name="title"]', 'Airport taxi');
    await page.locator('.trip-item-form button[type="submit"]').click(); await waitToast(/Item saved/); await quiet();
    ok((await text('dialog.drawer[open] [data-item]')).includes('Airport taxi'), 'renamed');
    await page.getByRole('button', { name: 'Remove Airport taxi' }).click(); await confirmYes(); await waitToast(/removed/); await quiet();
    eq(await page.locator('dialog.drawer[open] [data-item]').count(), 0, 'gone');
});

// ---- edit, history, cancel ----
await check('edit the trip; history gets a revision; Restore brings the old title back', async () => {
    await page.fill('dialog.drawer[open] input[name="title"]', 'E2E trip renamed');
    await page.locator('[data-key="tf-save"]').click(); await waitToast(/Changes saved/); await quiet();
    eq((await byTitle('E2E trip renamed')).rev, 2, 'rev');
    ok((await text('#td-history')).includes('History, 2 revisions'), 'history heading');
    await page.getByRole('button', { name: 'Restore revision 1' }).click(); await confirmYes(); await waitToast(/Revision 1 restored/); await quiet();
    ok(await byTitle('E2E trip'), 'title restored');
});
await shot('trips-drawer');
await check('Cancelled toggle moves the trip to Past with a Cancelled chip', async () => {
    await page.locator('dialog.drawer[open] input[name="status_override"]').check();
    await page.locator('[data-key="tf-save"]').click(); await waitToast(/Changes saved/); await quiet();
    eq((await byTitle('E2E trip')).phase, 'cancelled', 'phase');
    ok((await text('dialog.drawer[open] .trip-state')).includes('Cancelled'), 'chip in the drawer');
    await page.locator('dialog.drawer[open] input[name="status_override"]').uncheck();
    await page.locator('[data-key="tf-save"]').click(); await waitToast(/Changes saved/); await quiet();
    eq((await byTitle('E2E trip')).phase, 'upcoming', 'back');
});

// ---- accept a suggestion ----
await check('accept a suggestion with a new name: trip with both flights, suggestion gone', async () => {
    await closeDrawer(); await go('trips');
    const input = page.locator('.sug-item input');
    await input.fill('Chicago visit');
    await page.getByRole('button', { name: /^Accept/ }).click(); await waitToast(/Chicago visit added/); await quiet();
    const t = await byTitle('Chicago visit'); ok(t, 'trip'); eq(t.flight_count, 2, 'flights'); eq(t.kind, 'other', 'kind');
    eq(await page.locator('.sug-item').count(), 0, 'suggestion gone');
    ok(await card('Chicago visit').count(), 'card');
});

// ---- delete ----
await check('Delete permanently: counts in the dialog, flights are unassigned, not deleted', async () => {
    await go(`trips/${tripId}`); await drawerOpen();
    await page.locator('[data-key="drawer-delete"]').click();
    await page.waitForSelector('dialog[open].delete-dialog');
    const d = await text('dialog[open].delete-dialog'); ok(d.includes('The trip E2E trip') && d.includes('0 items') && d.includes('1 flight'), `dialog: ${d.slice(0, 200)}`);
    await page.locator('dialog[open] input[name="unassign"]').check();
    await page.locator('dialog[open] input[name="backup"]').uncheck();
    await page.locator('dialog.delete-dialog button[type="submit"]').click(); await waitToast(/Deleted the trip E2E trip/); await quiet();
    ok(!(await byTitle('E2E trip')), 'trip gone');
    const f = (await api('/flights?limit=500')).flights.find((x) => x.flight_number === '900');
    ok(f && f.trip_id == null, 'flight stays, unlinked');
});

// ---- activity, palette, small screen ----
await check('Activity shows the trip rows in plain words', async () => {
    await go('activity?type=trips');
    const t = await text('.content');
    ok(t.includes('added the trip') && t.includes('deleted the trip') && t.includes('made the suggested trip'), `rows: ${t.replace(/\s+/g, ' ').slice(0, 600)}`);
});
await check('palette finds a trip and the New trip action', async () => {
    await go('overview'); await page.keyboard.press('Control+k'); await page.waitForSelector('dialog[open] input');
    await page.fill('dialog[open] input', 'Spring');
    ok((await text('dialog[open]')).includes('Spring break'), 'trip entry');
    await page.fill('dialog[open] input', 'New trip');
    ok((await text('dialog[open]')).includes('New trip'), 'action');
    await page.keyboard.press('Escape');
});
await check('390 px: no sideways scroll on the list and the drawer', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await go('trips');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'list overflow');
    const id = (await byTitle('Spring break')).id;
    await go(`trips/${id}`); await drawerOpen();
    ok(await page.evaluate(() => { const b = document.querySelector('dialog.drawer').getBoundingClientRect(); return b.width <= window.innerWidth + 1; }), 'drawer width');
});
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
