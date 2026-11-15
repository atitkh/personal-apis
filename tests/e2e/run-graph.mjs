// Browser flow for the Graph dashboard page, against a SCRATCH hub seeded by graph-seed.js. Headless Chrome through
// playwright-core. Usage: node run-all.mjs graph. Env: BASE, KEY, SHOTS as in run-entities.mjs.
import fs from 'fs';
import lib from './lib.js';

const BASE = lib.assertScratchUrl(process.env.BASE || `http://localhost:${process.env.E2E_PORT || 3999}/admin/`);
const KEY = process.env.KEY || lib.KEY;
fs.mkdirSync(lib.shotsDir(), { recursive: true });
const results = [];
const errors = [];
let n = 0;
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what || 'not true'); };
async function check(name, fn) {
    n += 1;
    try { const r = await fn(); if (r === false) throw new Error('returned false'); results.push(['PASS', n, name]); } catch (e) { results.push(['FAIL', n, `${name} :: ${String(e.message).split('\n')[0].slice(0, 200)}`]); }
}
const browser = await lib.launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const go = async (hash) => { await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); await page.waitForSelector('.view.graph'); };
const api = (path) => page.evaluate(async (p) => (await fetch(`/admin/api${p}`, { headers: { 'X-Requested-With': 'hub-admin' } })).json(), path);

await page.goto(BASE);
await page.waitForSelector('input');
await page.fill('input', KEY);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('.rail-nav');
await page.waitForLoadState('networkidle');

await check('start page: nav item, g v shortcut, most connected list and unlinked counts', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g'); await page.keyboard.press('v');
    await page.waitForSelector('.view.graph');
    eq(await page.evaluate(() => location.hash), '#/graph', 'hash');
    ok(await page.locator('.rail-nav a', { hasText: 'Graph' }).count(), 'nav item');
    const t = await page.locator('.content').innerText();
    ok(t.includes('Mira Delgado') && t.includes('Hub redesign'), `hubs: ${t.slice(0, 200)}`);
    ok(/Entities \d+\/\d+/.test(t), 'unlinked counts');
});
await check('unlinked list shows the entity with no links', async () => {
    await go('graph?u=entities');
    ok((await page.locator('.content').innerText()).includes('Loner Vance'), 'Loner Vance listed');
    ok(!(await page.locator('.graph-list').last().innerText()).includes('Hub redesign'), 'linked one not listed');
});
await check('focused view draws the node, edges and the text list; two steps adds the farther ones', async () => {
    const ents = (await api('/entities?limit=50')).entities;
    const proj = ents.find((e) => e.name === 'Hub redesign');
    await go(`graph?d=entities&i=${proj.id}`);
    await page.waitForSelector('svg.graph-svg .graph-node');
    eq(await page.locator('.graph-node').count(), 3, 'nodes at 1 hop');
    eq(await page.locator('.graph-edge').count(), 2, 'edges at 1 hop');
    await page.screenshot({ path: `${lib.shotsDir()}/graph-1.png` });
    await page.getByRole('link', { name: 'Two steps' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.graph-node').length === 5);
    await page.screenshot({ path: `${lib.shotsDir()}/graph-2.png` });
    ok((await page.locator('.graph-list').innerText()).includes('Tides'), 'list has the 2-step record');
});
await check('clicking a node selects it, shows Center here, and centering changes the URL', async () => {
    await page.locator('.graph-node', { hasText: 'Example Foundation' }).click();
    ok(!(await page.locator('.graph-info').innerText()).includes('null'), 'no null in the strip');
    ok((await page.locator('.graph-info').innerText()).includes('Example Foundation'), 'info');
    await page.getByRole('link', { name: 'Center here' }).click();
    await page.waitForFunction(() => /graph\?d=entities&i=\d+/.test(location.hash));
    await page.waitForFunction(() => { const c = document.querySelector('.graph-node.is-center'); return c && c.textContent.includes('Example Foundation'); });
});
await check('hiding a domain removes its nodes; the entity drawer links to the graph', async () => {
    const ents = (await api('/entities?limit=50')).entities;
    const mira = ents.find((e) => e.name === 'Mira Delgado');
    await go(`graph?d=entities&i=${mira.id}`);
    await page.waitForSelector('.graph-node');
    const before = await page.locator('.graph-node').count();
    await page.locator('[data-key="hide:trips"]').click();
    await page.waitForFunction((b) => document.querySelectorAll('.graph-node').length < b, before);
    await page.goto(`${BASE}#/entities/${mira.id}`);
    await page.waitForSelector('dialog.drawer[open] [data-key="open-graph"]');
    await page.locator('[data-key="open-graph"]').click();
    await page.waitForSelector('.view.graph .graph-node');
});
await check('390 px: no sideways scroll', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${BASE}#/graph`);
    await page.waitForSelector('.view.graph');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow');
});
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));
await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
