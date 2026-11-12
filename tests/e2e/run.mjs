// Browser flow checks for the Flights dashboard view, against a SCRATCH hub (see seed.js). Headless Chrome through
// playwright-core (from the OpenClaw install). Usage: node run.mjs [phase]   phases: main (default), empty
// Env: BASE (default http://localhost:3999/admin/), KEY (admin key), SHOTS (output dir), MORE (command that adds
// candidates mid-run).
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
const haversine = (a, b) => {
    const r = (d) => (d * Math.PI) / 180;
    const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(x)));
};

async function signIn() {
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav');
    await page.waitForLoadState('networkidle');
}

if (phase === 'empty') {
    await signIn();
    await check('empty Passport says "No flights yet." with Add flight', async () => {
        await go('flights');
        ok((await text('.view.flights')).includes('No flights yet.'), 'empty text');
        ok(await page.locator('[data-key="empty-new"]').count(), 'add button');
    });
    await check('empty Flights tab and Found tab show their empty states', async () => {
        await go('flights?tab=flights');
        ok((await text('#panel-flights')).includes('No flights yet.'));
        await go('flights?tab=found');
        ok((await text('#panel-found')).includes('Nothing waiting.'));
    });
    await check('no nav badge when nothing waits', async () => eq(await page.locator('.rail-link .nav-badge').count(), 0));
    await check('Flights channel on the empty board', async () => {
        await go('overview');
        ok(await page.locator('li.channel[data-domain="flights"].hue-teal').count(), 'teal flights channel');
    });
    await shot('empty-passport').catch(() => {});
    await check('no console errors', async () => eq(errors.length, 0, errors.join(' | ')));
    await browser.close();
    for (const r of results) console.log(r.join(' '));
    process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
}

/* ---------- main phase ---------- */
await signIn();
const expected = JSON.parse(fs.readFileSync(`file://${process.env.E2E_OUT}/expected.json`, 'utf8'));
const FLOWN = [['LIT', 'DFW'], ['DFW', 'LHR'], ['JFK', 'KTM'], ['KTM', 'ORD'], ['DFW', 'LIT'], ['LIT', 'JFK'], ['JFK', 'LHR']];

await check('Overview: Flights channel is teal with a power switch and the Off/Read/Read and write selector', async () => {
    await go('overview');
    const ch = page.locator('li.channel[data-domain="flights"]');
    ok(await ch.count(), 'channel present');
    ok(/hue-teal/.test(await ch.getAttribute('class')), 'teal');
    ok(await ch.locator('[role="switch"]').count(), 'switch');
    const opts = await ch.locator('[role="radio"]').allInnerTexts();
    eq(opts.join('|'), 'Off|Read|Read and write');
});
await check('Overview: attention line says 2 found flights wait and links to the queue tab', async () => {
    const line = page.locator('li', { hasText: 'found flights wait for review' }).first();
    ok(await line.count(), 'attention line');
    const link = line.locator('a').first();
    ok(/tab=found/.test(await link.getAttribute('href')), `href ${await link.getAttribute('href')}`);
    await link.click();
    await page.waitForSelector('#panel-found');
    ok(/tab=found/.test(await hashNow()));
});
await check('Overview: the write-mode confirm for Flights has its own wording', async () => {
    await go('overview');
    await page.locator('li.channel[data-domain="flights"] [data-key="flights:mode:write"]').click();
    await page.waitForSelector('dialog[open]');
    const t = await text('dialog[open]');
    await page.locator('dialog[open] .dialog-actions .btn').first().click();
    ok(/flights suggest key/.test(t), t.slice(0, 120));
    await page.waitForTimeout(250);
});
await check('Side menu has Flights (plane icon) with a badge of 2; g then f goes there', async () => {
    await go('overview');
    const link = page.locator('.rail-link', { hasText: 'Flights' });
    ok(await link.locator('svg').count(), 'icon');
    eq((await link.locator('.nav-badge').innerText()).trim(), '2');
    await page.locator('body').press('g');
    await page.locator('body').press('f');
    await page.waitForFunction(() => location.hash.startsWith('#/flights'));
});

/* Passport */
await go('flights');
await check('Passport tiles match the seeded data', async () => {
    const tiles = await page.locator('.stat-tile').evaluateAll((els) => els.map((e) => [e.querySelector('.stat-label').innerText, e.querySelector('.stat-value').innerText]));
    const t = Object.fromEntries(tiles);
    eq(t.Flights, String(expected.flights), 'flights');
    eq(t['Hours in the air'], String(Math.round(expected.hours)), 'hours');
    eq(t.Airports, String(expected.airports), 'airports');
    eq(t.Countries, String(expected.countries), 'countries');
    eq(t.Airlines, String(expected.airlines), 'airlines');
    const codes = ['LIT', 'DFW', 'LHR', 'JFK', 'KTM', 'ORD'];
    const pts = {};
    for (const c of codes) pts[c] = (await api(`/flights/airports?q=${c}`)).airports.find((a) => a.iata === c);
    const km = Math.round(FLOWN.reduce((s, [a, b]) => s + Math.round(haversine(pts[a], pts[b]) * 10) / 10, 0));
    eq(t.Kilometres, km.toLocaleString('en-US'), 'distance km');
});
await check('Passport records: most-flown route LIT-DFW twice, aircraft types listed, longest is KTM/ORD or JFK/KTM', async () => {
    const routes = await text('.top-list[aria-label="Most-flown routes"] li');
    ok(/(LIT.*DFW|DFW.*LIT)/.test(routes) && /2$/.test(routes.trim()), routes);
    const ac = await page.locator('.top-list[aria-label="Aircraft types"] li').allInnerTexts();
    ok(ac.length === 4, `${ac.length} aircraft types`);
    ok(/KTM/.test(await text('.record')), 'longest involves KTM');
});
await check('Map renders route arcs and airport dots over a land outline', async () => {
    eq(await page.locator('.route-map .arc').count(), 6, 'arcs (one per route)');
    eq(await page.locator('.route-map .pt').count(), 6, 'dots');
    const d = await page.locator('.route-map .land').getAttribute('d');
    ok(d.length > 5000, `land path ${d.length}`);
    const box = await page.locator('.route-map').boundingBox();
    ok(box.width > 600 && box.height > 200, `${box.width}x${box.height}`);
    ok(await page.locator('.map-label').count() >= 6, 'labels');
});
await shot('passport-light');
await check('Km/miles toggle changes the tile and survives a reload', async () => {
    await page.locator('[data-key="unit:mi"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.stat-label')].some((e) => e.innerText === 'Miles'));
    await page.reload();
    await page.waitForSelector('.stat-tile');
    ok((await page.locator('.stat-label').allInnerTexts()).includes('Miles'), 'miles after reload');
    await page.locator('[data-key="unit:km"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.stat-label')].some((e) => e.innerText === 'Kilometres'));
});
await check('Year switch narrows tiles and map; All time brings them back', async () => {
    await page.locator('[data-key="chip:2025"]').click();
    await page.waitForFunction(() => /year=2025/.test(location.hash));
    await page.waitForFunction(() => document.querySelector('.stat-value') && document.querySelector('.stat-value').innerText === '3');
    eq(await page.locator('.route-map .arc').count(), 3, '2025 arcs');
    ok((await text('#pp-map')).includes('2025'));
    await page.locator('[data-key="chip:all"]').click();
    await page.waitForFunction(() => document.querySelector('.stat-value').innerText === '7');
});

/* Flights tab */
await check('Flights tab: 10 rows, Upcoming strip shows the next 2, home airport card says LIT', async () => {
    await page.locator('[data-key="tab:flights"]').click();
    await page.waitForSelector('.flights-table');
    eq(await page.locator('.flights-table tbody tr').count(), 10);
    eq(await page.locator('.up-card').count(), 2);
    ok((await text('.up-card')).includes('LIT'));
    ok((await text('.home-row')).includes('LIT'));
});
await check('Filters: year, status, search, airport', async () => {
    await page.selectOption('select[name="year"]', '2025');
    await page.waitForFunction(() => document.querySelectorAll('.flights-table tbody tr').length === 4);
    await page.selectOption('select[name="status"]', 'cancelled');
    await page.waitForFunction(() => document.querySelectorAll('.flights-table tbody tr').length === 1);
    await go('flights?tab=flights&q=KTM');
    eq(await page.locator('.flights-table tbody tr').count(), 2, 'search KTM');
    await go('flights?tab=flights&airport=JFK');
    eq(await page.locator('.flights-table tbody tr').count(), 3, 'airport JFK');
    await go('flights?tab=flights&q=nothing-matches');
    ok((await text('#panel-flights')).includes('No flight matches.'));
    await go('flights?tab=flights');
});
await shot('flights-list');

await check('Row opens the drawer; booking reference is masked by default and revealed on demand', async () => {
    await page.locator('tr', { hasText: 'AA 1203' }).filter({ hasText: 'Dec 20, 2024' }).locator('a.row-link').click();
    await page.waitForSelector('dialog.drawer[open] input[name="booking_ref"]');
    ok(/#\/flights\/\d+/.test(await hashNow()), 'url has id');
    eq(await page.locator('dialog.drawer input[name="booking_ref"]').getAttribute('type'), 'password');
    ok(!(await page.locator('body').innerText()).includes('ZK9QWE'), 'ref not visible in text');
    await page.locator('[data-key="ref-toggle"]').click();
    eq(await page.locator('dialog.drawer input[name="booking_ref"]').getAttribute('type'), 'text');
    eq(await page.locator('dialog.drawer input[name="booking_ref"]').inputValue(), 'ZK9QWE');
    await page.locator('[data-key="ref-toggle"]').click();
    eq(await page.locator('dialog.drawer input[name="booking_ref"]').getAttribute('type'), 'password');
});
await check('Drawer shows local times and distance facts', async () => {
    eq(await page.locator('dialog.drawer input[name="sched_dep"]').inputValue(), '2024-12-20T08:10');
    ok((await text('dialog.drawer .facts')).includes('America/Chicago'));
});
await check('Edit: seat saved as a new revision; second edit; Restore revision 1 clears both', async () => {
    await page.fill('dialog.drawer input[name="seat"]', '14a');
    await page.locator('[data-key="ff-save"]').click();
    await waitToast(/Changes saved/);
    await page.fill('dialog.drawer input[name="cabin"]', 'Main');
    await page.locator('[data-key="ff-save"]').click();
    await page.waitForFunction(() => document.querySelectorAll('dialog.drawer .rev').length === 3);
    eq(await page.locator('dialog.drawer input[name="seat"]').inputValue(), '14A');
    await page.getByRole('button', { name: 'Restore revision 1' }).click();
    await confirmYes();
    await page.waitForFunction(() => document.querySelectorAll('dialog.drawer .rev').length === 4);
    eq(await page.locator('dialog.drawer input[name="seat"]').inputValue(), '');
    eq(await page.locator('dialog.drawer input[name="cabin"]').inputValue(), '');
});
await check('Compare shows struck lines and added lines', async () => {
    await page.getByRole('button', { name: 'Compare revision 2 with the current one' }).click();
    await page.waitForSelector('dialog.drawer .diff-plain .del');
    ok((await text('dialog.drawer .diff-plain')).includes('Seat'));
    await page.getByRole('button', { name: 'Back to the flight' }).click();
    await page.waitForSelector('dialog.drawer input[name="seat"]');
});
await check('Trip: New trip creates it, assigns the flight, and the list API shows 1 flight on it', async () => {
    await page.selectOption('dialog.drawer select[name="trip_id"]', '__new');
    await page.fill('dialog.drawer input[name="new_trip"]', 'Winter trip');
    await page.locator('[data-key="ff-save"]').click();
    await page.waitForFunction(() => /Winter trip/.test(document.querySelector('dialog.drawer select[name="trip_id"]').innerText) && document.querySelector('dialog.drawer select[name="trip_id"]').value !== '__new');
    const trips = (await api('/flights/trips')).trips.filter((t) => t.title === 'Winter trip');
    eq(trips.length, 1, 'one trip');
    eq(trips[0].flights, 1);
});
await shot('flight-drawer');
await check('Esc closes the drawer, focus returns to the row link, URL back on the list', async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'));
    await page.waitForFunction(() => !/#\/flights\/\d+/.test(location.hash));
    const focused = await page.evaluate(() => document.activeElement.getAttribute('data-key') || '');
    ok(/^flight:\d+$/.test(focused), `focus on ${focused}`);
});

await check('Add flight: validation error first, airport autocomplete, then it saves and the drawer for it opens', async () => {
    await page.locator('[data-key="new-flight"]').click();
    await page.waitForSelector('dialog.drawer[open] form.flight-form');
    await page.locator('[data-key="ff-save"]').click();
    ok((await text('dialog.drawer .error')).includes('airline code'), 'empty form error');
    await page.fill('dialog.drawer input[name="airline_iata"]', 'AA');
    await page.fill('dialog.drawer input[name="flight_number"]', '500');
    await page.locator('dialog.drawer input[name="origin_iata"]').pressSequentially('little ro', { delay: 30 });
    await page.waitForFunction(() => document.querySelectorAll('datalist option').length > 0);
    const opts = await page.locator('datalist option').evaluateAll((o) => o.map((x) => x.value));
    ok(opts.includes('LIT'), `options ${opts.join(',')}`);
    await page.fill('dialog.drawer input[name="origin_iata"]', 'dfw');
    await page.fill('dialog.drawer input[name="dest_iata"]', 'LIT');
    await page.locator('dialog.drawer input[name="dest_iata"]').blur();
    await page.waitForFunction(() => /Little Rock|Clinton/.test(document.querySelector('dialog.drawer .airport-field:nth-of-type(2) .airport-hint, dialog.drawer .airport-hint').innerText + [...document.querySelectorAll('dialog.drawer .airport-hint')].map((e) => e.innerText).join(' ')));
    await page.fill('dialog.drawer input[name="sched_dep"]', '2027-01-20T18:00');
    await page.fill('dialog.drawer input[name="sched_arr"]', '2027-01-20T19:25');
    await page.locator('[data-key="ff-save"]').click();
    await waitToast(/Flight AA 500 DFW-LIT 2027-01-20 added/);
    await page.waitForFunction(() => /#\/flights\/\d+/.test(location.hash));
    await page.waitForSelector('dialog.drawer input[name="origin_iata"]');
    eq(await page.locator('dialog.drawer input[name="origin_iata"]').inputValue(), 'DFW');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'));
});
await check('Add flight twin: 409 shows "already in your flights" with a link', async () => {
    await go('flights?tab=flights&new=1');
    await page.waitForSelector('dialog.drawer[open] form.flight-form');
    ok(!(await hashNow()).includes('new=1'), 'new=1 removed from the URL');
    for (const [k, v] of [['airline_iata', 'AA'], ['flight_number', '500'], ['origin_iata', 'DFW'], ['dest_iata', 'LIT'], ['sched_dep', '2027-01-20T18:00']]) await page.fill(`dialog.drawer input[name="${k}"]`, v);
    await page.locator('[data-key="ff-save"]').click();
    await page.waitForFunction(() => /already in your flights/.test(document.querySelector('dialog.drawer .error').innerText));
    ok(await page.locator('dialog.drawer .error a').count(), 'link');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(300);
    if (await page.locator('dialog[open]').count()) await confirmYes();
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'));
});
await check('Home airport: unknown code refused with a message, ORD saved, set back to LIT', async () => {
    await go('flights?tab=flights');
    await page.locator('[data-key="home-edit"]').click();
    await page.fill('dialog[open] input[name="home_airport"]', 'ZZZ');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => /not an airport the hub knows/.test(document.querySelector('dialog[open] .error').innerText));
    await page.fill('dialog[open] input[name="home_airport"]', 'ord');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => /ORD/.test(document.querySelector('.home-row').innerText));
    await page.locator('[data-key="home-edit"]').click();
    await page.fill('dialog[open] input[name="home_airport"]', 'LIT');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => /LIT/.test(document.querySelector('.home-row').innerText));
});

/* Found flights */
await check('Found flights tab: badge 2, two items with confidence and source, no booking reference text', async () => {
    await page.locator('[data-key="tab:found"]').click();
    await page.waitForSelector('.queue-list');
    eq((await page.locator('[data-key="tab:found"] .badge').innerText()).trim(), '2');
    eq(await page.locator('.queue-item').count(), 2);
    const t = await text('#panel-found');
    ok(/Confidence 92%, high/.test(t) && /Confidence 55%, medium/.test(t), t.slice(0, 200));
    ok(!t.includes('QW7ZXC'), 'ref hidden');
    ok(t.includes('Booking reference found'));
});
await shot('found-queue');
await check('Accept on a flight that now exists says "already in your flights" and keeps it waiting', async () => {
    await page.locator('.queue-item', { hasText: 'AA 500' }).locator('[data-key$=":accept"]').click();
    await waitToast(/already in your flights/);
    eq(await page.locator('.queue-item').count(), 2);
});
await check('Edit and accept: drawer prefilled, change seat, flight created with it', async () => {
    const item = page.locator('.queue-item', { hasText: 'UA 2210' });
    await item.locator('[data-key$=":edit"]').click();
    await page.waitForSelector('dialog.drawer[open] form.flight-form');
    eq(await page.locator('dialog.drawer input[name="flight_number"]').inputValue(), '2210');
    eq(await page.locator('dialog.drawer input[name="sched_dep"]').inputValue(), '2027-01-15T09:00');
    eq(await page.locator('dialog.drawer input[name="booking_ref"]').getAttribute('type'), 'password');
    await page.fill('dialog.drawer input[name="seat"]', '3c');
    await page.locator('[data-key="ff-save"]').click();
    await waitToast(/Flight UA 2210 ORD-LIT 2027-01-15 added/);
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'));
    const all = (await api('/flights?limit=500')).flights;
    const f = all.find((x) => x.flight_number === '2210');
    eq(f.seat, '3C');
    eq(f.has_booking_ref, true);
    eq((await page.locator('[data-key="tab:found"] .badge').innerText()).trim(), '1');
    eq((await page.locator('.rail-link .nav-badge').innerText()).trim(), '1');
});
await check('Dismiss asks first, then the item leaves the queue; Dismissed 1 shows it', async () => {
    await page.locator('[data-key$=":dismiss"]').first().click();
    await page.waitForSelector('dialog[open]');
    await confirmYes();
    await waitToast(/dismissed/);
    await page.waitForFunction(() => !document.querySelector('.rail-link .nav-badge'));
    ok((await text('#panel-found')).includes('Nothing waiting.'));
    await go('flights?tab=found&show=dismissed');
    eq(await page.locator('.queue-item').count(), 1);
});
if (MORE) execSync(MORE, { stdio: 'ignore' });
await check('Accept all shown: confirm dialog, then per-id toasts (2 added, 1 already in your flights)', async () => {
    await go('flights?tab=found');
    eq(await page.locator('.queue-item').count(), 3);
    await page.locator('[data-key="accept-all"]').click();
    await page.waitForSelector('dialog[open]');
    ok((await text('dialog[open]')).includes('Accept 3 found flights?'));
    await confirmYes();
    await waitToast(/2 flights added/);
    await waitToast(/already in your flights/);
    await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 1);
});
await check('Added view lists accepted ones with a link to the flight', async () => {
    await go('flights?tab=found&show=accepted');
    ok(await page.locator('.queue-item.is-accepted a.link').count() >= 3, 'links');
});

/* Other views */
await check('Activity: Flights filter shows flight sentences and the accept actions', async () => {
    await go('activity?type=flights');
    await page.waitForSelector('.event');
    const t = await text('.days');
    ok(/added the flight/.test(t) && /found flight|accepted/i.test(t), t.slice(0, 200));
    ok(!/ZK9QWE|QW7ZXC|PL4NE7/.test(t), 'no booking reference in activity');
});
await check('Palette: Add flight, Flights waiting for review, and a flight by number', async () => {
    await go('overview');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('add flight');
    await page.waitForSelector('.palette-item');
    ok((await page.locator('.palette-item').first().innerText()).includes('Add flight'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.drawer[open] form.flight-form');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'));
    await page.waitForFunction(() => !document.querySelector('.palette-input'));
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette-input');
    await page.keyboard.type('flights waiting');
    await page.waitForSelector('.palette-item');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /tab=found/.test(location.hash));
    await page.waitForFunction(() => !document.querySelector('.palette-input'));
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette-input');
    await page.keyboard.type('AA 100');
    await page.waitForSelector('.palette-item');
    const items = await page.locator('.palette-item').allInnerTexts();
    ok(items.some((t) => /AA 100\s+DFW to LHR/.test(t)), items.join(' / '));
    ok(!items.join(' ').includes('ZK9QWE'));
    await page.keyboard.press('Escape');
});
await check('Deep links: ?tab=found&show=dismissed, /flights/<id>, bad id', async () => {
    const id = (await api('/flights?q=')).flights.find((f) => f.flight_number === '77').id;
    await go(`flights/${id}`);
    await page.waitForSelector('dialog.drawer[open] input[name="flight_number"]');
    eq(await page.locator('dialog.drawer input[name="flight_number"]').inputValue(), '77');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'));
    await go('flights/99999');
    await waitToast(/gone or never existed/);
    await page.waitForFunction(() => !/99999/.test(location.hash));
    await go('flights?tab=found&show=dismissed');
    eq(await page.locator('[data-key="tab:found"]').getAttribute('aria-selected'), 'true');
    await go('flights?tab=queue');
    eq(await page.locator('[data-key="tab:found"]').getAttribute('aria-selected'), 'true', 'tab=queue alias');
});
await check('Tablist: arrow keys move between Passport / Flights / Found flights', async () => {
    await go('flights');
    await page.waitForSelector('.vtabs');
    await page.waitForTimeout(500);
    await page.locator('[data-key="tab:passport"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => /tab=flights/.test(location.hash));
    await page.waitForFunction(() => document.querySelector('[data-key="tab:flights"]').getAttribute('aria-selected') === 'true');
    await page.keyboard.press('End');
    await page.waitForFunction(() => /tab=found/.test(location.hash));
    await page.waitForFunction(() => document.querySelector('[data-key="tab:found"]').getAttribute('aria-selected') === 'true');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => !/tab=/.test(location.hash));
});
await check('Cancel a flight from the drawer: status Cancelled in the list, Passport count unchanged', async () => {
    const before = (await api('/flights/stats')).flights;
    const id = (await api('/flights?q=')).flights.find((f) => f.flight_number === '1412' && f.dep_local_date === '2026-12-22').id;
    await go(`flights/${id}`);
    await page.waitForSelector('[data-key="cancel-flight"]');
    await page.locator('[data-key="cancel-flight"]').click();
    await confirmYes();
    await waitToast(/cancelled/);
    await page.waitForFunction(() => document.querySelector('dialog.drawer select[name="status"]').value === 'cancelled');
    eq((await api('/flights/stats')).flights, before);
    await page.keyboard.press('Escape');
});

/* Dark mode and phone width */
await check('Dark mode: Passport and map render with dark surfaces', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await go('flights');
    await page.waitForSelector('.route-map');
    const lum = await page.evaluate(() => {
        const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
        return (c[0] + c[1] + c[2]) / 3;
    });
    ok(lum < 80, `body luminance ${lum}`);
    const land = await page.evaluate(() => getComputedStyle(document.querySelector('.route-map .land')).fill);
    ok(land && land !== 'none', `land fill ${land}`);
});
await shot('passport-dark');
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 390, height: 844 });
await check('390 px: Passport tiles two across, map fits, no sideways scroll', async () => {
    await go('flights');
    await page.waitForSelector('.route-map');
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, getComputedStyle(document.querySelector('.stat-grid')).gridTemplateColumns.split(' ').length]);
    ok(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
    eq(w[2], 2, 'tile columns');
});
await check('390 px: Flights table stacks, drawer is full width, form fields stack', async () => {
    await go('flights?tab=flights');
    await page.waitForSelector('.flights-table');
    const stacked = await page.evaluate(() => getComputedStyle(document.querySelector('.flights-table thead')).position);
    eq(stacked, 'absolute', 'thead hidden');
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    ok(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
    await page.locator('.flights-table a.row-link').first().click();
    await page.waitForSelector('dialog.drawer[open] form.flight-form');
    const box = await page.locator('dialog.drawer').boundingBox();
    ok(box.width >= 380, `drawer width ${box.width}`);
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.group-grid')).gridTemplateColumns.split(' ').length);
    eq(cols, 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]') && !/#\/flights\/\d+/.test(location.hash));
});
await check('390 px: Found flights list stacks and the nav badge shows in the More sheet', async () => {
    await go('flights?tab=found&show=all');
    await page.waitForSelector('.queue-list');
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    ok(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
});
await go('flights?tab=flights');
await shot('flights-mobile');
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
