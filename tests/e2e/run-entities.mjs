// Browser flow for the Entities dashboard page, against a SCRATCH hub seeded by entities-seed.js. Headless Chrome through
// playwright-core. Usage: node run-all.mjs entities (or node run-entities.mjs with BASE/KEY for a scratch hub).
// Env: BASE (default http://localhost:3999/admin/), KEY (admin key), SHOTS (output dir).
import fs from 'fs';
import lib from './lib.js';

const BASE = lib.assertScratchUrl(process.env.BASE || `http://localhost:${process.env.E2E_PORT || 3999}/admin/`);
const KEY = process.env.KEY || lib.KEY;
fs.mkdirSync(lib.shotsDir(), { recursive: true });

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
        const st = await page.evaluate(() => `hash=${location.hash} dialogs=${[...document.querySelectorAll('dialog[open]')].map((d) => d.className).join('|')}`).catch(() => '');
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

const settleDrawer = async () => {
    if (!(await page.locator('dialog.drawer[open]').count())) return;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
};
const go = async (hash) => { await settleDrawer(); await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); await page.waitForSelector('.content .view'); };
const hashNow = () => page.evaluate(() => location.hash);
const text = (sel) => page.locator(sel).first().innerText();
const waitToast = (re) => page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('.toast-stack') ? document.querySelector('.toast-stack').innerText : ''), re.source, { timeout: 6000 });
const api = (path) => page.evaluate(async (p) => (await fetch(`/admin/api${p}`, { headers: { 'X-Requested-With': 'hub-admin' } })).json(), path);
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };
const list = async () => (await api('/entities?limit=200')).entities;
const byName = async (name) => (await list()).find((e) => e.name === name);
const row = (name) => page.locator('.entity-row', { has: page.locator(`a.row-link:text-is("${name}")`) });
const drawerOpen = () => page.waitForSelector('dialog.drawer[open] .drawer-section');
async function signIn() {
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav');
    await page.waitForLoadState('networkidle');
}

await signIn();

await check('g n opens Entities; nav item present; three seeded entities with kind chips and aliases', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g'); await page.keyboard.press('n');
    await page.waitForSelector('.view.entities .entity-row');
    eq(await hashNow(), '#/entities', 'hash');
    ok(await page.locator('.rail-nav a', { hasText: 'Entities' }).count(), 'nav item');
    eq(await page.locator('.entity-row').count(), 3, 'rows');
    const t = await row('Mira Delgado').innerText();
    ok(t.includes('Person') && t.includes('Also: MD, Mira') && t.includes('0 links'), `row: ${t}`);
});
await check('kind chip filters; search finds by alias', async () => {
    await page.locator('[data-key="chip:project"]').click(); await page.waitForSelector('[data-key="chip:project"][aria-current="true"]');
    eq(await page.locator('.entity-row').count(), 1, 'projects');
    await go('entities');
    await page.fill('[data-key="e-search"]', 'md'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.entity-row').length === 1);
    ok((await text('.entity-row')).includes('Mira Delgado'), 'found by alias');
});
await check('New entity: kind, name, aliases, notes; a duplicate name is refused in plain words', async () => {
    await go('entities');
    await page.locator('[data-key="new-entity"]').click(); await page.waitForSelector('dialog.drawer[open] [data-key="ef-name"]');
    await page.fill('[data-key="ef-name"]', 'Mira Delgado');
    await page.locator('[data-key="ef-save"]').click();
    await page.waitForFunction(() => /already a person/.test(document.querySelector('dialog.drawer[open]').innerText));
    await page.fill('[data-key="ef-name"]', 'E2E Person');
    await page.fill('[data-key="ef-aliases"]', 'Zip, Zap');
    await page.fill('[data-key="ef-notes"]', 'made by the flow');
    await page.locator('[data-key="ef-save"]').click(); await waitToast(/Entity added/); await quiet();
    const e = await byName('E2E Person');
    ok(e && e.aliases.join() === 'Zip,Zap' && e.notes === 'made by the flow', `entity: ${JSON.stringify(e)}`);
    ok(await row('E2E Person').count(), 'row on the list');
});
await check('edit in the drawer: rename and drop an alias; history has two revisions', async () => {
    await row('E2E Person').locator('a.row-link').click(); await drawerOpen();
    await page.fill('[data-key="ef-name"]', 'E2E Person B');
    await page.fill('[data-key="ef-aliases"]', 'Zip');
    await page.locator('[data-key="ef-save"]').click(); await waitToast(/Changes saved/); await quiet();
    const e = await byName('E2E Person B');
    ok(e && e.aliases.join() === 'Zip' && e.rev === 2, `entity: ${JSON.stringify(e)}`);
    ok((await text('[data-key="history"]')).includes('2 revisions'), 'history heading');
});
await check('link a trip from the drawer: it shows under Linked and the list counts 1 link', async () => {
    await page.locator('[data-key="add-link"]').click(); await page.waitForSelector('dialog[open] input[name="q"]');
    await page.fill('dialog[open] input[name="q"]', 'Spring');
    await page.waitForSelector('dialog[open] input[name="target"]');
    await page.locator('dialog[open] input[name="rel"]').fill('with');
    await page.locator('dialog.form-dialog[open] button[type="submit"]').click(); await waitToast(/Linked/); await quiet();
    ok((await text('dialog.drawer .linked-section')).includes('Spring break'), 'linked trip');
    eq((await byName('E2E Person B')).link_count, 1, 'link_count');
});
await check('restore revision 1 puts the name and aliases back', async () => {
    await page.locator('dialog.drawer .rev-actions .btn', { hasText: 'Restore' }).first().click();
    await page.locator('dialog[open]:not(.drawer) .dialog-actions .btn').last().click();
    await waitToast(/Revision 1 restored/); await quiet();
    const e = await byName('E2E Person');
    ok(e && e.aliases.join() === 'Zip,Zap' && e.rev === 3, `entity: ${JSON.stringify(e)}`);
});
await check('search by alias finds the entity; the trip opens its linked entity', async () => {
    await go('search?q=zap');
    ok((await text('.view.search')).includes('E2E Person'), 'search result');
    const id = (await byName('E2E Person')).id;
    await go(`entities/${id}`); await drawerOpen();
    ok((await text('dialog.drawer .linked-section')).includes('Spring break'), 'linked trip after reload');
});
await check('Delete permanently: dialog counts the link; the entity and link go, the trip stays', async () => {
    await page.locator('[data-key="drawer-delete"]').click();
    await page.waitForSelector('dialog[open].delete-dialog');
    const d = await text('dialog[open].delete-dialog'); ok(d.includes('1 link') && d.includes('E2E Person'), `dialog: ${d.slice(0, 200)}`);
    await page.locator('dialog[open] input[name="backup"]').uncheck();
    await page.locator('dialog.delete-dialog button[type="submit"]').click(); await waitToast(/Deleted E2E Person/); await quiet();
    ok(!(await byName('E2E Person')), 'entity gone');
    const trips = (await api('/trips?limit=50')).trips;
    ok(trips.some((t) => t.title === 'Spring break'), 'trip stays');
});
await check('Activity shows entity rows without names; palette finds an entity and the New entity action', async () => {
    await go('activity?type=entities'); await page.waitForFunction(() => /added a person/.test(document.querySelector('.content').innerText), null, { timeout: 8000 }).catch(() => {});
    const t = await text('.content');
    ok(t.includes('added a person') && t.includes('deleted a person and 1 link'), `rows: ${t.replace(/\s+/g, ' ').slice(0, 400)}`);
    ok(!t.includes('E2E Person'), 'name in activity');
    await go('entities'); await quiet(); await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('Control+k'); await page.waitForSelector('dialog[open] input');
    await page.fill('dialog[open] input', 'Hub redesign');
    await page.waitForSelector('dialog[open] .palette-item:has-text("Hub redesign")', { timeout: 8000 }).catch(() => {});
    ok((await text('dialog[open]')).includes('Hub redesign'), 'entity entry');
    await page.fill('dialog[open] input', 'New entity');
    ok((await text('dialog[open]')).includes('New entity'), 'action');
    await page.keyboard.press('Escape');
});
await check('390 px: no sideways scroll on the list', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await go('entities');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow');
});
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
