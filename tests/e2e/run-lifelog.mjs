// Browser flow for the Lifelog dashboard page, against a SCRATCH hub seeded by lifelog-seed.js. Headless Chrome through
// playwright-core. Usage: node run-all.mjs lifelog (or node run-lifelog.mjs with BASE/KEY for a scratch hub).
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
page.setDefaultTimeout(8000);
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


const shift = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };
const today = shift(0);
const yesterday = shift(-1);
const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });
const episodes = async (d) => (await api(`/lifelog/episodes?local_date=${d}&status=all&limit=200`)).episodes;
const episode = async (title) => (await episodes(today)).find((e) => e.title === title);
const row = (title) => page.locator('.lifelog-episode', { has: page.locator(`a.row-link:text-is("${title}")`) });
const drawerOpen = () => page.waitForSelector('dialog.drawer[open] .drawer-section');
const dialogOpen = () => page.waitForSelector('dialog[open].form-dialog');
const rawCount = () => page.locator('.lifelog-line').count();
const toggleText = () => text('[data-key="raw-toggle"]');

await signIn();

// ---- the day ----
await check('g l opens Lifelog; nav item, privacy note, today in the title', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g'); await page.keyboard.press('l');
    await page.waitForSelector('.view.lifelog');
    eq(await hashNow(), '#/lifelog', 'hash');
    ok(await page.locator('.rail-nav a', { hasText: 'Lifelog' }).count(), 'nav item');
    ok((await text('.lifelog-privacy')).includes('handle with care'), 'privacy note');
    ok((await text('[data-key="day-title"]')).includes('(today)'), 'today title');
});
await check('strip: 5 episode blocks, a busy tick, 5 rows; cancelled one is muted with a chip', async () => {
    eq(await page.locator('.lifelog-block').count(), 5, 'blocks');
    eq(await page.locator('.lifelog-tick').count(), 24, 'ticks');
    ok(await page.locator('.lifelog-tick[style*="--d:1.00"]').count(), 'busiest tick');
    eq(await page.locator('.lifelog-episode').count(), 5, 'rows');
    ok(await page.locator('.lifelog-block.is-cancelled').count() === 1, 'cancelled block');
    const t = await row('Cancelled nap').innerText(); ok(t.includes('Cancelled') && t.includes('sleep'), `row: ${t}`);
    const t2 = await row('Evening walk').innerText(); ok(t2.includes('confidence 80%') && t2.includes('manual') && t2.includes('walk'), `row: ${t2}`);
});
await check('summary: 7 raw lines by source and kind, first and last', async () => {
    const t = await text('.lifelog-summary');
    ok(t.includes('7 raw lines') && t.includes('glasses 2') && t.includes('camera-node 2') && t.includes('mmwave 2') && t.includes('voice 1') && t.includes('eat 4') && t.includes('First') && t.includes('last'), t);
});
await check('sources panel and storage line', async () => {
    const t = await text('.lifelog-sources');
    for (const s of ['glasses', 'camera-node', 'mmwave', 'voice', 'oldcam']) ok(t.includes(s), `source ${s}`);
    const st = await text('[data-key="storage"]'); ok(/12 raw lines and 5 episodes, about [\d.]+ (B|KB)/.test(st) && st.includes('Nothing expires'), st);
});
await shot('lifelog-day');

// ---- prev / next / date ----
await check('Previous day: yesterday has lines but no episodes; Next and Today go back', async () => {
    await page.locator('[data-key="prev"]').click(); await page.waitForSelector('.lifelog-day'); await quiet();
    eq(await hashNow(), `#/lifelog/${yesterday}`, 'hash');
    ok((await text('.view.lifelog')).includes('No episodes for this day yet') && (await text('.lifelog-summary')).includes('2 raw lines'), 'yesterday');
    ok(await page.locator('[data-key="today"]').isEnabled(), 'Today enabled');
    await page.locator('[data-key="next"]').click(); await quiet();
    eq(await hashNow(), `#/lifelog/${today}`, 'next');
    ok(await page.locator('[data-key="today"]').isDisabled(), 'Today disabled on today');
});
await check('date input jumps to a day; an empty day says so', async () => {
    await page.locator('[data-key="date-input"]').fill('2026-10-05'); await quiet();
    eq(await hashNow(), '#/lifelog/2026-10-05', 'hash');
    ok((await text('.view.lifelog')).includes('Nothing logged for this day'), 'empty state');
    ok(await page.locator('[data-key="raw-toggle"]').isDisabled(), 'toggle disabled');
});

// ---- raw lines, filters, search, text as text ----
await check('raw lines collapsed by default, expand on click, oldest first', async () => {
    await go(`lifelog/${today}`);
    eq(await toggleText(), 'Show raw lines (7)', 'label'); eq(await rawCount(), 0, 'collapsed');
    eq(await page.locator('[data-key="raw-toggle"]').getAttribute('aria-expanded'), 'false');
    await page.locator('[data-key="raw-toggle"]').click(); await page.waitForSelector('.lifelog-line');
    eq(await rawCount(), 7, 'lines'); eq(await page.locator('[data-key="raw-toggle"]').getAttribute('aria-expanded'), 'true');
    ok((await page.locator('.lifelog-line').first().innerText()).includes('plate with eggs'), 'oldest first');
});
await check('HTML in a line renders as text: no script or bold element, no side effect', async () => {
    const t = await text('.lifelog-lines'); ok(t.includes('<script>window.__xss = 1</script>') && t.includes('<b>bold</b>'), 'literal text');
    eq(await page.locator('.lifelog-lines script, .lifelog-lines b').count(), 0, 'elements');
    eq(await page.evaluate(() => window.__xss), undefined, 'xss');
});
await check('source filter narrows the lines; kind filter too', async () => {
    await page.locator('[data-key="raw-source"]').selectOption('mmwave'); await quiet();
    eq(await rawCount(), 2, 'mmwave'); 
    await page.locator('[data-key="raw-source"]').selectOption(''); await page.locator('[data-key="raw-kind"]').selectOption('eat'); await quiet();
    eq(await rawCount(), 4, 'eat');
    await page.locator('[data-key="raw-kind"]').selectOption(''); await quiet();
    eq(await rawCount(), 7, 'all');
});
await check('search across days: lines and episodes, results link to their day', async () => {
    await page.locator('[data-key="search"]').fill('film'); await page.keyboard.press('Enter'); await page.waitForSelector('.lifelog-results .lifelog-line'); await quiet();
    eq(await hashNow(), '#/lifelog?q=film', 'hash');
    eq(await rawCount(), 1, 'one line'); ok((await text('.lifelog-results')).includes('watching a film'), 'text');
    await page.locator('.lifelog-line a.row-link').click(); await page.waitForSelector('.lifelog-day'); await quiet();
    eq(await hashNow(), `#/lifelog/${yesterday}`, 'day link');
    await go('lifelog?q=biryani'); await page.waitForSelector('.lifelog-results .lifelog-line'); await quiet();
    const t = await text('.lifelog-results'); ok(t.includes('Episodes, 1') && t.includes('Raw lines') && t.includes('biryani'), `results: ${t.slice(0, 200)}`);
});

// ---- add episode, add note ----
await check('New episode: errors stay inline, then it is added and shows in the strip', async () => {
    await go(`lifelog/${today}`);
    await page.locator('[data-key="new-episode"]').click(); await dialogOpen();
    await page.locator('dialog[open] button[type="submit"]').click();
    ok((await text('dialog[open] .error')).includes('Give the episode a title'), 'title error');
    await page.locator('dialog[open] [name="title"]').fill('Sat on the porch');
    await page.locator('dialog[open] [name="kind"]').selectOption('sit');
    await page.locator('dialog[open] [name="start"]').fill(`${today}T10:00`);
    await page.locator('dialog[open] [name="end"]').fill(`${today}T09:00`);
    await page.locator('dialog[open] button[type="submit"]').click();
    ok((await text('dialog[open] .error')).includes('end cannot be before'), 'end error');
    await page.locator('dialog[open] [name="end"]').fill(`${today}T10:45`);
    await page.locator('dialog[open] [name="start"]').fill(`${shift(3)}T10:00`);
    await page.locator('dialog[open] button[type="submit"]').click();
    await page.waitForFunction(() => /future/i.test((document.querySelector('dialog[open] .error') || {}).innerText || ''), null, { timeout: 5000 });
    await page.locator('dialog[open] [name="start"]').fill(`${today}T10:00`);
    await page.locator('dialog[open] [name="place"]').fill('porch');
    await page.locator('dialog[open] [name="confidence"]').fill('0.9');
    await page.locator('dialog[open] button[type="submit"]').click(); await waitToast(/Episode added/); await quiet();
    const e = await episode('Sat on the porch'); ok(e, 'episode'); eq(hm(e.start_at), '10:00', 'zone'); eq(hm(e.end_at), '10:45', 'end'); eq(e.kind, 'sit'); eq(e.confidence, 0.9); eq(e.source, 'manual');
    eq(await page.locator('.lifelog-block').count(), 6, 'blocks'); ok((await row('Sat on the porch').innerText()).includes('porch'), 'row');
});
await check('Add note: custom kind, source dashboard, HTML kept as text', async () => {
    await page.locator('[data-key="add-note"]').click(); await dialogOpen();
    await page.locator('dialog[open] button[type="submit"]').click();
    ok((await text('dialog[open] .error')).includes('Write the note'), 'note error');
    await page.locator('dialog[open] [name="text"]').fill('felt tired <i>again</i>');
    await page.locator('dialog[open] [name="kind"]').selectOption('__custom');
    await page.locator('dialog[open] [name="kind_custom"]').fill('Bad Kind!');
    await page.locator('dialog[open] button[type="submit"]').click();
    ok((await text('dialog[open] .error')).includes('lowercase word'), 'kind error');
    await page.locator('dialog[open] [name="kind_custom"]').fill('mood');
    await page.locator('dialog[open] [name="at"]').fill(`${today}T11:15`);
    await page.locator('dialog[open] button[type="submit"]').click(); await waitToast(/Note added/); await quiet();
    const r = await api(`/lifelog/observations?local_date=${today}&source=dashboard`);
    eq(r.total, 1, 'one dashboard line'); eq(r.observations[0].kind, 'mood'); eq(hm(r.observations[0].at), '11:15'); eq(r.observations[0].text, 'felt tired <i>again</i>');
    eq(await toggleText(), 'Show raw lines (8)', 'count');
});

// ---- the episode drawer ----
await check('click an episode: URL, drawer sections, no delete', async () => {
    await row('Ate lunch').locator('a.row-link').click(); await drawerOpen();
    const id = (await episode('Ate lunch')).id;
    eq(await hashNow(), `#/lifelog/episode/${id}?date=${today}`, 'hash');
    const t = await text('dialog.drawer[open]'); ok(t.includes('Linked lines, 0') && t.includes('History, 1 revision') && t.includes('never deleted here'), t.slice(0, 200));
    ok(!/Delete permanently/.test(t), 'no delete');
    await shot('lifelog-drawer');
});
await check('edit: title and place saved, history grows, list shows it', async () => {
    await page.locator('dialog.drawer [name="title"]').fill('Ate a late lunch');
    await page.locator('dialog.drawer [name="place"]').fill('dining room');
    await page.locator('[data-key="ef-save"]').click(); await waitToast(/Changes saved/); await quiet();
    const e = await episode('Ate a late lunch'); ok(e, 'renamed'); eq(e.place, 'dining room'); eq(e.rev, 2);
    ok((await text('dialog.drawer[open]')).includes('History, 2 revisions'), 'history');
    ok((await row('Ate a late lunch').innerText()).includes('dining room'), 'list row');
});
await check('history: Compare shows the diff, Restore brings revision 1 back as revision 3', async () => {
    await page.getByRole('button', { name: 'Compare revision 1 with the current one' }).click(); await page.waitForSelector('.diff-plain');
    ok((await text('.diff-plain')).includes('Title: Ate lunch'), 'diff');
    await page.getByRole('button', { name: 'Restore revision 1' }).first().click(); await page.waitForSelector('dialog[open].dialog'); await confirmYes(); await waitToast(/Revision 1 restored/); await quiet();
    const e = await episode('Ate lunch'); ok(e, 'restored title'); eq(e.rev, 3); eq(e.place, 'kitchen');
});
await check('cancelled toggle mutes it in the list', async () => {
    await page.locator('dialog.drawer [name="cancelled"]').check(); await page.locator('[data-key="ef-save"]').click(); await waitToast(/Changes saved/); await quiet();
    eq((await episode('Ate lunch')).status, 'cancelled', 'status');
    ok(await page.locator('.lifelog-episode.is-cancelled', { hasText: 'Ate lunch' }).count(), 'muted row');
    await page.locator('dialog.drawer [name="cancelled"]').uncheck(); await page.locator('[data-key="ef-save"]').click(); await waitToast(/Changes saved/); await quiet();
    eq((await episode('Ate lunch')).status, 'active', 'active again');
});
await check('link a raw line from the day, then unlink it', async () => {
    await page.locator('[data-key="link-open"]').click(); await page.waitForSelector('.lifelog-linker .lifelog-line');
    await page.locator('.lifelog-linker .lifelog-line', { hasText: 'biryani' }).locator('input').check();
    await page.locator('[data-key="link-go"]').click(); await waitToast(/1 line linked/); await quiet();
    const t = await text('dialog.drawer[open]'); ok(t.includes('Linked lines, 1') && t.includes('biryani'), 'linked');
    eq((await episode('Ate lunch')).observation_count, 1, 'api count');
    await page.getByRole('button', { name: /^Unlink the line at/ }).click(); await waitToast(/Line unlinked/); await quiet();
    eq((await episode('Ate lunch')).observation_count, 0, 'unlinked');
    ok((await text('dialog.drawer[open]')).includes('Linked lines, 0'), 'section');
});
await check('closing the drawer returns to the day', async () => {
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog.drawer[open]'), null, { timeout: 4000 }); await page.waitForTimeout(400);
    eq(await hashNow(), `#/lifelog/${today}`, 'hash');
});

// ---- forget a time range ----
await check('Forget: preview counts, then the red dialog with backup on by default; confirm with backup off', async () => {
    await go(`lifelog/${today}`);
    await page.locator('[data-key="manage"] summary').click(); await page.locator('[data-key="forget"]').click(); await dialogOpen();
    await page.locator('dialog[open] [name="from"]').fill('2026-10-01T00:00'); await page.locator('dialog[open] [name="to"]').fill('2026-10-01T23:59');
    await page.waitForFunction(() => /3 raw lines/.test(document.querySelector('[data-key="forget-preview"]').innerText), null, { timeout: 5000 });
    await page.locator('dialog[open] [name="source"]').selectOption('glasses');
    await page.waitForFunction(() => /0 raw lines/.test(document.querySelector('[data-key="forget-preview"]').innerText), null, { timeout: 5000 });
    await page.locator('dialog[open] [name="source"]').selectOption('');
    await page.waitForFunction(() => /3 raw lines/.test(document.querySelector('[data-key="forget-preview"]').innerText), null, { timeout: 5000 });
    await page.locator('dialog[open] button[type="submit"]').click(); await page.waitForSelector('dialog[open].delete-dialog');
    const d = await text('dialog[open].delete-dialog'); ok(d.includes('3 raw lines') && d.includes('cannot be undone'), `dialog: ${d.slice(0, 200)}`);
    ok(await page.locator('dialog[open] input[name="backup"]').isChecked(), 'backup on by default');
    await page.locator('dialog[open] input[name="backup"]').uncheck();
    await page.locator('dialog.delete-dialog button[type="submit"]').click(); await waitToast(/Forgot 3 raw lines/); await quiet();
    const s = await api('/lifelog/stats'); eq(s.observations, 12 + 1 - 3 + 0, 'observations left');
    ok(!(await api('/lifelog/sources')).sources.some((x) => x.label === 'oldcam'), 'oldcam gone');
    eq(s.episodes, 6, 'episodes untouched');
});
await check('Forget with nothing in the range is refused inline', async () => {
    await page.locator('[data-key="manage"] summary').click(); await page.locator('[data-key="forget"]').click(); await dialogOpen();
    await page.locator('dialog[open] [name="from"]').fill('2026-09-01T00:00'); await page.locator('dialog[open] [name="to"]').fill('2026-09-01T23:59');
    await page.locator('dialog[open] button[type="submit"]').click();
    await page.waitForFunction(() => /nothing in that range/i.test((document.querySelector('dialog[open] .error') || {}).innerText || ''), null, { timeout: 5000 });
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
});

// ---- activity, palette, small screen ----
await check('palette: Open Lifelog, New episode, Add note; ?new=note opens the dialog', async () => {
    await go('overview'); await page.keyboard.press('Control+k'); await page.waitForSelector('dialog[open] input');
    for (const label of ['Open Lifelog', 'New episode', 'Add note']) { await page.fill('dialog[open] input', label); ok((await text('dialog[open]')).includes(label), label); }
    await page.keyboard.press('Escape');
    await go('lifelog?new=note'); await dialogOpen(); ok((await text('dialog[open]')).includes('Add note'), 'dialog');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
});
await check('390 px: no sideways scroll on the day, the raw lines and the drawer', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await go(`lifelog/${today}`);
    await page.locator('[data-key="raw-toggle"]').click(); await page.waitForSelector('.lifelog-line'); await quiet();
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'day overflow');
    await shot('lifelog-phone');
    const id = (await episode('Evening walk')).id;
    await go(`lifelog/episode/${id}?date=${today}`); await drawerOpen();
    ok(await page.evaluate(() => { const b = document.querySelector('dialog.drawer').getBoundingClientRect(); return b.width <= window.innerWidth + 1; }), 'drawer width');
});
await check('nothing from the page in localStorage or sessionStorage', async () => {
    const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    ok(!keys.some((k) => /lifelog|observ|episode/i.test(k)), `keys: ${keys.join(',')}`);
});
await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
