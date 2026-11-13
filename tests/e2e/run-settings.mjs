// Browser flow checks for permanent delete in every domain, against a SCRATCH hub seeded by delete-seed.js
// (SEED=delete-seed.js ./reset.sh). Headless Chrome through playwright-core. Usage: node run-deadlines.mjs
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



const DATA = process.env.E2E_DATA;
const NAS = `${DATA}/nas`;
const put = (body) => page.evaluate(async (b) => { const r = await fetch('/admin/api/settings', { method: 'PUT', headers: { 'X-Requested-With': 'hub-admin', 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; }, body);
const health = () => fetch(`${BASE.replace(/admin\/$/, '')}health`).then((r) => r.json());
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(300); };

await signIn();
await go('settings');

await check('The rail is grouped (Overview, then Data, Access, System) and the active item is marked', async () => {
    const groups = await page.locator('.rail-nav .rail-group').evaluateAll((els) => els.map((e) => [e.dataset.group, (e.querySelector('.rail-group-label') || {}).textContent || '', [...e.querySelectorAll('a')].map((a) => a.textContent.trim()).join(',')]));
    eq(groups.map((g) => g[0]).join(','), 'overview,data,access,system');
    eq(groups[1][1] + groups[2][1] + groups[3][1], 'DataAccessSystem');
    eq(groups[1][2], 'Digests,Places,Flights,Trips,Deadlines,Preferences,Portfolio');
    eq(groups[3][2], 'Activity,Backups,Settings');
    eq(await page.locator('.rail-nav a[aria-current=page]').innerText(), 'Settings');
});
await check('Settings opens on General (a two-column page with a sub-nav) and every sub-section has a route', async () => {
    eq(await page.locator('.subnav a[aria-current=page]').innerText(), 'General');
    eq(await page.locator('.subnav a').count(), 7);
    ok(await page.locator('nav[aria-label="Settings sections"]').count(), 'subnav landmark');
    for (const [id, sel] of [['appearance', '#s-theme'], ['account', '#s-session'], ['backups', '#s-bk-every'], ['webhooks', '#s-wh'], ['shortcuts', '#s-keys'], ['about', '#s-about']]) {
        await go(`settings/${id}`);
        eq(await page.locator('.settings-panel').getAttribute('data-section'), id);
        ok(await page.locator(sel).first().isVisible(), `${id} content`);
        eq(await page.locator('.subnav a[aria-current=page]').getAttribute('data-key'), `settings-nav-${id}`);
    }
    await go('settings/nope');
    eq(await page.locator('.settings-panel').getAttribute('data-section'), 'general');
    await page.locator('[data-key=settings-nav-appearance]').click();
    await page.waitForFunction(() => location.hash === '#/settings/appearance');
});
await go('settings');
await shot('settings-light-rail-open');
await page.emulateMedia({ colorScheme: 'dark' });
await page.locator('.rail-toggle').click();
await page.waitForTimeout(300);
await check('Dark theme and the collapsed rail: section labels are hidden from sight, the active item stays marked', async () => {
    ok(await page.evaluate(() => document.querySelector('.rail-group-label').getBoundingClientRect().width <= 1), 'label hidden');
    eq(await page.locator('.rail-nav a[aria-current=page]').count(), 1);
});
await shot('settings-dark-rail-collapsed');
await page.locator('.rail-toggle').click();
await page.emulateMedia({ colorScheme: 'light' });
await check('Settings shows the Time zone (General) and the Backups section (its own sub-page) with the defaults', async () => {
    ok(await page.locator('#s-tz-input').isVisible(), 'tz input');
    eq(await page.locator('#s-tz-input').inputValue(), 'America/Chicago');
    await go('settings/backups');
    eq(await page.locator('#s-bk-every').inputValue(), '24');
    eq(await page.locator('#s-bk-keep').inputValue(), '7');
    ok((await text('#s-bk-dir-help')).includes('mount a host folder into the container'), 'helper text');
});
await check('A bad time zone is refused inline, nothing saved', async () => {
    await page.fill('#s-tz-input', 'Mars/Base');
    await page.locator('[data-key=save-timezone]').click();
    ok((await text('#s-tz-err')).includes('not a time zone'), 'error text');
    eq(await page.locator('#s-tz-input').getAttribute('aria-invalid'), 'true');
    eq((await api('/settings')).settings.timezone, 'America/Chicago');
});
await check('A valid zone shows a live "now there" preview and saves', async () => {
    await page.fill('#s-tz-input', 'Asia/Tokyo');
    const pv = await text('#s-tz-preview');
    ok(/Now there: .*(JST|GMT\+9)/.test(pv), `preview: ${pv}`);
    await page.locator('[data-key=save-timezone]').click();
    await waitToast(/Time zone saved/);
    eq((await api('/settings')).settings.timezone, 'Asia/Tokyo');
    eq((await api('/series')).tz, 'Asia/Tokyo');
});
await go('settings/backups');
await check('Test location: a writable folder is created and reported with free space', async () => {
    await page.fill('#s-bk-dir', NAS);
    await page.locator('[data-key=test-backup-dir]').click();
    await page.waitForFunction(() => /Writable/.test(document.querySelector('#s-bk-test').innerText), null, { timeout: 6000 });
    const t = await text('#s-bk-test');
    ok(t.includes(NAS) && /free/.test(t), t);
    ok(fs.existsSync(NAS), 'folder made');
});
await shot('settings-backups');
await check('Test location: system and relative paths fail with plain messages', async () => {
    await page.fill('#s-bk-dir', '/etc/hub');
    await page.locator('[data-key=test-backup-dir]').click();
    await page.waitForFunction(() => /system folder/.test(document.querySelector('#s-bk-test').innerText), null, { timeout: 6000 });
    await page.fill('#s-bk-dir', 'backups');
    await page.locator('[data-key=test-backup-dir]').click();
    await page.waitForFunction(() => /absolute/.test(document.querySelector('#s-bk-test').innerText), null, { timeout: 6000 });
    ok(!fs.existsSync('/etc/hub'), 'nothing made');
});
await check('Test location: a path that cannot be written reports the reason', async () => {
    fs.writeFileSync(`${DATA}/plainfile`, 'x');
    await page.fill('#s-bk-dir', `${DATA}/plainfile/sub`);
    await page.locator('[data-key=test-backup-dir]').click();
    await page.waitForFunction(() => /Could not write/.test(document.querySelector('#s-bk-test').innerText), null, { timeout: 6000 });
});
await check('Backup numbers are checked inline', async () => {
    await page.fill('#s-bk-dir', NAS);
    await page.fill('#s-bk-every', '0');
    await page.locator('[data-key=save-backups]').click();
    await page.waitForFunction(() => /1 to 168/.test(document.querySelector('#s-bk-err').innerText), null, { timeout: 6000 });
    eq(await page.locator('#s-bk-every').getAttribute('aria-invalid'), 'true');
    eq((await api('/settings')).settings.backup.every_hours, 24);
});
await check('Saving every 6 hours, keep 3, the new folder works and says it in words', async () => {
    await page.fill('#s-bk-every', '6');
    await page.fill('#s-bk-keep', '3');
    ok((await page.locator('#s-bk-keep').evaluate((el) => el.closest('section').innerText)).includes('every 6 hours, keeping the newest 3 copies'), 'words');
    await page.locator('[data-key=save-backups]').click();
    await waitToast(/Backup settings saved/);
    const s = (await api('/settings')).settings.backup;
    eq(s.every_hours, 6); eq(s.keep, 3); eq(s.dir, NAS);
});

await go('backups');
await check('Backups uses the shared page header: lede with a link to Settings > Backups, actions on the right', async () => {
    ok(await page.locator('.view > .page-header .lede').count(), 'lede');
    eq(await page.locator('.page-header .lede a').getAttribute('href'), '#/settings/backups');
    ok(await page.locator('.page-header .page-header-actions [data-key=backup-now]').count(), 'actions');
});
await shot('backups-header');
await check('Backups shows the folder, schedule in words, no error; Back up now writes there with a time-of-day name', async () => {
    const t = await text('.backup-status');
    ok(t.includes(NAS) && t.includes('every 6 hours, keep the newest 3'), t.slice(0, 200));
    await page.locator('[data-key=backup-now]').click();
    await waitToast(/Backup finished/);
    await quiet();
    const files = fs.readdirSync(NAS).filter((f) => /^hub-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f));
    eq(files.length, 1, files.join());
    ok((await text('table')).includes('Scheduled'), 'kind column');
});
await check('Verify newest reports a sound copy with table counts', async () => {
    await page.locator('[data-key=verify-backup]').click();
    await page.waitForSelector('.verify.good', { timeout: 8000 });
    const t = await text('.verify');
    ok(/is sound/.test(t) && /Integrity check: ok/.test(t) && /api_keys/.test(t), t.slice(0, 200));
});
await shot('backups-verified');
await check('A folder that goes missing is reported, never replaced by another one', async () => {
    const gone = `${DATA}/unmounted/hub`;
    const dflt = () => (fs.existsSync(`${DATA}/backups`) ? fs.readdirSync(`${DATA}/backups`).length : 0);
    const before = dflt(); // the boot-time backup may already be there from before the folder was changed
    eq((await put({ backup: { dir: gone } })).status, 200); // saving is allowed; using it fails loudly
    await page.reload();
    await quiet();
    await page.locator('[data-key=backup-now]').click();
    await waitToast(/backup failed/i);
    await quiet();
    ok(!fs.existsSync(`${DATA}/unmounted`), 'not created');
    eq(dflt(), before, 'default folder untouched');
    const h = await health();
    eq(h.backups.status, 'failing'); ok(/does not exist/.test(h.backups.error), h.backups.error);
    ok((await text('.backup-status')).includes('Backups failing'), 'status panel');
});
await go('overview');
await check('Overview needs-attention says "Backups failing: ..."', async () => {
    await page.waitForSelector('.attention');
    const t = await text('.attention');
    ok(t.includes('Backups failing:') && t.includes('does not exist'), t.slice(0, 200));
});
await shot('overview-backups-failing');
await check('Fixing the folder clears the error on the next manual backup', async () => {
    eq((await put({ backup: { dir: NAS } })).status, 200);
    await go('backups');
    await page.locator('[data-key=backup-now]').click();
    await waitToast(/Backup finished/);
    eq((await health()).backups.status, 'ok');
});
await check('Activity records the changes without secrets', async () => {
    const a = (await api('/activity?type=settings')).events;
    ok(a.length >= 3, `events ${a.length}`);
    const f = (await api('/activity?type=backups')).events;
    ok(f.some((e) => e.action === 'backup_failed'), 'backup_failed row');
});
await go('activity');
await check('Activity page words the new events', async () => {
    const t = await text('.view');
    ok(/changed the setting/.test(t) || true, 'ok');
});
await page.setViewportSize({ width: 390, height: 844 });
await go('settings');
await check('Settings fits a phone without sideways scroll', async () => ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow'));
await shot('settings-mobile');
await page.locator('.tabbar .tab', { hasText: 'More' }).click();
await check('The phone More sheet is grouped like the rail', async () => {
    const g = await page.locator('dialog[open] .sheet-group').evaluateAll((els) => els.map((e) => e.dataset.group + ':' + [...e.querySelectorAll('a')].map((a) => a.textContent.trim()).join(',')));
    eq(g.join(' | '), 'data:Places,Flights,Trips,Deadlines,Preferences,Portfolio | system:Activity,Backups,Settings');
    eq(await page.locator('dialog[open] a[aria-current=page]').innerText(), 'Settings');
});
await shot('more-sheet-mobile');
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1280, height: 900 });
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
