// Today card browser checks against a SCRATCH hub.
//   SEED=briefing-seed.js sh reset.sh && node run-briefing.mjs         (seeded)
//   sh reset.sh empty && node run-briefing.mjs empty                   (empty hub)
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
async function open(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ...opts });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav', { state: 'attached' });
    return { ctx, page };
}
const shot = async (page, file) => { const p = `${SHOTS}/${file}`; await page.screenshot({ path: p, type: 'jpeg', quality: 70 }); return fs.statSync(p).size; };
const card = (page) => page.locator('section.today');
const items = (page) => card(page).locator('li.today-item');
const texts = async (page) => (await items(page).allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
const settled = (page) => page.waitForFunction(() => document.querySelector('section.today') && !document.querySelector('section.today [aria-busy="true"]'));
const go = async (page, hash) => { await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); await settled(page); };

let { ctx, page } = await open();
await settled(page);

if (EMPTY) {
    await check('empty hub: the card says Nothing needs you right now.', async () => ok((await card(page).innerText()).includes('Nothing needs you right now.')));
    await check('empty hub: no items listed', async () => eq(await items(page).count(), 0));
    await check('empty hub: the segmented control is there with 14 selected', async () => eq(await card(page).locator('.seg[aria-checked="true"]').innerText(), 'Next 14 days'));
    await check('skeleton shows while loading', async () => {
        const p2 = await ctx.newPage();
        await p2.route('**/admin/api/briefing*', async (r) => { await new Promise((s) => setTimeout(s, 800)); r.continue(); });
        await p2.goto(`${BASE}#/`);
        await p2.waitForSelector('section.today [aria-busy="true"]', { timeout: 4000 });
        await p2.close();
    });
    await check('error state with Retry, then the card recovers', async () => {
        const p2 = await ctx.newPage();
        let fail = true;
        await p2.route('**/admin/api/briefing*', (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.continue()));
        await p2.goto(`${BASE}#/`);
        await p2.waitForSelector('section.today .error-state');
        fail = false;
        await p2.locator('section.today [data-key="retry"]').click();
        await p2.waitForSelector('section.today .empty:not(.error-state)');
        await p2.close();
    });
} else {
    await check('Today card is above the channel board', async () => ok(await page.evaluate(() => {
        const t = document.querySelector('section.today').getBoundingClientRect().top;
        const b = document.querySelector('.overview > :nth-child(3)').getBoundingClientRect().top;
        return t < b;
    })));
    let list = await texts(page);
    await check('urgent source-cancelled flight leads, with an Urgent chip', async () => ok(/Urgent.*AA 52 DFW to ORD.*cancelled/.test(list[0]), list[0]));
    await check('found flights, the place suggestion and the digest are NOT repeated in the card (the Needs attention panel has them)', async () => {
        const all = list.join(' | ');
        ok(!/found flights? waits?/.test(all), 'found'); ok(!/needs? a name/.test(all), 'spot'); ok(!/daily digest for/.test(all), 'digest');
        const panel = await page.locator('section.attention').innerText();
        ok(/2 found flights wait for review/.test(panel), 'panel found'); ok(/1 spot needs a name/.test(panel), 'panel spot'); ok(/daily digest for .* has not arrived/.test(panel), 'panel digest');
    });
    await check('upcoming: 3-day flight shown with its date, the 20 and 45 day flights are not (14 days)', async () => {
        const all = list.join(' | ');
        ok(/CX 891 DFW to HKG departs in 3 days/.test(all) || /CX 891 DFW to HKG departs in [234] days/.test(all), 'cx');
        ok(!/AA 1203/.test(all), 'aa1203'); ok(!/UA 77/.test(all), 'ua77');
    });
    await check('no booking reference or street in the card', async () => { const t = await card(page).innerText(); ok(!t.includes('QZ7RK2') && !t.includes('Maple'), 'leak'); });
    await check('Next 30 days adds the 20-day flight and is remembered', async () => {
        await card(page).locator('.seg', { hasText: 'Next 30 days' }).click();
        await settled(page);
        await page.waitForFunction(() => /AA 1203/.test(document.querySelector('section.today').innerText));
        eq(await page.evaluate(() => localStorage.getItem('hub-briefing-days')), '30');
        const t = await card(page).innerText(); ok(!/UA 77/.test(t), 'ua77 still hidden');
    });
    await check('Next 60 days adds the 45-day flight; the choice survives a reload', async () => {
        await card(page).locator('.seg', { hasText: 'Next 60 days' }).click();
        await page.waitForFunction(() => /UA 77/.test(document.querySelector('section.today').innerText));
        await page.reload(); await page.waitForSelector('section.today'); await settled(page);
        eq(await card(page).locator('.seg[aria-checked="true"]').innerText(), 'Next 60 days');
        ok(/UA 77/.test(await card(page).innerText()), 'ua77 after reload');
    });
    await check('flight item links to #/flights/<id>', async () => {
        await card(page).locator('a.today-link', { hasText: 'CX 891' }).click();
        await page.waitForFunction(() => /#\/flights\/\d+/.test(location.hash));
    });
    await check('found flights (panel link) goes to the found tab', async () => {
        await go(page, ''); await page.locator('section.attention a', { hasText: 'Review them' }).click();
        await page.waitForFunction(() => /#\/flights\?tab=found/.test(location.hash));
    });
    await check('place suggestions (panel link) go to the queue tab', async () => {
        await go(page, ''); await page.locator('section.attention a', { hasText: 'Name it' }).click();
        await page.waitForFunction(() => /#\/places\?tab=queue/.test(location.hash));
    });
    await check('missing digest (panel link) goes to digests', async () => {
        await go(page, ''); await page.locator('section.attention a', { hasText: 'Open digests' }).click();
        await page.waitForFunction(() => /#\/digests/.test(location.hash));
    });
    await check('the old attention list is still on the page', async () => { await go(page, ''); ok(await page.locator('section.attention').count() === 1, 'attention panel'); });
    await check('screenshot (light, 1280)', async () => { ok((await shot(page, 'briefing-light.jpg')) < 150000, 'size'); });
    await check('dark mode keeps severity colours readable', async () => {
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        const bg = await page.locator('li.today-item.sev-urgent').first().evaluate((e) => getComputedStyle(e).backgroundColor);
        ok(bg && bg !== 'rgba(0, 0, 0, 0)', `bg ${bg}`);
        ok((await shot(page, 'briefing-dark.jpg')) < 150000, 'size');
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    });
    await check('390 px: no horizontal overflow and the card fits', async () => {
        const m = await open({ viewport: { width: 390, height: 844 } });
        await settled(m.page);
        const w = await m.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, card: document.querySelector('section.today').getBoundingClientRect().right }));
        ok(w.sw <= w.cw + 1 && w.card <= w.cw, JSON.stringify(w));
        ok((await shot(m.page, 'briefing-390.jpg')) < 150000, 'size');
        await m.ctx.close();
    });
}
await check('no console errors', async () => eq(errors.length, 0, errors.slice(0, 3).join(' / ')));
await browser.close();
const bad = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
