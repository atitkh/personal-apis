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
    ok(t.includes('Cluster A') && t.includes('Cluster F'), `hubs: ${t.slice(0, 200)}`);
    ok(/Entities \d+\/\d+/.test(t), 'unlinked counts');
});
await check('unlinked list shows the entity with no links', async () => {
    await go('graph?u=entities');
    await page.waitForFunction(() => document.querySelector('.content').innerText.includes('Loner Vance'));
    ok(!(await page.locator('.graph-list').last().innerText()).includes('Hub redesign'), 'linked one not listed');
});
await check('focused view draws the node, edges and the text list; two steps adds the farther ones', async () => {
    const ents = (await api('/entities?limit=100')).entities;
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
    await page.locator('.graph-node', { hasText: 'Example Foundation' }).locator('circle').click();
    ok(!(await page.locator('.graph-info').innerText()).includes('null'), 'no null in the strip');
    ok((await page.locator('.graph-info').innerText()).includes('Example Foundation'), 'info');
    await page.locator('[data-key="graph-focus"]').click();
    await page.waitForFunction(() => /graph\?d=entities&i=\d+/.test(location.hash));
    await page.waitForFunction(() => { const c = document.querySelector('.graph-node.is-center'); return c && c.textContent.includes('Example Foundation'); });
});
await check('hiding a domain removes its nodes; the entity drawer links to the graph', async () => {
    const ents = (await api('/entities?limit=100')).entities;
    const mira = ents.find((e) => e.name === 'Mira Delgado');
    await go(`graph?d=entities&i=${mira.id}`);
    await page.waitForSelector('.graph-node');
    const before = await page.locator('.graph-node:not([hidden])').count();
    await page.locator('[data-key="hide:trips"]').click();
    await page.waitForFunction((b) => document.querySelectorAll('.graph-node:not([hidden])').length < b, before);
    ok((await page.evaluate(() => location.hash)).includes('hide=trips'), 'hide kept in the URL');
    await page.goto(`${BASE}#/entities/${mira.id}`);
    await page.waitForSelector('dialog.drawer[open] [data-key="open-graph"]');
    await page.locator('[data-key="open-graph"]').click();
    await page.waitForSelector('.view.graph .graph-node');
});
// ---- whole-graph overview and the canvas interaction ----
const vb = () => page.evaluate(() => document.querySelector('svg.graph-svg').getAttribute('viewBox').split(' ').map(Number));
const zoomOf = () => page.evaluate(() => Number(document.querySelector('svg.graph-svg').dataset.zoom));
// Waits until the zoom is `rel` ('gt' a factor above, 'eq' about equal to) ref; says what the zoom was when it never got there.
const waitZoom = async (rel, ref, what, factor = 1.2) => {
    try { await page.waitForFunction(([r, z, f]) => { const k = Number(document.querySelector('svg.graph-svg').dataset.zoom); return r === 'gt' ? k > z * f : Math.abs(k - z) < 0.01; }, [rel, ref, factor], { timeout: 5000 }); } catch (e) { throw new Error(`${what}: zoom is ${await zoomOf()}, wanted ${rel} ${ref}`); }
};
const nodeKey = (e) => `[data-key="node:entities:${e.id}"]`;
const centerOf = async (sel) => { const b = await page.locator(`${sel} circle`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const worldAt = async (px, py) => page.evaluate(([x, y]) => {
    const s = document.querySelector('svg.graph-svg'); const r = s.getBoundingClientRect(); const v = s.getAttribute('viewBox').split(' ').map(Number);
    return { x: v[0] + ((x - r.left) / r.width) * v[2], y: v[1] + ((y - r.top) / r.height) * v[3] };
}, [px, py]);
const openOverview = async () => { await go('graph'); await page.waitForSelector('svg.graph-svg[data-ready="1"] .graph-node'); };
let hubKey;

await check('overview: one graph of every linked record, coloured by domain, with a legend', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openOverview();
    const ents = (await api('/entities?limit=100')).entities;
    hubKey = nodeKey(ents.find((e) => e.name === 'Cluster A'));
    const ov = await api('/graph/overview');
    eq(await page.locator('.graph-node').count(), ov.nodes.length, 'nodes drawn');
    eq(await page.locator('.graph-edge').count(), ov.edges.length, 'edges drawn');
    ok(ov.nodes.length > 60 && ov.leftOut === 0, 'seed is dense and complete');
    ok(await page.locator('.graph-node.hue-sky').count() > 0 && await page.locator('.graph-node.hue-indigo').count() > 0, 'two domain colours');
    ok(await page.locator('[data-key="hide:trips"]').count() === 1 && await page.locator('[data-key="hide:entities"]').count() === 1, 'legend toggles');
    eq(await page.locator('[data-key="graph-left-out"]').count(), 0, 'no left-out note when nothing is left out');
    ok(await page.evaluate(() => { const s = document.querySelector('svg.graph-svg'); const r = s.getBoundingClientRect(); const v = s.getAttribute('viewBox').split(' ').map(Number); return v[2] > 0 && r.width > 300; }), 'canvas sized');
    await lib.shrinkShot(page, 'graph-overview-light');
});
await check('overview: layout is the same on every visit', async () => {
    const pos = () => page.evaluate(() => [...document.querySelectorAll('.graph-node')].slice(0, 12).map((g) => g.getAttribute('transform')).join('|'));
    const a = await pos();
    await openOverview();
    eq(await pos(), a, 'positions');
});
await check('overview: 400 records lay out in well under a second, and the same way twice', async () => {
    const out = await page.evaluate(async () => {
        const m = await import(new URL('views/graphCanvas.js', location.href.replace(/#.*$/, '')).href);
        const doms = ['entities', 'trips', 'places', 'deadlines', 'flights'];
        const make = () => { const nodes = Array.from({ length: 400 }, (_, i) => ({ key: `${doms[i % 5]}:${i}`, domain: doms[i % 5], degree: 1 + (i % 7) })); const edges = nodes.slice(1).map((n, i) => ({ from: nodes[Math.floor(i / 3)].key, to: n.key })); return { nodes, edges }; };
        const a = make(); const t0 = performance.now(); m.layoutOverview(a.nodes, a.edges); const ms = performance.now() - t0;
        const b = make(); m.layoutOverview(b.nodes, b.edges);
        return { ms, same: a.nodes.every((n, i) => n.x === b.nodes[i].x && n.y === b.nodes[i].y), finite: a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)) };
    });
    ok(out.finite && out.same, `finite and repeatable: ${JSON.stringify(out)}`);
    ok(out.ms < 900, `layout took ${Math.round(out.ms)} ms`);
    console.log(`layout of 400 nodes: ${Math.round(out.ms)} ms`);
});
await check('overview: wheel zooms around the cursor and the scale is clamped', async () => {
    const box = await page.locator('svg.graph-svg').boundingBox();
    const px = box.x + box.width * 0.7; const py = box.y + box.height * 0.35;
    const z0 = await zoomOf();
    const w0 = await worldAt(px, py);
    await page.mouse.move(px, py);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction((z) => Number(document.querySelector('svg.graph-svg').dataset.zoom) > z * 1.2, z0);
    const w1 = await worldAt(px, py);
    ok(Math.abs(w1.x - w0.x) < 1 && Math.abs(w1.y - w0.y) < 1, `cursor point moved: ${JSON.stringify(w0)} -> ${JSON.stringify(w1)}`);
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(150);
    ok(await zoomOf() <= 6.0001, 'max clamp');
    for (let i = 0; i < 14; i += 1) await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(150);
    ok(await zoomOf() >= 0.1499, 'min clamp');
});
await check('overview: Reset view fits everything again', async () => {
    await page.reload();
    await page.waitForSelector('svg.graph-svg[data-ready="1"] .graph-node');
    const fit = await zoomOf();
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -900);
    await waitZoom('gt', fit, 'wheel after reload', 1.3);
    await page.locator('[data-key="graph-fit"]').click();
    await waitZoom('eq', fit, 'reset');
});
await check('overview: dragging the background pans, and a node is not selected by it', async () => {
    await page.waitForTimeout(400);
    const before = await vb();
    const box = await page.locator('svg.graph-svg').boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height - 30);
    await page.mouse.down(); await page.mouse.move(box.x + 130, box.y + box.height - 70, { steps: 6 }); await page.mouse.up();
    const after = await vb();
    ok(after[0] < before[0] - 10 && after[1] > before[1] + 5, `viewBox ${before} -> ${after}`);
    eq(after[2], before[2], 'zoom unchanged by panning');
});
await check('overview: dragging a node moves it and its links only; nothing is selected or saved', async () => {
    await openOverview();
    const sel = hubKey;
    const before = await page.locator(sel).getAttribute('transform');
    const other = await page.locator('.graph-node').nth(3).getAttribute('transform');
    const c = await centerOf(sel);
    await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 60, c.y + 40, { steps: 5 }); await page.mouse.up();
    const after = await page.locator(sel).getAttribute('transform');
    ok(before !== after, 'node moved');
    eq(await page.locator('.graph-node').nth(3).getAttribute('transform'), other, 'other node stays');
    ok((await page.locator('.graph-info').innerText()).includes('Click a point'), 'drag did not select');
    const edge = await page.evaluate((k) => { const g = document.querySelector(k); const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform')); return [...document.querySelectorAll('.graph-edge')].some((l) => (Math.abs(l.getAttribute('x1') - m[1]) < 0.2 && Math.abs(l.getAttribute('y1') - m[2]) < 0.2) || (Math.abs(l.getAttribute('x2') - m[1]) < 0.2 && Math.abs(l.getAttribute('y2') - m[2]) < 0.2)); }, sel);
    ok(edge, 'a link follows the node');
    await page.reload(); await page.waitForSelector('svg.graph-svg[data-ready="1"] .graph-node');
    eq(await page.locator(sel).getAttribute('transform'), before, 'a reload puts it back');
});
await check('overview: hovering highlights the node, its links and neighbours, dims the rest, and shows a title', async () => {
    const c = await centerOf(hubKey);
    await page.mouse.move(c.x, c.y);
    await page.waitForSelector('svg.graph-svg.has-hover');
    ok(await page.locator('.graph-node.is-near').count() >= 10, 'neighbours lit');
    ok(await page.locator('.graph-edge.is-near').count() >= 10, 'links lit');
    const dim = await page.evaluate(() => { const n = [...document.querySelectorAll('.graph-node:not(.is-near):not(.is-hover)')][0]; return n ? getComputedStyle(n).opacity : null; });
    ok(dim !== null && Number(dim) < 0.5, `dimmed opacity ${dim}`);
    ok((await page.locator('.graph-tip').innerText()).includes('Cluster A'), 'tooltip title');
    await lib.shrinkShot(page, 'graph-overview-hover');
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector('svg.graph-svg.has-hover'));
    ok(await page.locator('.graph-tip').isHidden(), 'tooltip gone');
});
await check('overview: a click selects (panel with Focus and Open record); a double-click recentres softly and Back returns', async () => {
    await page.evaluate(() => { window.__still = 'same page'; });
    const c = await centerOf(hubKey);
    await page.mouse.click(c.x, c.y);
    await page.waitForFunction(() => document.querySelector('.graph-info').innerText.includes('Cluster A'));
    ok(await page.locator('.graph-node.is-selected').count() === 1, 'selected');
    ok(await page.locator('[data-key="graph-focus"]').count() === 1 && await page.getByRole('link', { name: 'Open record' }).count() === 1, 'panel actions');
    await page.mouse.dblclick(c.x, c.y);
    await page.waitForFunction(() => /graph\?d=entities&i=\d+/.test(location.hash));
    await page.waitForFunction(() => { const x = document.querySelector('.graph-node.is-center'); return x && x.textContent.includes('Cluster A'); });
    eq(await page.evaluate(() => window.__still), 'same page', 'no full page reload');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/graph');
    await page.waitForSelector('svg.graph-svg[data-ready="1"].is-dense');
    eq(await page.evaluate(() => window.__still), 'same page', 'Back is soft too');
});
await check('overview: the Focus button recentres, and hiding a domain keeps the other positions', async () => {
    await openOverview();
    const first = await page.locator('.graph-node.hue-sky').first().getAttribute('transform');
    const key = await page.locator('.graph-node.hue-sky').first().getAttribute('data-key');
    await page.locator('[data-key="hide:trips"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.graph-node.hue-indigo:not([hidden])').length === 0);
    eq(await page.locator(`[data-key="${key}"]`).getAttribute('transform'), first, 'positions stable');
    ok((await page.evaluate(() => location.hash)).includes('hide=trips'), 'hide in the URL');
    ok(await page.locator('.graph-edge:not([hidden])').count() < (await api('/graph/overview')).edges.length, 'its links hidden');
    await page.locator('[data-key="hide:trips"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.graph-node.hue-indigo:not([hidden])').length > 0);
    const c = await centerOf(hubKey);
    await page.mouse.click(c.x, c.y);
    await page.locator('[data-key="graph-focus"]').click();
    await page.waitForFunction(() => /graph\?d=entities&i=\d+/.test(location.hash));
    await page.waitForSelector('.graph-node.is-center');
});
await check('focused view: wheel zoom, background pan and node drag work there too', async () => {
    const ents = (await api('/entities?limit=100')).entities;
    const proj = ents.find((e) => e.name === 'Hub redesign');
    await go(`graph?d=entities&i=${proj.id}&depth=2`);
    await page.waitForSelector('svg.graph-svg[data-ready="1"] .graph-node');
    const z0 = await zoomOf();
    const box = await page.locator('svg.graph-svg').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.wheel(0, -500);
    await page.waitForFunction((z) => Number(document.querySelector('svg.graph-svg').dataset.zoom) > z * 1.2, z0);
    const v0 = await vb();
    await page.mouse.move(box.x + 20, box.y + box.height - 20); await page.mouse.down(); await page.mouse.move(box.x + 90, box.y + box.height - 60, { steps: 4 }); await page.mouse.up();
    ok((await vb())[0] < v0[0] - 5, 'panned');
    await page.locator('[data-key="graph-fit"]').click();
    await page.waitForFunction((z) => Math.abs(Number(document.querySelector('svg.graph-svg').dataset.zoom) - z) < 0.01, z0);
    const sel = '.graph-node:has-text("Tides")';
    const t0 = await page.locator(sel).getAttribute('transform');
    const c = await centerOf(sel);
    await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x - 50, c.y - 30, { steps: 4 }); await page.mouse.up();
    ok(t0 !== await page.locator(sel).getAttribute('transform'), 'node dragged');
    await page.mouse.move(c.x - 50, c.y - 30);
    await page.waitForSelector('svg.graph-svg.has-hover');
});
await check('keyboard: Enter selects a focused node, arrows pan, plus and minus zoom', async () => {
    await page.locator('.graph-node:has-text("Tides")').focus();
    await page.keyboard.press('Enter');
    ok((await page.locator('.graph-info').innerText()).includes('Tides'), 'selected with Enter');
    const v0 = await vb();
    await page.keyboard.press('ArrowRight');
    ok((await vb())[0] > v0[0] + 5, 'arrow pans');
    const z0 = await zoomOf();
    await page.keyboard.press('+');
    await waitZoom('gt', z0, 'plus key');
    await page.waitForTimeout(400);
    await page.keyboard.press('-');
    await waitZoom('eq', z0, 'minus key');
});
await check('touch: one finger pans, two fingers pinch zoom, a tap selects', async () => {
    const cdp = await ctx.newCDPSession(page);
    const box = await page.locator('svg.graph-svg').boundingBox();
    const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const v0 = await vb();
    await touch('touchStart', [[cx - 200, cy + 100]]);
    for (let i = 1; i <= 5; i += 1) await touch('touchMove', [[cx - 200 + i * 20, cy + 100 + i * 8]]);
    await touch('touchEnd', []);
    ok((await vb())[0] < v0[0] - 5, 'one finger pans');
    const z0 = await zoomOf();
    await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 6; i += 1) await touch('touchMove', [[cx - 40 - i * 15, cy], [cx + 40 + i * 15, cy]]);
    await touch('touchEnd', []);
    ok(await zoomOf() > z0 * 1.5, `pinch zoom ${z0} -> ${await zoomOf()}`);
    await page.locator('[data-key="graph-fit"]').click();
    await page.waitForTimeout(400);
    const c = await centerOf('.graph-node:has-text("Hub redesign")');
    await touch('touchStart', [[c.x, c.y]]); await touch('touchEnd', []);
    await page.waitForFunction(() => document.querySelector('.graph-info').innerText.includes('Hub redesign'));
    await cdp.detach();
});
await check('overview: dark theme and 390 px phone layout', async () => {
    await openOverview();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await lib.shrinkShot(page, 'graph-overview-dark');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
    const r = await page.locator('svg.graph-svg').boundingBox();
    ok(r.width <= 390 && r.height > 250, `canvas ${r.width}x${r.height}`);
    await lib.shrinkShot(page, 'graph-overview-390');
    await page.setViewportSize({ width: 1280, height: 900 });
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
