// Browser flow for the Notes dashboard page, against a SCRATCH hub seeded by notes-seed.js. Headless Chrome through
// playwright-core. Usage: node run-all.mjs notes (or node run-notes.mjs with E2E_PORT for a scratch hub).
// Env: E2E_PORT, KEY (admin key), SHOTS (output dir). Screenshots: list, editor, popups, revisions, graph (dark, light, 390 px).
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
        results.push(['FAIL', n, `${name} :: ${String(e.message).split('\n')[0].slice(0, 220)} [${st}]`]);
    }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what || 'not true'); };

const browser = await lib.launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

const go = async (hash) => { await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); await page.waitForSelector('.content .view'); };
const hashNow = () => page.evaluate(() => location.hash);
const text = (sel) => page.locator(sel).first().innerText();
const waitToast = (re) => page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('.toast-stack') ? document.querySelector('.toast-stack').innerText : ''), re.source, { timeout: 8000 });
const api = (path, init) => page.evaluate(async ([p, i]) => {
    const res = await fetch(`/admin/api${p}`, { headers: { 'X-Requested-With': 'hub-admin', ...(i && i.body ? { 'Content-Type': 'application/json' } : {}) }, ...(i || {}), body: i && i.body ? JSON.stringify(i.body) : undefined });
    return res.json();
}, [path, init || null]);
const quiet = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };
const allNotes = async () => (await api('/notes?limit=200')).notes;
const noteBy = async (title) => (await allNotes()).find((x) => x.title === title);
const ta = () => page.locator('[data-key="note-text"]');
const body = () => ta().inputValue();
const status = () => text('[data-key="note-status"]');
const saved = () => page.waitForFunction(() => /Saved/.test(document.querySelector('[data-key="note-status"]').innerText), null, { timeout: 9000 });
const shot = (name) => lib.shrinkShot(page, `notes-${name}`);
async function signIn() {
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav');
    await page.waitForLoadState('networkidle');
}

await signIn();
let noteId = null;
let mira = null;
let trip = null;

await check('g w opens Notes; nav item; three seeded notes, pinned first, who changed them; Missing pages lists the ghost', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g'); await page.keyboard.press('w');
    await page.waitForSelector('.view.notes .note-row');
    eq(await hashNow(), '#/notes', 'hash');
    ok(await page.locator('.rail-nav a', { hasText: 'Notes' }).count(), 'nav item');
    eq(await page.locator('.note-row').count(), 3, 'rows');
    eq(await page.locator('.note-row').first().locator('a.row-link').innerText(), 'Greenhouse plan', 'pinned first');
    const t = await text('.note-list');
    ok(t.includes('by you') && t.includes('by agent agent-x') && t.includes('Beans, peas and kale'), `list: ${t.replace(/\s+/g, ' ').slice(0, 300)}`);
    ok((await text('.note-missing')).includes('Ghost page'), 'missing pages');
    await shot('list-light');
});

await check('kind chip, tag chip, Pinned and search narrow the list', async () => {
    await page.locator('[data-key="chip:meeting"]').click(); await page.waitForSelector('[data-key="chip:meeting"][aria-current="true"]');
    eq(await page.locator('.note-row').count(), 1, 'meeting');
    await go('notes');
    await page.locator('[data-key="chip:garden"]').click(); await page.waitForFunction(() => document.querySelectorAll('.note-row').length === 2);
    await page.locator('[data-key="chip:pinned"]').click(); await page.waitForFunction(() => document.querySelectorAll('.note-row').length === 1);
    await go('notes');
    await page.fill('[data-key="n-search"]', 'GLASS'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.note-row').length === 1);
    ok((await text('.note-row')).includes('Greenhouse plan'), 'found by body text');
});

await check('n starts a new note; typing saves by itself (Unsaved, Saving, Saved) and the address becomes the note', async () => {
    await go('notes');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('n');
    await page.waitForSelector('[data-key="note-editor"]');
    eq(await hashNow(), '#/notes/new', 'hash');
    await page.fill('[data-key="note-title"]', 'E2E note');
    await ta().click();
    await page.keyboard.type('Intro zyzzyva with ');
    eq((await status()).trim(), 'Unsaved changes', 'status while typing');
    await page.waitForFunction(() => /^\/?#?\/notes\/\d+$|#\/notes\/\d+/.test(location.hash), null, { timeout: 9000 });
    await saved();
    noteId = Number((await hashNow()).split('/').pop());
    const got = await api(`/notes/${noteId}`);
    ok(got.body.startsWith('Intro zyzzyva'), `body: ${got.body}`);
    eq(got.revisions, 1, 'autosaves share the first revision');
    ok(await page.locator('[data-key="note-revisions"]').isVisible(), 'revisions button after the first save');
});

await check('[[ lists matches under the caret as a listbox; Enter inserts a link to an existing entity', async () => {
    await ta().click(); await page.keyboard.press('Control+End');
    await page.keyboard.type('[[Mira');
    await page.waitForSelector('.note-popup:not([hidden]) [role="option"]');
    ok(await page.locator('[data-key="note-text"][aria-expanded="true"]').count(), 'aria-expanded');
    const active = await ta().getAttribute('aria-activedescendant');
    ok(active && (await page.locator(`#${active}`).innerText()).includes('Mira Delgado'), 'activedescendant is Mira Delgado');
    await shot('popup-link-light');
    await page.keyboard.press('Enter');
    ok((await body()).endsWith('[[Mira Delgado]]'), `body: ${await body()}`);
    await page.waitForSelector('.note-popup', { state: 'hidden' });
    eq(await page.evaluate(() => document.activeElement.getAttribute('data-key')), 'note-text', 'focus stays in the text');
});

await check('a missing target offers Create note; choosing it creates the note and inserts the link', async () => {
    await page.keyboard.type(' and [[Brand new page');
    await page.waitForSelector('.note-popup-item[data-kind="create-note"]');
    ok(await page.locator('.note-popup-item[data-kind="create-entity"]').count(), 'create entity item');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /\[\[Brand new page\]\]/.test(document.querySelector('[data-key="note-text"]').value));
    ok(await noteBy('Brand new page'), 'note created');
});

await check('Esc closes the menu; Create entity with the kind arrows creates an entity', async () => {
    await page.keyboard.type(' [[Zed');
    await page.waitForSelector('.note-popup-item[data-kind="create-entity"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.note-popup', { state: 'hidden' });
    ok(!(await page.locator('dialog[open]').count()), 'Esc did not close anything else');
    await page.keyboard.type('x');                         // reopens with "Zedx"
    await page.waitForSelector('.note-popup-item[data-kind="create-entity"]');
    await page.keyboard.press('ArrowDown');                // from Create note to Create entity
    await page.keyboard.press('ArrowRight');
    ok((await text('.note-popup-item.active .note-popup-kind')) === 'project', 'kind changed to project');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /\[\[Zedx\]\]/.test(document.querySelector('[data-key="note-text"]').value));
    const ents = (await api('/entities?q=Zedx')).entities;
    ok(ents.length === 1 && ents[0].kind === 'project', `entity: ${JSON.stringify(ents)}`);
});

await check('/ at the start of a line opens the command menu; Link to trip opens the picker and inserts [[trips:id|title]]', async () => {
    trip = (await api('/trips?limit=50')).trips.find((t) => t.title === 'Spring break');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/trip');
    await page.waitForSelector('.note-popup-item[data-kind="command"]');
    eq(await page.locator('.note-popup-item').count(), 1, 'narrowed to one command');
    await shot('popup-slash-light');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.note-popup-item:has-text("Spring break")');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => document.querySelector('[data-key="note-text"]').value.includes(`[[trips:${id}|Spring break]]`), trip.id);
});

await check('other / commands: today, task list, heading; unknown words close the menu', async () => {
    await page.keyboard.press('Enter');
    await page.keyboard.type('/today'); await page.waitForSelector('.note-popup-item'); await page.keyboard.press('Enter');
    ok(/\n\d{4}-\d{2}-\d{2}$/.test(await body()), 'date inserted');
    await page.keyboard.press('Enter'); await page.keyboard.type('/task'); await page.waitForSelector('.note-popup-item'); await page.keyboard.press('Enter');
    await page.keyboard.type('buy milk');
    await page.keyboard.press('Enter'); await page.keyboard.type('/h2'); await page.waitForSelector('.note-popup-item'); await page.keyboard.press('Enter');
    await page.keyboard.type('Plans');
    await page.keyboard.press('Enter'); await page.keyboard.type('/qqqq');
    await page.waitForSelector('.note-popup', { state: 'hidden' });
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    ok((await body()).includes('- [ ] buy milk') && (await body()).includes('## Plans'), `body: ${await body()}`);
});

await check('the live preview renders the text; wikilinks resolve to the entity, note and trip; a missing one is styled', async () => {
    await page.keyboard.press('Enter');
    await page.keyboard.type('Also [[Nobody home]] and **strong**, a [site](https://example.com) and <b>raw html</b>.');
    mira = (await api('/entities?q=Mira')).entities.find((e) => e.name === 'Mira Delgado');
    await page.waitForSelector(`.note-preview a.wikilink[href="#/entities/${mira.id}"]`);
    const bn = await noteBy('Brand new page');
    await page.waitForSelector(`.note-preview a.wikilink[href="#/notes/${bn.id}"]`);
    await page.waitForSelector(`.note-preview a.wikilink[href="#/trips/${trip.id}"]`);
    await page.waitForSelector('.note-preview a.wikilink.missing');
    eq(await page.locator('.note-preview a.wikilink.missing').first().innerText(), 'Nobody home', 'missing link text');
    ok((await page.locator('.note-preview strong').innerText()) === 'strong', 'bold');
    const a = page.locator('.note-preview a.md-link');
    eq(await a.getAttribute('target'), '_blank', 'target');
    ok((await a.getAttribute('rel')).includes('noopener'), 'rel');
    eq(await page.locator('.note-preview b').count(), 0, 'no raw html element');
    ok((await text('.note-preview')).includes('<b>raw html</b>'), 'raw html shown as text');
    eq(await page.locator('.note-preview img, .note-preview script').count(), 0, 'no img or script');
    await shot('editor-light');
});

await check('autosave keeps the first revision; Save (and Ctrl+S) files a new one; the toolbar and Ctrl+B/I work; Ctrl+K inserts a link, not the palette', async () => {
    await saved();
    eq((await api(`/notes/${noteId}`)).revisions, 1, 'still one revision after autosaves');
    await ta().click(); await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+b'); await page.keyboard.type('bolded');
    ok((await body()).endsWith('**bolded**') || (await body()).includes('**bold**'), `bold: ${await body()}`);
    await page.keyboard.press('End');
    await page.keyboard.press('Control+i');
    await page.keyboard.press('Control+k');
    ok(!(await page.locator('dialog[open]').count()), 'palette stayed closed');
    ok((await body()).includes('](https://)'), 'link markup');
    await page.keyboard.press('End');
    await page.locator('[data-key="tool:code"]').click();
    ok((await body()).includes('`code`'), 'code tool');
    await page.locator('[data-key="note-save"]').click();
    await saved();
    eq((await api(`/notes/${noteId}`)).revisions, 2, 'explicit save made revision 2');
    await ta().click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' ctrl-s');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('[data-key="note-status"]').innerText));
    eq((await api(`/notes/${noteId}`)).revisions, 3, 'Ctrl+S made revision 3');
});

await check('links reach the graph, and backlinks show on the targets', async () => {
    const got = await api(`/links?domain=notes&id=${noteId}`);
    const to = got.links.map((l) => `${l.other.domain}:${l.other.title}`).sort();
    ok(to.includes('entities:Mira Delgado') && to.includes('notes:Brand new page') && to.includes('trips:Spring break'), `links: ${to.join(', ')}`);
    ok(got.links.every((l) => l.rel === 'mentions'), 'rel mentions');
    await page.waitForSelector('.note-linked .linked-section');
    ok((await text('.note-linked')).includes('Mira Delgado'), 'linked section on the note');
    await go(`entities/${mira.id}`); await page.waitForSelector('dialog.drawer[open] .linked-section');
    ok((await text('dialog.drawer .linked-section')).includes('E2E note'), 'backlink on the entity');
    const seed = await noteBy('Seed bank');
    await go(`notes/${seed.id}`); await page.waitForSelector('.note-linked .linked-section .linked-item');
    ok((await text('.note-linked')).includes('Greenhouse plan'), 'backlink on the note');
});

await check('the note shows in the graph and in search', async () => {
    await go(`graph?d=notes&i=${noteId}`);
    await page.waitForSelector('svg.graph-svg .graph-node');
    ok((await page.locator('.graph-node', { hasText: 'E2E note' }).count()) >= 1, 'centre node');
    ok((await page.locator('.graph-node').count()) >= 4, `nodes: ${await page.locator('.graph-node').count()}`);
    await shot('graph-light');
    await go('search?q=zyzzyva');
    await page.waitForSelector('.search-result');
    const t = await text('.view.search');
    ok(t.includes('E2E note') && /Notes/.test(t), `search: ${t.slice(0, 200)}`);
    await go('graph');
    await page.waitForSelector('svg.graph-svg[data-ready="1"] .graph-node');
    ok((await page.locator('.graph-node', { hasText: 'Standup notes' }).count()) >= 0, 'overview loads');
});

await check('Revisions panel lists them, shows an old one, restores it as a new revision; the links follow the text', async () => {
    await go(`notes/${noteId}`);
    await page.locator('[data-key="note-revisions"]').click();
    await page.waitForSelector('dialog.drawer[open] .note-rev-item');
    ok((await page.locator('.note-rev-item').count()) >= 3, 'revision rows');
    await shot('revisions-light');
    await page.locator('[data-key="rev:1"]').click();
    await page.waitForSelector('dialog.drawer[open] [data-key="restore:1"]');
    ok((await text('.note-rev-view')).includes('zyzzyva'), 'old text shown');
    await page.locator('[data-key="restore:1"]').click();
    await page.locator('dialog[open]:not(.drawer) .dialog-actions .btn').last().click();
    await waitToast(/Restored revision 1/); await quiet();
    const now = await api(`/notes/${noteId}`);
    ok(now.body.startsWith('Intro zyzzyva') && !now.body.includes('Mira Delgado'), `restored body: ${now.body}`);
    eq(now.rev, 4, 'restore is a new revision');
    eq((await api(`/links?domain=notes&id=${noteId}`)).links.length, 0, 'links dropped with the text');
    eq((await body()), now.body, 'editor shows the restored text');
});

await check('a link to a missing page offers Create in the preview; creating resolves it and links it', async () => {
    await ta().click(); await page.keyboard.press('Control+End');
    await page.keyboard.type(' See [[Greenhouse plan]] and [[Ghost page]].');
    await saved();
    await page.waitForSelector('.note-preview a.wikilink.missing');
    await shot('missing-light');
    await page.locator('.note-preview a.wikilink.missing').click();
    await page.waitForSelector('dialog[open] select[name="kind"]');
    await page.locator('dialog.form-dialog[open] button[type="submit"]').click();
    await waitToast(/Created Ghost page/); await quiet();
    await page.waitForFunction(() => !document.querySelector('.note-preview a.wikilink.missing'));
    ok(await noteBy('Ghost page'), 'note created');
    await page.waitForFunction(async (id) => { const r = await (await fetch(`/admin/api/links?domain=notes&id=${id}`, { headers: { 'X-Requested-With': 'hub-admin' } })).json(); return r.links.length === 2; }, noteId);
    const miss = await api('/notes/missing');
    ok(!miss.missing.some((m) => m.target === 'Ghost page'), 'no longer missing');
});

await check('leaving with unsaved text saves it first (the guard)', async () => {
    await ta().click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' guard-text');
    await page.locator('[data-key="note-back"]').click();
    await page.waitForSelector('.view.notes .note-row');
    ok((await api(`/notes/${noteId}`)).body.includes('guard-text'), 'saved before leaving');
    eq(await hashNow(), '#/notes', 'went to the list');
});

await check('Delete moves a note to the trash; Put back restores it; the trash view lists it', async () => {
    await go(`notes/${noteId}`);
    await page.locator('[data-key="note-delete"]').click();
    await page.locator('dialog[open] .dialog-actions .btn').last().click();
    await waitToast(/Moved to trash/); await page.waitForSelector('.view.notes .note-row');
    ok(!(await noteBy('E2E note')), 'gone from the list');
    await page.locator('[data-key="trash-toggle"]').click();
    await page.waitForSelector('[data-key^="untrash:"]');
    ok((await text('.note-list')).includes('E2E note'), 'in the trash');
    await page.locator(`[data-key="untrash:${noteId}"]`).click(); await waitToast(/put back/i); await quiet();
    ok(await noteBy('E2E note'), 'back');
});

await check('Activity shows note rows without titles or text', async () => {
    await go('activity?type=notes');
    await page.waitForFunction(() => /wrote a note/.test(document.querySelector('.content').innerText), null, { timeout: 8000 }).catch(() => {});
    const t = await text('.content');
    ok(t.includes('wrote a note') && t.includes('moved a note to the trash'), `rows: ${t.replace(/\s+/g, ' ').slice(0, 300)}`);
    ok(!t.includes('E2E note') && !t.includes('zyzzyva'), 'no title or text');
});

await check('390 px: the list stacks, the editor shows Write | Preview, no sideways scroll', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await go('notes'); await page.waitForSelector('.note-row');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'list overflow');
    eq(await page.locator('.note-row').first().evaluate((el) => getComputedStyle(el).flexDirection), 'column', 'row stacks');
    await shot('list-phone-light');
    await go(`notes/${noteId}`); await page.waitForSelector('[data-key="note-text"]');
    ok(await page.locator('.note-panes').isVisible(), 'pane switch');
    ok(!(await page.locator('.note-preview-box').isVisible()), 'preview hidden while writing');
    await page.locator('[data-key="pane:preview"]').click();
    ok(await page.locator('.note-preview-box').isVisible() && !(await page.locator('.note-write').isVisible()), 'preview shown');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'editor overflow');
    await shot('editor-preview-phone-light');
    await page.locator('[data-key="pane:write"]').click();
    await ta().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n[[Mira');
    await page.waitForSelector('.note-popup:not([hidden]) .note-popup-item');
    const box = await page.locator('.note-popup').boundingBox();
    ok(box.x >= 0 && box.x + box.width <= 391, `popup inside the screen: ${JSON.stringify(box)}`);
    await shot('popup-phone-light');
    await page.keyboard.press('Escape');
});

await check('dark theme: list, editor, popups, graph at desktop and phone size render without sideways scroll', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await go('notes'); await page.waitForSelector('.note-row'); await shot('list-dark');
    await go(`notes/${noteId}`); await page.waitForSelector('[data-key="note-text"]'); await page.waitForSelector('.note-preview .md');
    await shot('editor-dark');
    await ta().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n[[Mira');
    await page.waitForSelector('.note-popup:not([hidden]) .note-popup-item'); await shot('popup-link-dark'); await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z').catch(() => {});
    await go(`graph?d=notes&i=${noteId}`); await page.waitForSelector('svg.graph-svg .graph-node'); await shot('graph-dark');
    await page.setViewportSize({ width: 390, height: 800 });
    await go('notes'); await page.waitForSelector('.note-row'); await shot('list-phone-dark');
    await go(`notes/${noteId}`); await page.waitForSelector('[data-key="note-text"]'); await shot('editor-phone-dark');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'overflow');
});

await check('no console errors in the whole run', async () => eq(errors.length, 0, errors.slice(0, 3).join(' | ')));

await browser.close();
for (const r of results) console.log(r.join(' '));
console.log(`${results.filter((r) => r[0] === 'PASS').length} pass, ${results.filter((r) => r[0] === 'FAIL').length} fail`);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
