// Browser flow checks for the Deadlines dashboard view, against a SCRATCH hub seeded by deadlines-seed.js
// (reset.sh with SEED=deadlines-seed.js). Headless Chrome through playwright-core. Usage: node run-deadlines.mjs
// Env: BASE (default http://localhost:3999/admin/), KEY (admin key), SHOTS (output dir).
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/voltex/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core');

const BASE = process.env.BASE || 'http://localhost:3999/admin/';
const KEY = process.env.KEY || 'e'.repeat(40);
const SHOTS = process.env.SHOTS || '/home/voltex/.openclaw/workspace/tmp/hub-flights-shots';
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

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
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
    execSync(`python3 -I /home/voltex/.openclaw/workspace/tmp/hub-flights-e2e/shrink.py ${raw} ${SHOTS}/${name}.jpg && rm ${raw}`);
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
const row = (title) => page.locator('.deadlines-table tbody tr', { has: page.locator(`a.row-link:text-is("${title}")`) });
const titles = () => page.locator('.deadlines-table tbody tr a.row-link').allInnerTexts();
const count = async (tab) => Number(await page.locator(`[data-count="${tab}"]`).innerText());
const listApi = async (status = 'all') => (await api(`/deadlines?status=${status}&limit=200`)).deadlines;
const byTitle = async (title) => (await listApi()).find((d) => d.title === title);
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };

await signIn();

// ---- navigation, tabs, counts ----
await check('g r opens Deadlines; nav item and rose view', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await page.waitForSelector('.view.deadlines');
    eq(await hashNow(), '#/deadlines', 'hash');
    ok(await page.locator('.rail-nav a', { hasText: 'Deadlines' }).count(), 'nav item');
});
await check('nav badge counts overdue and urgent (3)', async () => {
    await page.waitForFunction(() => document.querySelector('.rail-nav a[href="#/deadlines"] .nav-badge'));
    eq(await page.locator('.rail-nav a[href="#/deadlines"] .nav-badge').first().innerText(), '3');
});
await check('tab counts 9 / 11 / 2 and Upcoming is the default tab', async () => {
    eq(await count('upcoming'), 9); eq(await count('all'), 11); eq(await count('done'), 2);
    eq(await page.locator('#tab-upcoming').getAttribute('aria-selected'), 'true');
});
await check('Upcoming lists 9 active items soonest first', async () => {
    const t = await titles();
    eq(t.length, 9, 'rows');
    eq(t[0], 'Passport renewal'); eq(t[1], 'Water bill'); eq(t[2], 'Car insurance policy'); eq(t[3], 'Cloudstore storage'); eq(t[8], 'Driver licence');
});
await check('window chips: Overdue / Urgent / Soon / Later', async () => {
    const chip = async (t) => (await row(t).locator('.win-chip').innerText()).trim();
    eq(await chip('Passport renewal'), 'Overdue'); eq(await chip('Car insurance policy'), 'Urgent'); eq(await chip('Water bill'), 'Urgent');
    eq(await chip('Cloudstore storage'), 'Soon'); eq(await chip('Gym membership'), 'Soon'); eq(await chip('Streamvid subscription'), 'Later'); eq(await chip('Call the dentist'), 'Later');
    eq(await chip('Property tax'), 'Later'); eq(await chip('Driver licence'), 'Later');
});
await check('relative due text, repeat text and amount per cycle', async () => {
    ok((await row('Passport renewal').innerText()).includes('overdue by 12 days'), 'overdue by 12 days');
    ok((await row('Car insurance policy').innerText()).includes('in 5 days'), 'in 5 days');
    ok((await row('Car insurance policy').innerText()).includes('every year'), 'every year');
    ok((await row('Driver licence').innerText()).includes('every 48 months'), 'every 48 months');
    ok((await row('Streamvid subscription').innerText()).includes('$12.99 per month'), 'amount');
    ok((await row('Cloudstore storage').innerText()).includes('$119.88 per year'), 'yearly amount');
    ok(!(await row('Call the dentist').innerText()).includes('$'), 'no amount on a task');
});
await check('reference is not in the list DOM (nor notes)', async () => {
    const html = await page.locator('.content').innerHTML();
    ok(!html.includes('P-INVENTED-123') && !html.includes('POL-0001-X') && !html.includes('Ask about the crown'), 'leaked');
});
await check('subscriptions strip: per month by currency, next 3 renewals, label', async () => {
    const strip = await text('.subs-strip');
    ok(strip.includes('$67.98') && strip.includes('per month'), `usd ${strip}`);
    ok(strip.includes('€30.00'), 'eur');
    ok(strip.includes('Planned amounts, not payments.'), 'label');
    const next = await page.locator('.subs-next li a').allInnerTexts();
    eq(next.join(','), 'Water bill,Cloudstore storage,Gym membership');
    eq(await page.locator('.subs-totals li').count(), 2, 'one line per currency');
});
await check('kind chip, overdue-only and search narrow the list', async () => {
    await page.locator('.chip-link', { hasText: 'Subscription' }).click(); await quiet();
    eq((await titles()).length, 2);
    await page.locator('.chip-link', { hasText: 'All kinds' }).click(); await quiet();
    await page.locator('[data-key="only-overdue"]').click(); await quiet();
    eq((await titles()).join(), 'Passport renewal');
    await page.locator('[data-key="only-overdue"]').click(); await quiet();
    await page.fill('[data-key="d-search"]', 'water'); await page.keyboard.press('Enter'); await quiet();
    eq((await titles()).join(), 'Water bill');
    await go('deadlines');
});
await shot('deadlines-list');

// ---- Done, Reopen ----
await check('Done on a yearly item shows the next date and keeps it active', async () => {
    const before = await byTitle('Car insurance policy');
    await row('Car insurance policy').getByRole('button', { name: /Mark Car insurance policy done/ }).click();
    const nextDue = `${Number(before.due_date.slice(0, 4)) + 1}${before.due_date.slice(4)}`;
    await waitToast(`Next due ${(await fmt(nextDue)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    await quiet();
    const after = await byTitle('Car insurance policy');
    eq(after.status, 'active'); eq(after.due_date, nextDue);
    eq(await count('upcoming'), 9);
    ok((await row('Car insurance policy').innerText()).includes(await fmt(nextDue)), 'row shows new date');
});
await check('Done on a one-off moves it to the Done tab; Reopen brings it back', async () => {
    await row('Call the dentist').getByRole('button', { name: /done/ }).click(); await quiet();
    eq(await count('upcoming'), 8); eq(await count('done'), 3);
    await page.locator('#tab-done').click(); await quiet();
    ok((await titles()).includes('Call the dentist'), 'in done tab');
    ok((await row('Call the dentist').innerText()).includes('Done'), 'status chip');
    await row('Call the dentist').getByRole('button', { name: /Reopen/ }).click(); await quiet();
    eq(await count('upcoming'), 9); eq(await count('done'), 2);
    eq((await byTitle('Call the dentist')).status, 'active');
});
await check('Done tab and All tab content, status filter, empty states', async () => {
    await go('deadlines?tab=done');
    eq((await titles()).sort().join(), 'Old magazine,Washer warranty claim');
    await go('deadlines?tab=all');
    eq((await titles()).length, 11);
    await page.locator('.chip-link', { hasText: 'Ended' }).click(); await quiet();
    eq((await titles()).join(), 'Old magazine');
    await go('deadlines?tab=all&q=zzzz');
    ok((await text('.empty-state, .empty')).includes('No deadline matches'), 'no match text');
});

// ---- add via drawer ----
await check('Add drawer: kind-dependent fields, defaults follow the kind, live sentence', async () => {
    await go('deadlines?new=1');
    await page.waitForSelector('dialog.drawer[open] input[name="title"]');
    const d = 'dialog.drawer';
    ok(!(await page.locator(`${d} .money-group`).isVisible()), 'money hidden for document');
    eq(await page.inputValue(`${d} input[name="lead_days"]`), '90'); eq(await page.inputValue(`${d} input[name="urgent_days"]`), '14');
    eq((await text(`${d} .window-sentence`)).trim(), 'You will see it from 90 days before, urgent from 14 days before.');
    await page.selectOption(`${d} select[name="kind"]`, 'subscription');
    ok(await page.locator(`${d} .money-group`).isVisible(), 'money visible for subscription');
    eq(await page.inputValue(`${d} input[name="lead_days"]`), '7'); eq(await page.inputValue(`${d} input[name="urgent_days"]`), '3');
    eq((await text(`${d} .window-sentence`)).trim(), 'You will see it from 7 days before, urgent from 3 days before.');
    await page.selectOption(`${d} select[name="kind"]`, 'insurance');
    eq(await page.inputValue(`${d} input[name="lead_days"]`), '30'); eq(await page.inputValue(`${d} input[name="urgent_days"]`), '7');
    await page.fill(`${d} input[name="lead_days"]`, '45');
    await page.selectOption(`${d} select[name="kind"]`, 'task');
    eq(await page.inputValue(`${d} input[name="lead_days"]`), '45', 'edited window kept');
    ok((await text(`${d} .window-sentence`)).includes('from 45 days before'), 'sentence follows');
    await page.selectOption(`${d} select[name="repeat_kind"]`, 'every_n_months');
    ok(await page.locator(`${d} input[name="repeat_n"]`).isVisible(), 'N months field');
});
await check('Add drawer validation shows inline messages', async () => {
    const d = 'dialog.drawer';
    await page.locator(`${d} [data-key="df-save"]`).click();
    ok((await text(`${d} .error`)).includes('Give it a title'), 'title');
    await page.fill(`${d} input[name="title"]`, 'Test thing');
    await page.locator(`${d} [data-key="df-save"]`).click();
    ok((await text(`${d} .error`)).includes('Give the due date'), 'date');
    await page.fill(`${d} input[name="due_date"]`, todayChi);
    await page.locator(`${d} [data-key="df-save"]`).click();
    ok((await text(`${d} .error`)).includes('number of months'), 'months');
    await page.selectOption(`${d} select[name="repeat_kind"]`, 'none');
    await page.fill(`${d} input[name="urgent_days"]`, '99');
    await page.locator(`${d} [data-key="df-save"]`).click();
    ok((await text(`${d} .error`)).includes('Urgent cannot start earlier'), 'window');
});
await check('Add a subscription through the drawer; it appears in the list and the strip', async () => {
    const d = 'dialog.drawer';
    await page.selectOption(`${d} select[name="kind"]`, 'subscription');
    await page.fill(`${d} input[name="title"]`, 'Musicbox plan');
    await page.fill(`${d} input[name="lead_days"]`, '7'); await page.fill(`${d} input[name="urgent_days"]`, '3');
    await page.fill(`${d} input[name="due_date"]`, new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }));
    await page.fill(`${d} input[name="amount"]`, '5.50');
    await page.selectOption(`${d} select[name="cycle"]`, 'monthly');
    await page.fill(`${d} input[name="reference"]`, 'MB-INVENTED-9');
    await page.locator(`${d} [data-key="df-save"]`).click();
    await waitToast('Musicbox plan added'); await quiet();
    const made = await byTitle('Musicbox plan');
    eq(made.amount_cents, 550); eq(made.cycle, 'monthly'); eq(made.reference, 'MB-INVENTED-9'); eq(made.currency, 'USD');
    ok(await row('Musicbox plan').count(), 'row');
    ok((await text('.subs-strip')).includes('$73.48'), `strip total ${await text('.subs-strip')}`);
});

// ---- drawer: reference mask, edit, history, restore, end ----
await check('Drawer: reference masked by default, Show reveals it', async () => {
    const p = await byTitle('Passport renewal');
    await go(`deadlines/${p.id}`);
    await page.waitForSelector('dialog.drawer[open] input[name="reference"]');
    eq(await page.getAttribute('dialog.drawer input[name="reference"]', 'type'), 'password');
    await page.locator('dialog.drawer [data-key="ref-toggle"]').click();
    eq(await page.getAttribute('dialog.drawer input[name="reference"]', 'type'), 'text');
    eq(await page.inputValue('dialog.drawer input[name="reference"]'), 'P-INVENTED-123');
});
await check('Edit saves, History lists revisions, Restore brings the old title back', async () => {
    const d = 'dialog.drawer';
    await page.fill(`${d} input[name="title"]`, 'Passport renewal (book)');
    await page.locator(`${d} [data-key="df-save"]`).click();
    await waitToast('Changes saved'); await quiet();
    eq((await byTitle('Passport renewal (book)')).rev, 2);
    ok((await text(`${d} #dd-history`)).includes('2 revisions'), 'history count');
    await page.locator(`${d} .rev-actions button`, { hasText: 'Restore' }).first().click();
    await confirmYes(); await quiet();
    ok(await byTitle('Passport renewal'), 'title restored');
    eq((await byTitle('Passport renewal')).rev, 3);
    await page.locator(`${d} .rev-actions button`, { hasText: 'Compare' }).first().click();
    await page.waitForSelector(`${d} .diff-plain`);
    ok((await text(`${d} .diff-plain`)).includes('Title: Passport renewal'), 'compare view');
});
await check('End asks first, then the item is in Done with an Ended chip; Reopen from the drawer', async () => {
    const d = 'dialog.drawer';
    await page.locator(`${d} button`, { hasText: 'Back to the deadline' }).click(); await quiet();
    await page.locator(`${d} [data-key="drawer-end"]`).click();
    await page.waitForSelector('dialog[open] .dialog-actions');
    await page.locator('dialog[open] .dialog-actions .btn').first().click(); await page.waitForTimeout(250);
    eq((await byTitle('Passport renewal')).status, 'active', 'cancel keeps it');
    await page.locator(`${d} [data-key="drawer-end"]`).click();
    await confirmYes(); await quiet();
    eq((await byTitle('Passport renewal')).status, 'ended');
    ok(await page.locator(`${d} [data-key="drawer-reopen"]`).count(), 'reopen button');
    await page.locator(`${d} [data-key="drawer-reopen"]`).click(); await quiet();
    eq((await byTitle('Passport renewal')).status, 'active');
    await page.keyboard.press('Escape');
});
await check('The drawer has one quiet Delete permanently button beside End (delete itself is run-delete.mjs)', async () => {
    const p = await byTitle('Passport renewal');
    await go(`deadlines/${p.id}`);
    await page.waitForSelector('dialog.drawer[open] input[name="title"]');
    eq(await page.locator('dialog.drawer button', { hasText: /delete/i }).count(), 1);
    eq(await page.locator('dialog.drawer [data-key="drawer-delete"]').innerText(), 'Delete permanently');
    await page.keyboard.press('Escape');
});

// ---- overview, palette, themes, mobile ----
await check('Overview board has a rose Deadlines channel with power switch and mode selector', async () => {
    await go('overview');
    const ch = page.locator('.channel[data-domain="deadlines"]');
    await ch.waitFor();
    ok((await ch.getAttribute('class')).includes('hue-rose'), 'rose class');
    ok(await ch.locator('input[type="checkbox"], [role="switch"]').count(), 'power switch');
    ok(await ch.locator('[role="radiogroup"], .segmented, button[aria-pressed]').count(), 'mode selector');
});
await check('A briefing item for a deadline links to #/deadlines/<id>', async () => {
    const p = await byTitle('Passport renewal');
    const link = page.locator(`.today-item a[href="#/deadlines/${p.id}"]`);
    await link.first().waitFor({ timeout: 5000 });
    await link.first().click();
    await page.waitForSelector('dialog.drawer[open]');
    eq(await hashNow(), `#/deadlines/${p.id}`);
    await page.keyboard.press('Escape');
});
await check('Command palette: actions and one entry per active deadline', async () => {
    await go('overview');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('dialog[open] input');
    await page.keyboard.type('Add deadline');
    ok((await text('dialog[open]')).includes('Add deadline'), 'add action');
    await page.fill('dialog[open] input', 'due soon');
    ok((await text('dialog[open]')).includes('Deadlines due soon'), 'due soon action');
    await page.fill('dialog[open] input', 'Water bill');
    const t = await text('dialog[open]');
    ok(t.includes('Water bill'), 'entry');
    ok(!t.includes('P-INVENTED') && !t.includes('$45'), 'no private data');
    await page.keyboard.press('Enter'); await page.waitForSelector('dialog.drawer[open]');
    ok((await hashNow()).startsWith('#/deadlines/'), 'opens the drawer');
    await page.keyboard.press('Escape');
});
await check('Dark mode uses the dark rose', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await go('deadlines');
    eq(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rose').trim().toUpperCase()), '#F08AA6');
});
await shot('deadlines-dark');
await page.emulateMedia({ colorScheme: 'light' });
await check('390 px: no sideways scroll, rows stacked', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await go('deadlines');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow');
    ok(await page.locator('.deadlines-table tbody tr').first().isVisible(), 'rows');
});
await shot('deadlines-mobile');
await check('390 px: Add drawer fits', async () => {
    await go('deadlines?new=1');
    await page.waitForSelector('dialog.drawer[open] input[name="title"]');
    ok(await page.evaluate(() => { const b = document.querySelector('dialog.drawer').getBoundingClientRect(); return b.width <= window.innerWidth + 1; }), 'drawer width');
    await page.keyboard.press('Escape');
});
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
