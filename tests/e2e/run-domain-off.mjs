// Browser flow checks for the switched-off domain indicators: rail (open, collapsed, phone tab bar and More sheet), command
// palette, the notice and Switch off button on a domain page, live updates from the Overview board. SCRATCH hub, empty.
// Usage: node run-domain-off.mjs. Env: BASE, KEY, SHOTS (output dir).
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

const put = (path, body) => page.evaluate(async ([p, b]) => (await fetch(`/admin/api${p}`, { method: 'PUT', headers: { 'X-Requested-With': 'hub-admin', 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, [path, body]);
const rail = (name) => page.locator(`.rail-nav a.rail-link[href$="#/${name}"]`);
const notice = () => page.locator('.content .domain-notice');
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };
const offNames = () => page.locator('.rail-nav a.rail-link.is-off').evaluateAll((els) => els.map((e) => e.getAttribute('href').replace('#/', '')));
const enabled = async (name) => (await api('/domains')).domains.find((d) => d.name === name).enabled;
const mode = async (name) => (await api('/domains')).domains.find((d) => d.name === name).mcpMode;

await signIn();
await go('flights');

await check('Everything is on: no rail link is marked, no notice, and the page header has a quiet Switch off button', async () => {
    eq((await offNames()).length, 0);
    eq(await notice().count(), 0);
    const b = page.locator('.page-header .domain-off-btn');
    eq(await b.count(), 1);
    ok(await b.isVisible(), 'switch off visible');
    eq((await b.innerText()).trim(), 'Switch off');
});
await check('Pages that are not a domain (Keys, Graph) get neither the notice nor the button', async () => {
    for (const r of ['keys', 'graph', 'activity']) {
        await go(r);
        eq(await page.locator('.domain-off-btn, .domain-notice').count(), 0, r);
    }
    await go('flights');
});

// Switch Flights off behind the page's back and open it fresh.
eq(await put('/domains/flights', { enabled: false }), 200);
await go('overview');
await go('flights');
await page.waitForSelector('.content .domain-notice');

await check('A switched-off domain: its rail link is dimmed with the off glyph, named "Flights, switched off", still a link', async () => {
    eq((await offNames()).join(','), 'flights');
    eq(await page.locator('.rail-nav').getByRole('link', { name: 'Flights, switched off', exact: true }).count(), 1);
    eq(await rail('flights').locator('.nav-off').count(), 1);
    eq(await rail('flights').getAttribute('title'), 'Flights (switched off)');
    eq(await rail('flights').locator('.nav-off').getAttribute('title'), 'Switched off');
    const deco = await rail('flights').locator('.rail-label').evaluate((e) => getComputedStyle(e).textDecorationLine);
    eq(deco, 'line-through');
    ok(await rail('flights').getAttribute('aria-current') === 'page', 'flights is the current page');
    eq(await rail('trips').locator('.nav-off').count(), 0);
});
await check('The page opens with a notice above the page header: what is off, records untouched, Turn on, Agent access', async () => {
    const n = notice();
    eq(await n.count(), 1);
    eq(await n.getAttribute('role'), 'region');
    eq(await n.getAttribute('aria-label'), 'Flights is switched off');
    const t = await n.innerText();
    ok(t.includes('Flights is switched off.') && t.includes('Your records are untouched') && t.includes('Turn on') && t.includes('Agent access'), t);
    const nb = await n.boundingBox();
    const hb = await page.locator('.page-header').first().boundingBox();
    ok(nb.y + nb.height <= hb.y + 1, `notice (${nb.y}+${nb.height}) above header (${hb.y})`);
    eq(await page.locator('.page-header .domain-off-btn').isVisible(), false);
    eq(await n.locator('select option').count(), 3);
    eq(await n.locator('select').inputValue(), 'read');
    ok(!(await page.evaluate(() => document.querySelector('.domain-notice').contains(document.activeElement))), 'focus not stolen');
});
await check('The command palette marks the page as off', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForSelector('dialog.palette[open]');
    await page.keyboard.type('flights');
    await page.waitForTimeout(300);
    const items = await page.locator('dialog.palette .palette-item .palette-label').allInnerTexts();
    ok(items.includes('Flights (off)'), items.join('|'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
});

await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(200);
await shot('domain-off-dark');
await page.emulateMedia({ colorScheme: 'light' });
await page.waitForTimeout(200);
await shot('domain-off-light');
await page.locator('.rail-toggle').click();
await page.waitForTimeout(300);
await check('Collapsed rail: the icon is dimmed and a small off badge sits on it; the name still says switched off', async () => {
    const box = await rail('flights').locator('.nav-off').boundingBox();
    ok(box && box.width >= 10, 'badge visible');
    const lb = await rail('flights').boundingBox();
    ok(box.x >= lb.x && box.x + box.width <= lb.x + lb.width + 1, 'badge inside the link');
    eq(await page.locator('.rail-nav').getByRole('link', { name: 'Flights, switched off', exact: true }).count(), 1);
    ok(Number(await rail('flights').locator('> .icon').evaluate((e) => getComputedStyle(e).opacity)) < 1, 'icon dimmed');
});
await shot('domain-off-collapsed');
await page.locator('.rail-toggle').click();
await page.waitForTimeout(300);

await check('Turn on: no reload, toast, the notice and the rail mark go away, the Switch off button appears', async () => {
    await page.evaluate(() => { window.__marker = 'same-page'; });
    await notice().getByRole('button', { name: 'Turn on' }).click();
    await waitToast(/Flights is on/);
    await page.waitForFunction(() => !document.querySelector('.domain-notice'));
    eq(await page.evaluate(() => window.__marker), 'same-page');
    eq((await offNames()).length, 0);
    eq(await enabled('flights'), true);
    ok(await page.locator('.page-header .domain-off-btn').isVisible(), 'switch off visible');
    eq(await rail('flights').getAttribute('title'), 'Flights');
});
await check('Switch off asks first (Cancel changes nothing); confirming shows the notice and the rail mark at once', async () => {
    await page.locator('.page-header .domain-off-btn').click();
    await page.waitForSelector('dialog[open]');
    const d = await page.locator('dialog[open]').innerText();
    ok(d.includes('Switch off Flights?') && d.includes('Agents and search stop using it; records stay.'), d);
    await page.locator('dialog[open] .dialog-actions .btn').first().click();
    await page.waitForTimeout(300);
    eq(await enabled('flights'), true);
    eq(await notice().count(), 0);
    await page.locator('.page-header .domain-off-btn').click();
    await page.waitForSelector('dialog[open]');
    await confirmYes();
    await waitToast(/Flights is off/);
    await page.waitForSelector('.content .domain-notice');
    eq((await offNames()).join(','), 'flights');
    eq(await enabled('flights'), false);
    eq(await page.evaluate(() => window.__marker), 'same-page');
});
await check('Agent access from the notice: the select changes the mode (write asks first), the board agrees', async () => {
    const sel = notice().locator('select');
    await sel.selectOption('off');
    await waitToast(/Agent access for Flights set to off/);
    eq(await mode('flights'), 'off');
    await sel.selectOption('write');
    await page.waitForSelector('dialog[open]');
    await page.locator('dialog[open] .dialog-actions .btn').first().click();
    await page.waitForTimeout(300);
    eq(await mode('flights'), 'off');
    eq(await sel.inputValue(), 'off');
    await sel.selectOption('read');
    await waitToast(/set to read/);
    eq(await mode('flights'), 'read');
});
await check('An API error shows inline in the notice (Turn on refused), not only as a toast', async () => {
    await page.route('**/admin/api/domains/flights', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk is full"}' }) : route.continue()));
    try {
        await notice().getByRole('button', { name: 'Turn on' }).click();
        await page.waitForFunction(() => /disk is full/.test((document.querySelector('.domain-notice-error') || {}).textContent || ''), null, { timeout: 5000 });
        eq(await notice().count(), 1);
        eq((await offNames()).join(','), 'flights');
    } finally {
        await page.unroute('**/admin/api/domains/flights');
    }
});

await check('Overview board: its power switch updates the rail live (Trips off, then on), no reload', async () => {
    await go('overview');
    await page.evaluate(() => { window.__marker = 'overview'; });
    const sw = page.locator('.channel[data-domain=trips] [role=switch]');
    await sw.click();
    await page.waitForFunction(() => document.querySelector('.rail-nav a[href$="#/trips"]').classList.contains('is-off'));
    eq((await offNames()).sort().join(','), 'flights,trips');
    await sw.click();
    await page.waitForFunction(() => !document.querySelector('.rail-nav a[href$="#/trips"]').classList.contains('is-off'));
    eq((await offNames()).join(','), 'flights');
    eq(await page.evaluate(() => window.__marker), 'overview');
});
await check('A domain that is on shows no notice (Trips), only the quiet Switch off', async () => {
    await go('trips');
    eq(await notice().count(), 0);
    ok(await page.locator('.page-header .domain-off-btn').isVisible(), 'switch off');
    await go('entities');
    ok(await page.locator('.page-header .domain-off-btn').isVisible(), 'entities switch off');
    await go('preferences');
    ok(await page.locator('.page-header .domain-off-btn').isVisible(), 'preferences switch off');
});
await check('Portfolio: Switch off repeats the public-site warning in its confirm; Cancel leaves it on', async () => {
    await go('portfolio');
    await page.locator('.page-header .domain-off-btn').click();
    await page.waitForSelector('dialog[open]');
    const d = await page.locator('dialog[open]').innerText();
    ok(d.includes('Switch off Portfolio?') && /public portfolio site/.test(d), d);
    await page.locator('dialog[open] .dialog-actions .btn').first().click();
    await page.waitForTimeout(300);
    eq(await enabled('portfolio'), true);
});
await check('If the domain list cannot be read, nothing is marked (never guessed)', async () => {
    await page.route('**/admin/api/domains', (route) => route.abort());
    try {
        await go('flights');
        await page.waitForFunction(() => !document.querySelector('.rail-nav a.is-off'), null, { timeout: 5000 });
        eq((await offNames()).length, 0);
        eq(await page.locator('.domain-notice:visible, .domain-off-btn:visible').count(), 0);
    } finally {
        await page.unroute('**/admin/api/domains');
    }
    await go('trips');
    await go('flights');
    await page.waitForSelector('.content .domain-notice');
    eq((await offNames()).join(','), 'flights');
});

// Phone
eq(await put('/domains/digests', { enabled: false }), 200);
await page.setViewportSize({ width: 390, height: 844 });
await go('trips');
await go('flights');
await page.waitForFunction(() => document.querySelector('.tabbar a[href$="#/digests"]').classList.contains('is-off'), null, { timeout: 5000 }).catch(() => {});
await check('Phone: the notice stacks (text, then buttons), fits the screen, and the page does not scroll sideways', async () => {
    const t = await page.locator('.domain-notice-text').boundingBox();
    const a = await page.locator('.domain-notice-actions').boundingBox();
    ok(a.y >= t.y + t.height - 1, `actions (${a.y}) below text (${t.y + t.height})`);
    const n = await notice().boundingBox();
    ok(n.x >= 0 && n.x + n.width <= 391, 'inside the screen');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow');
});
await shot('domain-off-mobile');
await check('Phone: Digests (a tab) is marked off, and the More sheet marks Flights', async () => {
    const tab = page.locator('.tabbar a.tab[href$="#/digests"]');
    ok((await tab.getAttribute('class')).includes('is-off'), 'digests tab');
    eq(await page.locator('.tabbar').getByRole('link', { name: 'Digests, switched off', exact: true }).count(), 1);
    await page.locator('.tabbar .tab', { hasText: 'More' }).click();
    await page.waitForSelector('dialog[open] .sheet-nav');
    eq(await page.locator('dialog[open]').getByRole('link', { name: 'Flights, switched off', exact: true }).count(), 1);
    eq(await page.locator('dialog[open] .sheet-link.is-off').count(), 1);
    eq(await page.locator('dialog[open] .sheet-link .nav-off').count(), 1);
    await page.waitForTimeout(500);
    await shot('more-sheet-off-mobile');
    await page.keyboard.press('Escape');
});
await page.setViewportSize({ width: 1280, height: 900 });
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
