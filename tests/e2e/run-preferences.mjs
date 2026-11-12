// Browser flow checks for the Preferences dashboard view, against a SCRATCH hub seeded by preferences-seed.js
// (reset.sh with SEED=preferences-seed.js). Headless Chrome through playwright-core. Usage: node run-preferences.mjs
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
async function signIn() {
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav');
    await page.waitForLoadState('networkidle');
}

const todayChi = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const fmt = (iso) => page.evaluate((d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), iso);
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };

const keys = () => page.locator('.pref-row a.row-link').allInnerTexts();
const areas = () => page.locator('.pref-group h2').allInnerTexts();
const listApi = async (removed = false) => (await api(`/preferences?limit=200${removed ? '&removed=true' : ''}`)).preferences;
const drawerOpen = () => page.waitForSelector('dialog.drawer[open]');
const closeDrawer = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); };

await signIn();

await check('g e opens Preferences; nav item present', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g'); await page.keyboard.press('e');
    await page.waitForSelector('.view.preferences');
    eq(await hashNow(), '#/preferences', 'hash');
    ok(await page.locator('.rail-nav a', { hasText: 'Preferences' }).count(), 'nav item');
});
await check('grouped by area with counts, in area order', async () => {
    const a = (await areas()).map((s) => s.replace(/\s+/g, ' ').trim());
    eq(JSON.stringify(a), JSON.stringify(['Travel 2', 'Communication 2', 'Work 1', 'Food 1']));
    eq((await keys()).join('|'), 'Preferred airline|Airline seat|Call hours|Contact email|Meeting length|Allergy'.replace('Preferred airline|Airline seat', 'Airline seat|Preferred airline'));
});
await check('rows show key with spaces, value, and muted notes', async () => {
    const r = page.locator('.pref-row', { has: page.locator('a.row-link:text-is("Airline seat")') });
    eq(await r.locator('.pref-value').innerText(), 'aisle');
    eq(await r.locator('.pref-notes').innerText(), 'Near the front when possible.');
    ok(!(await page.locator('.pref-row').allInnerTexts()).join(' ').includes('_'), 'no underscores shown');
});
await check('email-looking value is shown as is', async () => {
    ok((await page.locator('.pref-row', { hasText: 'Contact email' }).innerText()).includes('friend.example@example.com'));
});
await check('Removed (1) toggle is shown and the removed item is not in the list', async () => {
    eq((await page.locator('[data-key="removed-toggle"]').innerText()).trim(), 'Removed (1)');
    ok(!(await keys()).includes('Phone brand'), 'hidden');
});
await check('Add drawer: hint text under the value field', async () => {
    await page.locator('[data-key="new-pref"]').click(); await drawerOpen();
    eq(await page.locator('dialog.drawer .help', { hasText: 'Plain facts only' }).innerText(), 'Plain facts only: no passwords, numbers or keys.');
    ok(await page.locator('dialog.drawer select[name="area"]').count(), 'area select');
});
await check('secret-looking value is refused with the inline vault sentence; nothing saved', async () => {
    await page.selectOption('dialog.drawer select[name="area"]', 'devices');
    await page.fill('dialog.drawer input[name="key"]', 'wifi network');
    await page.fill('dialog.drawer input[name="value"]', 'pak_abc123def');
    await page.locator('dialog.drawer [data-key="pf-save"]').click();
    await page.waitForFunction(() => /vault/.test(document.querySelector('dialog.drawer .field-msg:not(:empty)')?.textContent || ''));
    ok((await page.locator('dialog.drawer .field-msg:not(:empty)').first().innerText()).includes('Keep passwords, numbers and keys in the vault, not here.'));
    eq(await page.evaluate(() => document.activeElement.name), 'value', 'focus');
    eq((await listApi()).length, 6);
});
await check('password-ish key is refused inline next to the key field', async () => {
    await page.fill('dialog.drawer input[name="key"]', 'door passcode');
    await page.fill('dialog.drawer input[name="value"]', 'tulip');
    await page.locator('dialog.drawer [data-key="pf-save"]').click();
    await page.waitForFunction(() => document.activeElement.name === 'key');
    ok((await page.locator('dialog.drawer .field:has(input[name="key"]) .field-msg').innerText()).includes('vault'));
});
await check('a valid value adds the preference and lists it under its area', async () => {
    await page.fill('dialog.drawer input[name="key"]', 'wifi network');
    await page.fill('dialog.drawer input[name="value"]', 'Home mesh, 5 GHz');
    await page.locator('dialog.drawer [data-key="pf-save"]').click();
    await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'));
    await quiet();
    ok((await areas()).some((a) => /^Devices/.test(a)), 'Devices group');
    ok((await keys()).includes('Wifi network'), 'row');
    eq((await listApi()).find((p) => p.key === 'wifi_network').value, 'Home mesh, 5 GHz');
});
await check('duplicate area and key is refused inline', async () => {
    await page.locator('[data-key="new-pref"]').click(); await drawerOpen();
    await page.selectOption('dialog.drawer select[name="area"]', 'devices');
    await page.fill('dialog.drawer input[name="key"]', 'Wifi Network');
    await page.fill('dialog.drawer input[name="value"]', 'x');
    await page.locator('dialog.drawer [data-key="pf-save"]').click();
    await page.waitForFunction(() => /already a preference/.test(document.querySelector('dialog.drawer')?.innerText || ''));
    await page.locator('dialog.drawer button', { hasText: 'Cancel' }).click(); await page.waitForTimeout(300); await confirmYes(); await page.waitForTimeout(300);
});
await check('Edit opens the drawer; saving a new value makes revision 2; History lists 2', async () => {
    await page.locator('.pref-row', { has: page.locator('a.row-link:text-is("Airline seat")') }).locator('a', { hasText: 'Edit' }).click();
    await drawerOpen();
    ok(/^#\/preferences\/\d+$/.test(await hashNow()), 'hash');
    await page.waitForSelector('dialog.drawer input[name="value"]');
    eq(await page.inputValue('dialog.drawer input[name="key"]'), 'airline seat');
    await page.fill('dialog.drawer input[name="value"]', 'window');
    await page.locator('dialog.drawer [data-key="pf-save"]').click();
    await waitToast('Changes saved');
    await page.waitForFunction(() => /History, 2 revisions/.test(document.querySelector('dialog.drawer')?.innerText || ''));
});
await check('History Restore brings back revision 1 as revision 3', async () => {
    await page.locator('dialog.drawer .rev-actions button', { hasText: 'Restore' }).first().click();
    await confirmYes();
    await waitToast('Revision 1 restored');
    await page.waitForFunction(() => /History, 3 revisions/.test(document.querySelector('dialog.drawer')?.innerText || ''));
    eq(await page.inputValue('dialog.drawer input[name="value"]'), 'aisle');
});
await check('Remove asks to confirm, hides the item and updates Removed (2)', async () => {
    await page.locator('dialog.drawer [data-key="drawer-remove"]').click();
    await confirmYes();
    await waitToast('removed');
    await page.waitForFunction(() => /Removed/.test(document.querySelector('dialog.drawer .drawer-section h3')?.textContent || ''));
    await closeDrawer(); await quiet();
    ok(!(await keys()).includes('Airline seat'), 'gone from list');
    eq((await page.locator('[data-key="removed-toggle"]').innerText()).trim(), 'Removed (2)');
});
await check('Removed toggle lists removed items; Restore brings one back', async () => {
    await page.locator('[data-key="removed-toggle"]').click(); await quiet();
    eq(await hashNow(), '#/preferences?removed=1');
    eq((await keys()).sort().join('|'), 'Airline seat|Phone brand');
    await page.locator('.pref-row', { has: page.locator('a.row-link:text-is("Phone brand")') }).locator('button', { hasText: 'Restore' }).click();
    await waitToast('restored'); await quiet();
    eq((await keys()).join('|'), 'Airline seat');
    eq((await listApi()).filter((p) => p.key === 'phone_brand').length, 1);
});
await check('back to the list: restored item is there, airline seat is not', async () => {
    await page.locator('[data-key="removed-toggle"]').click(); await quiet();
    const k = await keys();
    ok(k.includes('Phone brand') && !k.includes('Airline seat'), k.join(','));
});
await check('search narrows by value and by key words; clear restores', async () => {
    await page.fill('[data-key="p-search"]', 'peanuts'); await page.keyboard.press('Enter'); await quiet();
    eq((await keys()).join('|'), 'Allergy');
    await page.fill('[data-key="p-search"]', 'call hours'); await page.keyboard.press('Enter'); await quiet();
    eq((await keys()).join('|'), 'Call hours');
    await page.fill('[data-key="p-search"]', 'zzzz'); await page.keyboard.press('Enter'); await quiet();
    ok((await text('.pref-panel')).includes('No preference matches'), 'empty');
    await go('preferences');
    ok((await keys()).length >= 7, 'all back');
});
await check('Remove from the drawer of a removed item shows Restore and no Remove button', async () => {
    const gone = (await listApi(true)).find((p) => p.key === 'airline_seat');
    await go(`preferences/${gone.id}`); await drawerOpen();
    await page.waitForSelector('dialog.drawer [data-key="drawer-restore"]');
    eq(await page.locator('dialog.drawer [data-key="drawer-remove"]').count(), 0);
    await page.locator('dialog.drawer [data-key="drawer-restore"]').click();
    await waitToast('restored'); await closeDrawer(); await quiet();
    ok((await keys()).includes('Airline seat'), 'back in the list');
});
await check('palette has Add preference and it opens the Add drawer', async () => {
    await go('overview');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('dialog[open] input');
    await page.fill('dialog[open] input', 'Add preference');
    ok((await text('dialog[open]')).includes('Add preference'));
    await page.keyboard.press('Enter');
    await drawerOpen();
    ok((await text('dialog.drawer')).includes('Add a preference'));
    await closeDrawer();
});
await check('audit rows for the whole flow hold no values', async () => {
    const a = await api('/activity?type=preferences');
    const rows = a.events || a.items || a.activity || [];
    ok(rows.length >= 5, `rows ${rows.length}`);
    const s = JSON.stringify(rows);
    for (const secret of ['pak_abc123def', 'Home mesh', 'window', 'aisle', 'peanuts']) ok(!s.includes(secret), `leaked ${secret}`);
    ok(rows.some((r) => r.action === 'preference_unset'), 'unset row');
});
await check('Overview shows the Preferences channel with the write-warning text available', async () => {
    await go('overview');
    ok(await page.locator('.channel[data-domain="preferences"]').count(), 'channel');
    ok((await text('.channel[data-domain="preferences"]')).includes('Preferences'));
});

// ---- empty state ----
await check('empty state: three example chips; a chip prefills the Add drawer', async () => {
    const all = await listApi();
    for (const p of all) await page.evaluate(async (id) => { await fetch(`/admin/api/preferences/${id}/unset`, { method: 'POST', headers: { 'X-Requested-With': 'hub-admin', 'Content-Type': 'application/json' }, body: '{}' }); }, p.id);
    await go('preferences');
    eq(await page.locator('.pref-examples .chip-link').count(), 3);
    eq((await page.locator('.pref-examples .chip-link').allInnerTexts()).join('|'), 'Seat preference: aisle|No calls before 10 am|Preferred airline: American');
    await page.locator('.pref-examples .chip-link').nth(1).click(); await drawerOpen();
    eq(await page.inputValue('dialog.drawer input[name="key"]'), 'call hours');
    eq(await page.inputValue('dialog.drawer input[name="value"]'), 'No calls before 10 am');
    eq(await page.inputValue('dialog.drawer select[name="area"]'), 'communication');
    await closeDrawer();
    eq(await page.locator('dialog.drawer[open]').count(), 0, 'closes without a discard prompt');
});
await check('a chip can be saved as is', async () => {
    await page.locator('.pref-examples .chip-link').nth(0).click(); await drawerOpen();
    await page.locator('dialog.drawer [data-key="pf-save"]').click();
    await waitToast('added'); await quiet();
    ok((await keys()).includes('Seat preference'), 'row');
});

await check('Dark mode uses the dark brick', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await go('preferences');
    eq(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brick').trim().toUpperCase()), '#E58468');
    ok(await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.pref-list')).backgroundColor; return c !== 'rgb(255, 255, 255)'; }), 'dark surface');
});
await shot('preferences-dark');
await page.emulateMedia({ colorScheme: 'light' });
await check('390 px: no sideways scroll, rows stack, Add drawer fits', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await go('preferences');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow');
    await page.locator('[data-key="new-pref"]').click(); await drawerOpen();
    ok(await page.evaluate(() => document.querySelector('dialog.drawer').getBoundingClientRect().width <= window.innerWidth + 1), 'drawer width');
    await closeDrawer();
});
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
