// Passport stage 1 browser checks (Punctuality, map views) against a SCRATCH hub. Usage: node run-passport.mjs [main|plain]
//   main : hub seeded with passport-seed.js (flights with actual times)   plain: hub seeded with seed.js (no actual times)
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import lib from './lib.js';

const require = createRequire(import.meta.url);
const BASE = lib.assertScratchUrl(process.env.BASE || `http://localhost:${process.env.E2E_PORT || 3999}/admin/`);
const KEY = process.env.KEY || lib.KEY;
const SHOTS = lib.shotsDir();
const phase = process.argv[2] || 'main';
const E = phase === 'main' ? JSON.parse(fs.readFileSync(`${process.env.E2E_OUT}/expected-passport.json`, 'utf8')) : null;
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const errors = [];
let n = 0;
const check = async (name, fn) => {
    n += 1;
    try { if ((await fn()) === false) throw new Error('returned false'); results.push(['PASS', n, name]); }
    catch (e) { results.push(['FAIL', n, `${name} :: ${String(e.message).split('\n')[0].slice(0, 220)}`]); }
};
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what || 'not true'); };

const browser = await lib.launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

const go = async (hash) => { await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); await page.waitForSelector('.view.flights .tab-panel', { timeout: 8000 }); };
const api = (path) => page.evaluate(async (p) => (await fetch(`/admin/api${p}`, { headers: { 'X-Requested-With': 'hub-admin' } })).json(), path);
const shot = async (name) => {
    const raw = `/tmp/${name}-raw.png`;
    await page.screenshot({ path: raw });
    execSync(`python3 -I ${new URL('./shrink.py', import.meta.url).pathname} ${raw} ${SHOTS}/${name}.jpg && rm ${raw}`);
    return fs.statSync(`${SHOTS}/${name}.jpg`).size;
};
const tiles = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="punctuality"] .stat-tile')].map((t) => [t.querySelector('.stat-label').textContent, { v: t.querySelector('.stat-value').textContent, s: t.querySelector('.stat-sub') ? t.querySelector('.stat-sub').textContent : '' }])));
const minus = (v) => String(v).replace('−', '-');
const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
const signed = (m) => `${m > 0 ? '+' : m < 0 ? '−' : ''}${Math.abs(m)} min`;

await page.goto(BASE);
await page.waitForSelector('input');
await page.fill('input', KEY);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('.rail-nav');
await page.evaluate(() => { localStorage.removeItem('hub-flights-mapview'); });

if (phase === 'plain') {
    await check('no actual times: Punctuality shows its empty state, no tiles', async () => {
        await go('flights');
        const t = await page.locator('[data-testid="punctuality"]').innerText();
        ok(/No actual times for 7 flights/.test(t), t.slice(0, 120));
        eq(await page.locator('[data-testid="punctuality"] .stat-tile').count(), 0);
    });
    await check('API delays block: measured 0, rate null, cancelled counted', async () => {
        const d = (await api('/flights/stats')).delays;
        eq(d.measured, 0); eq(d.on_time_rate, null); eq(d.of, 7); eq(d.cancelled, 1);
    });
}

if (phase === 'main') {
    await check('Punctuality tiles match the independently computed numbers', async () => {
        await go('flights');
        const t = await tiles();
        eq(t['On-time rate'].v, `${E.all.onTime}%`);
        eq(t['On-time rate'].s, `${E.all.measured} of ${E.all.of} flights measured`);
        eq(minus(t['Average delay'].v), `+${E.all.avg} min`);
        eq(t['Total time lost'].v, hm(E.all.lost));
        eq(t['Worst delay'].v, signed(E.all.worst.delay));
        ok(t['Worst delay'].s.includes('LIT'), t['Worst delay'].s);
    });
    await check('Worst delay links to its flight; per-airline list; note for unmeasured flights', async () => {
        const href = await page.locator('[data-testid="punctuality"] .stat-tile a.link').getAttribute('href');
        eq(href, `#/flights/${E.ids[E.all.worst.no]}`);
        const rows = await page.locator('.punct-row').allInnerTexts();
        ok(rows.length === 3, `rows ${rows.length}`);
        ok(rows[0].startsWith('American') && rows[0].includes(`${E.all.aa.onTime}% on time`) && rows[0].includes('4 flights'), rows[0].replace(/\n/g, ' '));
        const text = await page.locator('[data-testid="punctuality"]').innerText();
        ok(text.includes(`Actual times known for ${E.all.measured} of ${E.all.of} flights; older flights have none.`), 'note');
        ok(/1 flight cancelled \(13% /.test(text), 'cancelled note');
    });
    await check('Year 2025 narrows the Punctuality numbers', async () => {
        await go('flights?year=2025');
        const t = await tiles();
        eq(t['On-time rate'].v, `${E.y2025.onTime}%`);
        eq(t['On-time rate'].s, `${E.y2025.measured} of ${E.y2025.of} flights measured`);
        eq(minus(t['Average delay'].v), `${E.y2025.avg < 0 ? '-' : '+'}${Math.abs(E.y2025.avg)} min`);
        eq(t['Total time lost'].v, hm(E.y2025.lost));
    });
    await check('API shape: delays block with every key, no booking_ref', async () => {
        const s = await api('/flights/stats');
        eq(Object.keys(s.delays).length, 12);
        eq(s.delays.measured, E.all.measured);
        ok(!JSON.stringify(s).includes('booking_ref'));
    });

    await go('flights');
    const stats = await api('/flights/stats');
    await check('view switcher: Flat | Globe | Heat as pressed buttons, Flat default', async () => {
        const st = await page.evaluate(() => [...document.querySelectorAll('.map-panel .segmented .seg')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]));
        eq(JSON.stringify(st), JSON.stringify([['Flat', 'true'], ['Globe', 'false'], ['Heat', 'false']]));
        eq(await page.locator('.map-wrap[data-view="flat"]').count(), 1);
    });
    await check('Flat labels: no two visible labels overlap (desktop)', async () => {
        const o = await page.evaluate(() => {
            const b = [...document.querySelectorAll('.map-label:not(.is-hidden)')].map((e) => ({ t: e.textContent, r: e.getBoundingClientRect() }));
            const bad = [];
            for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
                const a = b[i].r; const c = b[j].r;
                if (a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top) bad.push(`${b[i].t}/${b[j].t}`);
            }
            return { shown: b.length, bad };
        });
        ok(o.shown >= 4, `shown ${o.shown}`); eq(o.bad.length, 0, o.bad.join(','));
    });
    await check('Heat by keyboard (Enter), persists in localStorage and across reload', async () => {
        await page.locator('.map-panel .seg', { hasText: 'Heat' }).focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.map-wrap[data-view="heat"]');
        eq(await page.evaluate(() => localStorage.getItem('hub-flights-mapview')), 'heat');
        eq(await page.locator('.map-panel .seg', { hasText: 'Heat' }).getAttribute('aria-pressed'), 'true');
        await page.reload(); await page.waitForSelector('.map-panel .segmented');
        await page.waitForSelector('.map-wrap[data-view="heat"]');
        eq(await page.locator('.map-panel .seg', { hasText: 'Heat' }).getAttribute('aria-pressed'), 'true');
    });
    await check('Heat: one glow per airport, sized by visits (sqrt), legend, routes drawn', async () => {
        const g = await page.evaluate(() => [...document.querySelectorAll('.heat-glow')].map((e) => ({ i: e.dataset.iata, v: Number(e.dataset.visits), r: Number(e.getAttribute('r')) })));
        eq(g.length, stats.map.airports.length);
        for (const a of stats.map.airports) ok(g.find((x) => x.i === a.iata && x.v === a.visits), `glow ${a.iata}`);
        const dfw = g.find((x) => x.i === 'DFW'); const ktm = g.find((x) => x.i === 'KTM');
        ok(dfw.r > ktm.r, `radius ${dfw.r} vs ${ktm.r}`); ok(dfw.r <= 13.01, 'cap');
        eq(await page.locator('.heat-route').count() >= stats.map.routes.length, true);
        ok((await page.locator('.heat-legend').innerText()).includes('Brighter = visited more'));
    });
    await check('Heat: hover shows code, city and visits; Escape-free blur hides it; focus works too', async () => {
        const dfw = stats.map.airports.find((a) => a.iata === 'DFW');
        await page.locator('.heat-hit[data-iata="DFW"]').hover();
        const tip = page.locator('.map-tip');
        await tip.waitFor({ state: 'visible' });
        eq(await tip.innerText(), `DFW · ${dfw.city} · ${dfw.visits} visits`);
        await page.mouse.move(5, 5);
        await tip.waitFor({ state: 'hidden' });
        await page.locator('.heat-hit[data-iata="KTM"]').focus();
        await tip.waitFor({ state: 'visible' });
        ok((await tip.innerText()).startsWith('KTM'));
        await page.locator('.heat-hit[data-iata="KTM"]').blur();
        await tip.waitFor({ state: 'hidden' });
    });
    await check('Heat: blend modes multiply (light) and screen (dark)', async () => {
        eq(await page.evaluate(() => getComputedStyle(document.querySelector('.heat-glow')).mixBlendMode), 'multiply');
        await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300);
        eq(await page.evaluate(() => getComputedStyle(document.querySelector('.heat-glow')).mixBlendMode), 'screen');
        eq(await page.evaluate(() => getComputedStyle(document.querySelector('.heat-route')).mixBlendMode), 'screen');
    });
    console.log('heat-dark shot bytes', await shot('passport-heat-dark'));
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(300);
    await check('Globe renders (stage 2), selectable, back to Flat without errors', async () => {
        await page.locator('.map-panel .seg', { hasText: 'Globe' }).click();
        await page.waitForSelector('.map-wrap[data-view="globe"] .globe-ocean');
        eq(await page.locator('.map-soon').count(), 0, 'placeholder gone');
        eq(await page.locator('.map-panel .seg', { hasText: 'Globe' }).getAttribute('aria-pressed'), 'true');
        await page.locator('.map-panel .seg', { hasText: 'Flat' }).click();
        await page.waitForSelector('.map-wrap[data-view="flat"] .arc');
    });
    console.log('punct-desktop shot bytes', await (async () => { await page.locator('[data-testid="punctuality"]').scrollIntoViewIfNeeded(); return shot('passport-punctuality'); })());
    await check('Existing km/miles toggle and year chips still work with the new switcher', async () => {
        await page.locator('.toolbar .seg', { hasText: 'miles' }).click();
        await page.waitForFunction(() => /Miles/.test(document.querySelector('.stat-grid').innerText));
        await page.locator('.toolbar .seg', { hasText: 'km' }).click();
        await page.waitForFunction(() => /Kilometres/.test(document.querySelector('.stat-grid').innerText));
    });
    await check('dark mode: Punctuality tiles and bars render with dark surfaces', async () => {
        await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300);
        const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="punctuality"]')).backgroundColor);
        const m = bg.match(/\d+/g).map(Number); ok(m[0] < 80 && m[1] < 80, bg);
        await page.emulateMedia({ colorScheme: 'light' });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await go('flights');
    await check('390 px: Punctuality tiles two across, bars fit, no sideways scroll', async () => {
        const cols = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="punctuality"] .stat-grid')).gridTemplateColumns.split(' ').length);
        eq(cols, 2);
        const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        ok(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
        const over = await page.evaluate(() => [...document.querySelectorAll('.punct-row *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
        eq(over, 0);
    });
    await check('390 px: view switcher fits, Heat draws and its tooltip fits the screen', async () => {
        const r = await page.locator('.map-panel .segmented').boundingBox(); ok(r.x >= 0 && r.x + r.width <= 390, JSON.stringify(r));
        await page.locator('.map-panel .seg', { hasText: 'Heat' }).click();
        await page.waitForSelector('.map-wrap[data-view="heat"]');
        await page.locator('.heat-hit[data-iata="DFW"]').dispatchEvent('pointerenter');
        await page.locator('.map-tip').waitFor({ state: 'visible' });
        const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        ok(w[0] <= w[1], `scrollWidth ${w[0]} > ${w[1]}`);
    });
    await check('390 px Flat labels do not overlap', async () => {
        await page.locator('.map-panel .seg', { hasText: 'Flat' }).click();
        await page.waitForSelector('.map-label'); await page.waitForTimeout(300);
        const bad = await page.evaluate(() => {
            const b = [...document.querySelectorAll('.map-label:not(.is-hidden)')].map((e) => ({ t: e.textContent, r: e.getBoundingClientRect() }));
            const out = [];
            for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
                const a = b[i].r; const c = b[j].r;
                if (a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top) out.push(`${b[i].t}/${b[j].t}`);
            }
            return out;
        });
        eq(bad.length, 0, bad.join(','));
    });
    await page.locator('.map-panel .seg', { hasText: 'Heat' }).click();
    await page.locator('[data-testid="punctuality"]').scrollIntoViewIfNeeded();
    console.log('punct-mobile shot bytes', await shot('passport-punct-mobile'));
}
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));
await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
