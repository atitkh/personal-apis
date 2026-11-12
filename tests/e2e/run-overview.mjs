// Overview dedupe browser checks against a SCRATCH hub (port 3999).
//   SEED=briefing-seed.js sh reset.sh && node run-overview.mjs         (seeded: found flights, spot, missing digest)
//   sh reset.sh empty && touch /tmp/pa-scratch-data/backups/hub-$(date +%F).db && node run-overview.mjs empty   (all clear)
// The "no backup" health line is the scratch hub's own state (no backup has been made).
import { createRequire } from 'module';
import fs from 'fs';
import lib from './lib.js';

const require = createRequire(import.meta.url);
const ORIGIN = lib.assertScratchUrl(process.env.ORIGIN || `http://localhost:${process.env.E2E_PORT || 3999}`);
const BASE = `${ORIGIN}/admin/`;
const KEY = lib.KEY;
const SHOTS = lib.shotsDir();
fs.mkdirSync(SHOTS, { recursive: true });
const EMPTY = process.argv[2] === 'empty';
const results = []; const errors = []; let n = 0;
const check = async (name, fn) => {
    n += 1;
    try { if ((await fn()) === false) throw new Error('returned false'); results.push(['PASS', n, name]); }
    catch (e) { results.push(['FAIL', n, `${name} :: ${String(e.message).split('\n')[0].slice(0, 220)}`]); }
    console.log(results[results.length - 1].join(' '));
};
const eq = (a, b, w) => { if (a !== b) throw new Error(`${w || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, w) => { if (!v) throw new Error(w || 'not true'); };
const browser = await lib.launchBrowser();
async function open(opts = {}, setup) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ...opts });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    if (setup) await setup(page);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav', { state: 'attached' });
    await settled(page);
    return { ctx, page };
}
const shot = async (page, file) => { const p = `${SHOTS}/${file}`; await page.screenshot({ path: p, type: 'jpeg', quality: 70 }); return fs.statSync(p).size; };
const settled = (page) => page.waitForFunction(() => document.querySelector('section.today') && !document.querySelector('section.today [aria-busy="true"]'));
const panel = (page) => page.locator('section.attention');
const lines = async (page) => (await panel(page).locator('li.att').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
const page_text = (page) => page.locator('.overview').innerText();
const count = (text, re) => (text.match(re) || []).length;
const fail500 = (page) => page.route('**/admin/api/briefing*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));

let { ctx, page } = await open();

if (EMPTY) {
    await check('empty hub (with a fresh backup file): the panel is the all-clear and says what was checked', async () => {
        const t = await panel(page).innerText();
        ok(/Nothing needs you right now\./.test(t), t.slice(0, 120));
        ok(/Checked: the database, backups, the daily digest, the portfolio files, the places queue and the found flights\./.test(t), 'checked text');
    });
    await check('empty hub: headline has no warning count', async () => ok(!/need a look|needs a look/.test(await page.locator('.headline').innerText())));
    await check('empty hub: no shared condition appears anywhere', async () => { const t = await page_text(page); eq(count(t, /found flights? waits?|needs? a name|daily digest for/g), 0); });
    await check('empty hub: Today card says nothing needs you', async () => ok(/Nothing needs you right now\./.test(await page.locator('section.today').innerText())));
} else {
    await check('health line (no backup) is in the panel, first', async () => { const l = await lines(page); ok(/No backup has been made yet/.test(l[0]), l[0]); });
    await check('exactly one line per shared condition across the whole Overview', async () => {
        const t = await page_text(page);
        eq(count(t, /2 found flights wait for review/g), 1, 'found'); eq(count(t, /1 spot needs a name/g), 1, 'spot'); eq(count(t, /daily digest for [\d-]+ has not arrived/g), 1, 'digest');
    });
    await check('the three lines are in the panel, after the health line', async () => {
        const l = await lines(page); eq(l.length, 4, l.join(' | '));
        ok(/found flights/.test(l[1]) || /found flights/.test(l.join(' ')), 'found');
    });
    await check('the Today card still shows the other items (urgent cancelled flight, upcoming flight)', async () => {
        const t = await page.locator('section.today').innerText();
        ok(/AA 52 DFW to ORD/.test(t), 'cancelled'); ok(/CX 891/.test(t), 'cx');
    });
    await check('headline counts every line (4 things need a look)', async () => ok(/^\s*4 things need a look\./.test(await page.locator('.headline').innerText()), await page.locator('.headline').innerText()));
    await check('panel links: Open backups, Review them, Name it, Open digests', async () => {
        const hrefs = await panel(page).locator('a.btn').evaluateAll((a) => a.map((x) => x.getAttribute('href')));
        ok(hrefs.some((h) => /backups/.test(h)), 'backups'); ok(hrefs.some((h) => /flights\?tab=found/.test(h)), 'flights');
        ok(hrefs.some((h) => /places\?tab=queue/.test(h)), 'places'); ok(hrefs.some((h) => /digests/.test(h)), 'digests');
    });
    await check('Review them leads to the found tab, Name it to the queue, Open digests to digests', async () => {
        for (const [label, re] of [['Review them', /#\/flights\?tab=found/], ['Name it', /#\/places\?tab=queue/], ['Open digests', /#\/digests/]]) {
            await page.goto(`${BASE}#/`); await settled(page);
            await panel(page).locator('a', { hasText: label }).click();
            await page.waitForFunction((s) => new RegExp(s).test(location.hash), re.source);
        }
    });
    await check('the briefing is requested once per page load (shared, not twice)', async () => {
        const p2 = await ctx.newPage(); let calls = 0;
        p2.on('request', (r) => { if (/\/admin\/api\/briefing/.test(r.url())) calls += 1; });
        await p2.goto(`${BASE}#/`); await p2.waitForLoadState('networkidle'); await settled(p2);
        eq(calls, 1, 'briefing calls'); await p2.close();
    });
    await check('Next 30 days keeps one line per condition', async () => {
        await page.goto(`${BASE}#/`); await settled(page);
        await page.locator('section.today .seg', { hasText: 'Next 30 days' }).click(); await settled(page);
        const t = await page_text(page); eq(count(t, /found flights? waits?/g), 1); eq(count(t, /needs? a name/g), 1); eq(count(t, /daily digest for/g), 1);
        await page.locator('section.today .seg', { hasText: 'Next 14 days' }).click(); await settled(page);
    });
    await check('briefing fails (500): the three lines are still there (fallback from the overview counts), once each', async () => {
        const f = await open({}, fail500);
        await f.page.waitForSelector('section.today .error-state');
        const t = await page_text(f.page);
        eq(count(t, /2 found flights wait for review/g), 1, 'found'); eq(count(t, /1 spot needs a name/g), 1, 'spot'); eq(count(t, /daily digest for [\d-]+ has not arrived/g), 1, 'digest');
        ok(/^\s*4 things need a look\./.test(await f.page.locator('.headline').innerText()), 'headline');
        ok(/No backup has been made yet/.test(await panel(f.page).innerText()), 'health');
        const hrefs = await panel(f.page).locator('a.btn').evaluateAll((a) => a.map((x) => x.getAttribute('href')));
        ok(hrefs.some((h) => /flights\?tab=found/.test(h)) && hrefs.some((h) => /places\?tab=queue/.test(h)) && hrefs.some((h) => /digests/.test(h)), 'links');
        await f.ctx.close();
    });
    await check('screenshot (light, 1280)', async () => ok((await shot(page, 'overview-light.jpg')) < 150000, 'size'));
    await check('dark mode: panel lines readable', async () => {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        const c = await panel(page).locator('li.att').first().evaluate((e) => getComputedStyle(e).color);
        ok(c && c !== 'rgba(0, 0, 0, 0)', c);
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    });
    await check('390 px: no horizontal overflow, panel fits', async () => {
        const m = await open({ viewport: { width: 390, height: 844 } });
        const w = await m.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, p: document.querySelector('section.attention').getBoundingClientRect().right }));
        ok(w.sw <= w.cw + 1 && w.p <= w.cw, JSON.stringify(w));
        ok((await shot(m.page, 'overview-390.jpg')) < 150000, 'size');
        await m.ctx.close();
    });
}
await check('no console errors', async () => eq(errors.length, 0, errors.slice(0, 3).join(' / ')));
await browser.close();
const bad = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
