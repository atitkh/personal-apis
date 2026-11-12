// Passport stage 2 (Globe) browser checks against a SCRATCH hub seeded with passport-seed.js (home LIT).
//   SEED=passport-seed.js sh reset.sh && node run-globe.mjs
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import lib from './lib.js';

const require = createRequire(import.meta.url);
const BASE = lib.assertScratchUrl(process.env.BASE || `http://localhost:${process.env.E2E_PORT || 3999}/admin/`);
const KEY = process.env.KEY || lib.KEY;
const SHOTS = lib.shotsDir();
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
const near = (a, b, tol, what) => { if (Math.abs(a - b) > tol) throw new Error(`${what || 'value'}: expected ~${b}, got ${a}`); };

const browser = await lib.launchBrowser();
const RAF = () => {
    window.__raf = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => { window.__raf += 1; return orig(cb); };
};

async function open(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ...opts });
    await ctx.addInitScript(RAF);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav', { state: 'attached' });
    await page.evaluate(() => localStorage.setItem('hub-flights-mapview', 'globe'));
    return { ctx, page };
}
const go = async (page, hash) => {
    await page.goto(`${BASE}#/${hash}`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.map-wrap[data-view="globe"] .globe-ocean', { timeout: 8000 });
    await page.locator('.globe-wrap').scrollIntoViewIfNeeded();
};
const state = (page) => page.evaluate(() => {
    const w = document.querySelector('.globe-wrap');
    return { lon: +w.dataset.lon, lat: +w.dataset.lat, zoom: +w.dataset.zoom, spin: w.dataset.spin, r: +document.querySelector('.globe-ocean').getAttribute('r') };
});
const dot = (page, iata) => page.evaluate((c) => {
    const d = document.querySelector(`.globe-dot[data-iata="${c}"]`);
    return { x: +d.getAttribute('cx'), y: +d.getAttribute('cy'), back: d.classList.contains('is-back') };
}, iata);
const rafIn = async (page, ms) => { const a = await page.evaluate(() => window.__raf); await page.waitForTimeout(ms); return (await page.evaluate(() => window.__raf)) - a; };
const drag = async (page, dx, dy, steps = 8, fast = false) => {
    const b = await page.locator('.globe-map').boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let k = 1; k <= steps; k++) { await page.mouse.move(x + (dx * k) / steps, y + (dy * k) / steps); if (!fast) await page.waitForTimeout(16); }
    await page.mouse.up();
};
const shot = async (page, name) => {
    const raw = `/tmp/${name}-raw.png`;
    await page.screenshot({ path: raw });
    execSync(`python3 -I ${new URL('./shrink.py', import.meta.url).pathname} ${raw} ${SHOTS}/${name}.jpg && rm ${raw}`);
    return fs.statSync(`${SHOTS}/${name}.jpg`).size;
};

/* ---------- desktop, light ---------- */
let { ctx, page } = await open();
await go(page, 'flights');
const stats = await page.evaluate(async () => (await fetch('/admin/api/flights/stats', { headers: { 'X-Requested-With': 'hub-admin' } })).json());
const AIRPORTS = stats.map.airports.length;
const ROUTES = stats.map.routes.length;

await check(`renders sphere, land, ${AIRPORTS} airport dots, ${ROUTES} route paths, Globe pressed`, async () => {
    eq(await page.locator('.globe-ocean').count(), 1);
    ok(((await page.locator('.globe-land').getAttribute('d')) || '').length > 500, 'land path');
    ok(((await page.locator('.globe-grat').getAttribute('d')) || '').length > 100, 'graticule');
    eq(await page.locator('.globe-dot').count(), AIRPORTS, 'dots');
    eq(await page.locator('.globe-arcs .arc').count(), ROUTES, 'arcs');
    ok(await page.locator('.globe-dot:not(.is-back)').count() > 0, 'some dot in front');
    eq(await page.locator('.map-panel .seg', { hasText: 'Globe' }).getAttribute('aria-pressed'), 'true');
});
await check('a11y: role img, tabindex 0, aria-label "Globe of N routes and M airports"', async () => {
    const s = page.locator('.globe-map');
    eq(await s.getAttribute('role'), 'img');
    eq(await s.getAttribute('tabindex'), '0');
    ok((await s.getAttribute('aria-label')).startsWith(`Globe of ${ROUTES} routes and ${AIRPORTS} airports`), await s.getAttribute('aria-label'));
});
await check('land is clipped to the disc: every land point within the radius', async () => {
    const worst = await page.evaluate(() => {
        const r = +document.querySelector('.globe-ocean').getAttribute('r');
        const nums = document.querySelector('.globe-land').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
        let w = 0;
        for (let k = 0; k < nums.length; k += 2) w = Math.max(w, Math.hypot(nums[k] - 250, nums[k + 1] - 250) - r);
        return w;
    });
    ok(worst <= 0.6, `point ${worst} outside`);
});
await check('auto-spin on load: rotation changes, Spin pressed, frames run', async () => {
    const a = await state(page);
    eq(a.spin, 'on');
    eq(await page.locator('[data-key="globe-spin"]').getAttribute('aria-pressed'), 'true');
    const frames = await rafIn(page, 600);
    const b = await state(page);
    ok(frames > 10, `frames ${frames}`);
    ok(a.lon !== b.lon, 'lon moved');
});
await check('hover tooltip on a front airport: "IATA · City · n visits"', async () => {
    await page.locator('[data-key="globe-spin"]').click(); // stop spin so the dot stays put
    const iata = await page.evaluate(() => document.querySelector('.globe-hit:not(.is-back)').dataset.iata);
    await page.locator(`.globe-hit[data-iata="${iata}"]`).hover({ force: true });
    const t = await page.locator('.globe-wrap .map-tip').innerText();
    ok(new RegExp(`^${iata} · .* · \\d+ visits?$`).test(t), t);
    await page.mouse.move(5, 5);
});
await check('drag turns the globe (a dot moves with the pointer), spin stays off', async () => {
    await page.locator('[data-key="globe-reset"]').click();
    await page.waitForTimeout(100);
    const a = await dot(page, 'LIT');
    await drag(page, 120, 0, 10);
    await page.waitForTimeout(700);
    const b = await dot(page, 'LIT');
    ok(b.x - a.x > 60, `LIT x ${a.x} -> ${b.x}`);
    eq((await state(page)).spin, 'off');
});
await check('auto-spin stops on drag: Spin on, then a drag turns it off', async () => {
    await page.locator('[data-key="globe-spin"]').click();
    eq((await state(page)).spin, 'on');
    await drag(page, -40, 0, 4);
    eq((await state(page)).spin, 'off');
    eq(await page.locator('[data-key="globe-spin"]').getAttribute('aria-pressed'), 'false');
});
await check('inertia after a fast flick, then idle: no frames when still', async () => {
    await page.waitForTimeout(800);
    const a = await state(page);
    await drag(page, 200, 0, 5, true);
    const b = await state(page);
    await page.waitForTimeout(150);
    const c = await state(page);
    ok(b.lon !== c.lon, `kept moving after release ${b.lon} ${c.lon}`);
    await page.waitForTimeout(2000);
    const idle = await rafIn(page, 500);
    eq(idle, 0, 'frames while idle');
    ok(a.lon !== c.lon);
});
await check('arrow keys turn the globe, latitude clamps at 80', async () => {
    await page.locator('.globe-map').focus();
    const a = await state(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
    const b = await state(page);
    near(((b.lon - a.lon + 540) % 360) - 180, 10, 0.02, 'lon step');
    for (let k = 0; k < 20; k++) await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(60);
    eq((await state(page)).lat, 80, 'clamped lat');
    const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    eq(focusRing, 'solid', 'visible focus ring');
});
await check('zoom buttons change scale and clamp at 0.8x and 2.5x; +/- keys and the wheel zoom', async () => {
    await page.locator('[data-key="globe-reset"]').click();
    await page.locator('[data-key="globe-in"]').click();
    await page.waitForTimeout(60);
    let s = await state(page);
    near(s.zoom, 1.2, 0.01, 'zoom');
    near(s.r, 246, 0.2, 'radius');
    for (let k = 0; k < 10; k++) await page.locator('[data-key="globe-in"]').click();
    await page.waitForTimeout(60);
    eq((await state(page)).zoom, 2.5, 'max');
    for (let k = 0; k < 12; k++) await page.locator('[data-key="globe-out"]').click();
    await page.waitForTimeout(60);
    s = await state(page);
    eq(s.zoom, 0.8, 'min');
    near(s.r, 164, 0.2, 'min radius');
    await page.locator('.globe-map').focus();
    await page.keyboard.press('+');
    await page.waitForTimeout(60);
    near((await state(page)).zoom, 0.96, 0.01, 'key +');
    const b = await page.locator('.globe-map').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(100);
    ok((await state(page)).zoom > 0.97, 'wheel zoomed in');
});
await check('Reset and double-click recentre on the home airport (LIT) at 1x; Home key too', async () => {
    await page.keyboard.press('ArrowLeft');
    await page.locator('[data-key="globe-reset"]').click();
    await page.waitForTimeout(60);
    let s = await state(page);
    near(s.lon, -92.22, 0.05, 'lon');
    near(s.lat, 34.73, 0.05, 'lat');
    eq(s.zoom, 1);
    const d = await dot(page, 'LIT');
    near(d.x, 250, 0.2, 'LIT centred x');
    near(d.y, 250, 0.2, 'LIT centred y');
    await page.keyboard.press('ArrowLeft');
    await page.locator('.globe-map').dblclick();
    await page.waitForTimeout(60);
    near((await state(page)).lon, -92.22, 0.05, 'dblclick lon');
    await page.locator('.globe-map').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.waitForTimeout(60);
    near((await state(page)).lat, 34.73, 0.05, 'Home key');
});
await check('keyboard focus on an airport shows the tooltip', async () => {
    await page.locator('.globe-hit[data-iata="LIT"]').focus();
    ok(/^LIT · .*visit/.test(await page.locator('.globe-wrap .map-tip').innerText()));
    ok(await page.locator('.globe-wrap .map-tip').isVisible());
    await page.locator('.globe-map').focus();
});
await check('labels: front airports labelled, back ones hidden, no overlaps', async () => {
    const r = await page.evaluate(() => {
        const shown = [...document.querySelectorAll('.globe-wrap .map-label:not(.is-hidden)')];
        const boxes = shown.map((e) => e.getBoundingClientRect());
        let overlap = 0;
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]; const b = boxes[j];
            if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlap++;
        }
        const backShown = shown.filter((e) => document.querySelector(`.globe-dot[data-iata="${e.dataset.iata}"]`).classList.contains('is-back')).length;
        return { n: shown.length, overlap, backShown };
    });
    ok(r.n > 0, 'some labels');
    eq(r.overlap, 0, 'overlaps');
    eq(r.backShown, 0, 'back labels shown');
});
console.log('globe-light shot bytes', await shot(page, 'globe-light'));
await check('year switch keeps the rotation and zoom', async () => {
    await page.locator('.globe-map').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');
    await page.waitForTimeout(60);
    const a = await state(page);
    await page.locator('.chip, a', { hasText: /^2025$/ }).first().click();
    await page.waitForFunction(() => location.hash.includes('year=2025'));
    await page.waitForSelector('.map-wrap[data-view="globe"] .globe-ocean');
    await page.waitForTimeout(200);
    const b = await state(page);
    eq(b.lon, a.lon, 'lon');
    eq(b.lat, a.lat, 'lat');
    eq(b.zoom, a.zoom, 'zoom');
});
await check('view switch away and back: no frames leak after leaving the globe (spin on before)', async () => {
    await page.locator('[data-key="globe-spin"]').click();
    ok((await rafIn(page, 300)) > 5, 'spinning');
    await page.locator('.map-panel .seg', { hasText: 'Flat' }).click();
    await page.waitForSelector('.map-wrap[data-view="flat"]');
    await page.waitForTimeout(100);
    eq(await rafIn(page, 600), 0, 'frames after switching to Flat');
    await page.locator('.map-panel .seg', { hasText: 'Globe' }).click();
    await page.waitForSelector('.map-wrap[data-view="globe"]');
    eq((await state(page)).spin, 'on', 'spin state kept');
    await page.locator('[data-key="globe-spin"]').click();
    await page.waitForTimeout(100);
    eq(await rafIn(page, 500), 0, 'idle after spin off');
    await page.evaluate(() => { location.hash = '#/overview'; });
    await page.waitForTimeout(400);
    eq(await page.locator('.globe-wrap').count(), 0, 'left the page');
    eq(await rafIn(page, 500), 0, 'no frames after leaving the page');
});
await check('dark mode: ocean, land and graticule take the dark palette', async () => {
    await go(page, 'flights');
    const col = () => page.evaluate(() => ['.globe-ocean', '.globe-land', '.globe-grat'].map((s) => { const c = getComputedStyle(document.querySelector(s)); return `${c.fill}|${c.stroke}`; }));
    const light = await col();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(300);
    const dark = await col();
    ok(light[0] !== dark[0] && light[1] !== dark[1], `${light} vs ${dark}`);
    await page.locator('[data-key="globe-spin"]').click().catch(() => {});
    console.log('globe-dark shot bytes', await shot(page, 'globe-dark'));
});
await ctx.close();

/* ---------- reduced motion ---------- */
({ ctx, page } = await open({ reducedMotion: 'reduce' }));
await check('reduced motion: no auto-spin, no frames while idle, no inertia after a flick', async () => {
    await go(page, 'flights');
    eq((await state(page)).spin, 'off');
    eq(await page.locator('[data-key="globe-spin"]').getAttribute('aria-pressed'), 'false');
    await page.waitForTimeout(200);
    eq(await rafIn(page, 500), 0, 'idle frames');
    await drag(page, 200, 0, 5, true);
    await page.waitForTimeout(80);
    const a = await state(page);
    await page.waitForTimeout(300);
    const b = await state(page);
    eq(b.lon, a.lon, 'no inertia');
});
await ctx.close();

/* ---------- 390 px, touch ---------- */
({ ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }));
await check('390 px: globe fits, touch drag turns it without scrolling the page sideways', async () => {
    await go(page, 'flights');
    await page.locator('[data-key="globe-spin"]').click();
    const box = await page.locator('.globe-map').boundingBox();
    ok(box.width <= 390 && box.width > 250, `width ${box.width}`);
    eq(await page.evaluate(() => getComputedStyle(document.querySelector('.globe-map')).touchAction), 'none');
    const a = await state(page);
    const cdp = await ctx.newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let k = 1; k <= 8; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 15 * k, y: y + 2 * k }] }); await page.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(800);
    const b = await state(page);
    ok(a.lon !== b.lon, `lon ${a.lon} -> ${b.lon}`);
    eq(await page.evaluate(() => window.scrollX), 0, 'scrollX');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal overflow');
    const ctl = await page.locator('.globe-controls').boundingBox();
    ok(ctl.x >= 0 && ctl.x + ctl.width <= 390, 'controls fit');
    console.log('globe-mobile shot bytes', await shot(page, 'globe-mobile'));
});
await ctx.close();

await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));
await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
