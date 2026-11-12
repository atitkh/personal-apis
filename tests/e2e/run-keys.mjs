// Key scope editing: browser checks against a SCRATCH hub (empty seed).
//   sh reset.sh empty && node run-keys.mjs
// Secrets are kept in variables and only ever sent to the scratch hub; they are never printed.
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/voltex/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core');
const ORIGIN = process.env.ORIGIN || 'http://localhost:3999';
const BASE = `${ORIGIN}/admin/`;
const KEY = process.env.KEY || 'e'.repeat(40);
const SHOTS = '/home/voltex/.openclaw/workspace/tmp/hub-flights-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const errors = [];
let n = 0;
const check = async (name, fn) => {
    n += 1;
    try { if ((await fn()) === false) throw new Error('returned false'); results.push(['PASS', n, name]); }
    catch (e) { results.push(['FAIL', n, `${name} :: ${String(e.message).split('\n')[0].slice(0, 220)}`]); }
    console.log(results[results.length - 1].join(' '));
};
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what || 'not true'); };

// The status code a key gets from the scratch hub, with curl. Nothing but the code is returned.
const status = (secret, path) => {
    try {
        return Number(execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Authorization: Bearer ${secret}`, `${ORIGIN}${path}`], { encoding: 'utf8' }));
    } catch (e) { throw new Error('curl failed'); }
};

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });

async function open(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ...opts });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.goto(BASE);
    await page.waitForSelector('input');
    await page.fill('input', KEY);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForSelector('.rail-nav', { state: 'attached' });
    return { ctx, page };
}
const go = async (page, hash) => { await page.goto(`${BASE}#/${hash}`); await page.waitForLoadState('networkidle'); };
const adminApi = (page, path, method = 'GET', body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(`/admin/api${p}`, { method: m, headers: { 'X-Requested-With': 'hub-admin', ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
}, [path, method, body]);
const drawer = (page) => page.locator('dialog.drawer[open]');
const diffText = (page) => drawer(page).locator('.diff-line').innerText();
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('.toasts > *').forEach((t) => t.remove()));
const saved = (page, name) => page.waitForFunction((nm) => new RegExp(`Saved ${nm}`).test([...document.querySelectorAll('.toasts')].map((t) => t.textContent).join(' ')), name);
const shot = async (page, file) => {
    const p = `${SHOTS}/${file}`;
    await page.screenshot({ path: p, type: 'jpeg', quality: 70 });
    return fs.statSync(p).size;
};
const keyByName = async (page, name) => (await adminApi(page, '/keys')).body.keys.find((k) => k.name === name && !k.revoked_at);

let { ctx, page } = await open();
let secret = '';
let id = 0;

// ---- create through the UI, then use the secret ----
await check('create a key (places:read) in the UI and copy its secret', async () => {
    await go(page, 'keys?new=1');
    await drawer(page).locator('#k-name').fill('e2e-agent');
    await drawer(page).locator('#sc-places-read').check();
    await drawer(page).getByRole('button', { name: 'Create key' }).click();
    await drawer(page).locator('input.secret').waitFor();
    secret = await drawer(page).locator('input.secret').inputValue();
    ok(secret.startsWith('pak_'), 'secret shape');
    await drawer(page).getByRole('button', { name: 'Copy key' }).click();
    await drawer(page).getByRole('button', { name: 'Done' }).click();
    id = (await keyByName(page, 'e2e-agent')).id;
});
await check('curl: places 200, digests 403 before any edit', async () => {
    eq(status(secret, '/hub/places'), 200, 'places');
    eq(status(secret, '/hub/digests/recent'), 403, 'digests');
});

// ---- Keys drawer ----
await check('drawer shows an Access section with checkboxes grouped by domain, the secret never shown', async () => {
    await go(page, `keys/${id}`);
    await drawer(page).locator('.access-form').waitFor();
    eq(await drawer(page).locator('#ke-places-read').isChecked(), true, 'places:read');
    eq(await drawer(page).locator('#ke-flights-observe').isChecked(), false, 'flights:observe');
    ok(await drawer(page).locator('legend', { hasText: 'Flights' }).count() === 1, 'Flights group');
    ok(await drawer(page).getByText("Changes apply on the key's next call").count() === 1, 'copy');
    ok(!(await drawer(page).innerText()).includes(secret), 'secret in drawer');
    eq(await drawer(page).getByRole('button', { name: 'Save changes' }).isDisabled(), true, 'Save disabled when clean');
});
await check('edit: diff sentence appears (Adds / Removes) and Save enables', async () => {
    await drawer(page).locator('#ke-flights-observe').check();
    await drawer(page).locator('#ke-digests-read').check();
    await drawer(page).locator('#ke-places-read').uncheck();
    const t = await diffText(page);
    ok(/Adds flights:observe, digests:read\./.test(t), `adds: ${t}`);
    ok(/Removes places:read\./.test(t), `removes: ${t}`);
    eq(await drawer(page).getByRole('button', { name: 'Save changes' }).isEnabled(), true, 'Save enabled');
    await shot(page, 'keys-drawer-diff.jpg');
});
await check('Cancel restores the saved state', async () => {
    await drawer(page).getByRole('button', { name: 'Cancel' }).click();
    eq(await drawer(page).locator('#ke-places-read').isChecked(), true, 'places:read back');
    eq(await drawer(page).locator('#ke-digests-read').isChecked(), false, 'digests:read off');
    ok(/No changes yet/.test(await diffText(page)), 'clean line');
});
await check('closing a dirty drawer asks first; Keep editing keeps it open', async () => {
    await drawer(page).locator('#ke-digests-read').check();
    await page.keyboard.press('Escape');
    await page.locator('dialog.dialog[open]').waitFor();
    ok(await page.locator('dialog.dialog[open]').innerText().then((t) => /Discard your changes/.test(t)), 'dialog text');
    await page.locator('dialog.dialog[open]').getByRole('button', { name: 'Keep editing' }).click();
    ok(await drawer(page).count() === 1, 'drawer still open');
    await drawer(page).getByRole('button', { name: 'Cancel' }).click();
});
await check('save a scope change: toast, curl flips 200 -> 403 with the same secret', async () => {
    await drawer(page).locator('#ke-digests-read').check();
    await drawer(page).locator('#ke-flights-observe').check();
    await drawer(page).locator('#ke-places-read').uncheck();
    await clearToasts(page);
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await saved(page, 'e2e-agent');
    eq(status(secret, '/hub/places'), 403, 'places after');
    eq(status(secret, '/hub/digests/recent'), 200, 'digests after');
    eq(await drawer(page).locator('#ke-digests-read').isChecked(), true, 'rebuilt drawer shows saved state');
});
await check('reload: the new scopes persisted', async () => {
    await page.reload();
    await page.waitForLoadState('networkidle');
    await drawer(page).locator('.access-form').waitFor();
    eq(await drawer(page).locator('#ke-digests-read').isChecked(), true, 'digests:read');
    eq(await drawer(page).locator('#ke-flights-observe').isChecked(), true, 'flights:observe');
    eq(await drawer(page).locator('#ke-places-read').isChecked(), false, 'places:read');
    const k = await keyByName(page, 'e2e-agent');
    eq(JSON.stringify(k.scopes.sort()), JSON.stringify(['digests:read', 'flights:observe']), 'api scopes');
});
await check('emptying every scope is refused in the UI', async () => {
    await drawer(page).locator('#ke-digests-read').uncheck();
    await drawer(page).locator('#ke-flights-observe').uncheck();
    ok(/at least one/i.test(await diffText(page)), 'message');
    eq(await drawer(page).getByRole('button', { name: 'Save changes' }).isDisabled(), true, 'Save disabled');
    await drawer(page).getByRole('button', { name: 'Cancel' }).click();
});
await check('rename: diff says Renames it to, saves, title and table update, secret still works', async () => {
    await drawer(page).locator('#ke-name').fill('e2e-renamed');
    ok(/Renames it to e2e-renamed/.test(await diffText(page)), 'diff');
    await clearToasts(page);
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await saved(page, 'e2e-renamed');
    await page.waitForFunction(() => document.querySelector('dialog.drawer[open] h2')?.textContent === 'e2e-renamed', null, { timeout: 4000 }).catch(() => { throw new Error('drawer title did not update'); });
    await page.waitForFunction(() => document.querySelector('.keys-table')?.innerText.includes('e2e-renamed'), null, { timeout: 4000 }).catch(() => { throw new Error('table behind the drawer did not update'); });
    eq(status(secret, '/hub/digests/recent'), 200, 'same secret');
});
await check('renaming to a name already in use shows the error and changes nothing', async () => {
    const r = await adminApi(page, '/keys', 'POST', { name: 'e2e-taken', scopes: ['digests:read'] });
    eq(r.status, 201, 'seed second key');
    await drawer(page).locator('#ke-name').fill('e2e-taken');
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await drawer(page).locator('.save-bar .error').filter({ hasText: 'already active' }).waitFor();
    eq((await keyByName(page, 'e2e-renamed')).id, id, 'still the old name');
    await drawer(page).getByRole('button', { name: 'Cancel' }).click();
});
await check("'All access (*)': others disable, Save asks, backing out changes nothing, confirming saves it", async () => {
    await drawer(page).locator('#ke-star').check();
    eq(await drawer(page).locator('#ke-digests-read').isDisabled(), true, 'others disabled');
    ok(/Adds \*\./.test(await diffText(page)), 'diff');
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    const dlg = page.locator('dialog.dialog[open]');
    await dlg.waitFor();
    ok(/every domain and every action/.test(await dlg.innerText()), 'warning text');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    ok(!(await keyByName(page, 'e2e-renamed')).scopes.includes('*'), 'unchanged after back out');
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await dlg.waitFor();
    await clearToasts(page);
    await dlg.getByRole('button', { name: 'Give all access' }).click();
    await saved(page, 'e2e-renamed');
    eq(JSON.stringify((await keyByName(page, 'e2e-renamed')).scopes), '["*"]', 'scopes');
    eq(status(secret, '/hub/places'), 200, 'places with *');
});
await check('unticking All access leaves nothing picked; narrowing needs no confirmation', async () => {
    await drawer(page).locator('#ke-star').uncheck();
    eq(await drawer(page).locator('#ke-digests-read').isChecked(), false, 'nothing stashed for a key that began with *');
    await drawer(page).locator('#ke-places-read').check();
    await clearToasts(page);
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await saved(page, 'e2e-renamed');
    eq(JSON.stringify((await keyByName(page, 'e2e-renamed')).scopes), '["places:read"]', 'narrowed');
    eq(status(secret, '/hub/digests/recent'), 403, 'digests refused again');
    ok(await page.locator('dialog.dialog[open]').count() === 0, 'no confirm dialog');
});
await check('a scope that is not in the list is shown and kept', async () => {
    const r = await adminApi(page, '/keys', 'POST', { name: 'e2e-legacy', scopes: ['notes:*', 'attendance:read'] });
    eq(r.status, 201, 'seed legacy key');
    await page.keyboard.press('Escape');
    await drawer(page).waitFor({ state: 'detached' });
    await page.reload(); // the key was created through the API, so the open page does not know it yet
    await page.waitForLoadState('networkidle');
    await go(page, `keys/${r.body.id}`);
    await page.waitForFunction(() => document.querySelector('dialog.drawer[open] h2')?.textContent === 'e2e-legacy');
    await drawer(page).locator('.access-form').waitFor();
    if (!(await drawer(page).locator('#ke-notes-all').count())) {
        throw new Error(`no extra checkbox; title=${await drawer(page).locator('h2').first().innerText().catch(() => 'none')} url=${page.url().split('#')[1]} legends=${(await drawer(page).locator('legend').allInnerTexts()).join('|')}`);
    }
    eq(await drawer(page).locator('#ke-notes-all').isChecked(), true, 'extra checkbox');
    await drawer(page).locator('#ke-digests-read').check();
    await clearToasts(page);
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await saved(page, 'e2e-legacy');
    eq(JSON.stringify((await keyByName(page, 'e2e-legacy')).scopes.sort()), JSON.stringify(['attendance:read', 'digests:read', 'notes:*']), 'kept');
});

// ---- Agent access ----
await check('Agent access: a cell is a button; it opens a drawer with the domain mode as context and focus inside', async () => {
    await page.keyboard.press('Escape');
    await drawer(page).waitFor({ state: 'detached' });
    await go(page, 'agents');
    const cell = page.locator(`[data-cell="${id}:places"]`);
    await cell.waitFor();
    ok(/Change access/.test(await cell.getAttribute('aria-label')), 'aria-label');
    eq(await cell.evaluate((el) => el.tagName), 'BUTTON', 'tag');
    await cell.focus();
    await page.keyboard.press('Enter');
    await drawer(page).waitFor();
    ok(/Domain mode: Read: write actions stay hidden until you switch the domain to Read and write on the Overview board/.test(await drawer(page).innerText()), 'mode text');
    ok(await drawer(page).evaluate((d) => d.contains(document.activeElement)), 'focus inside');
    eq(await drawer(page).locator('legend').count(), 1, 'only one domain');
    ok(await drawer(page).locator(`#ac-${id}-places-read`).isChecked(), 'places:read checked');
    await shot(page, 'agents-cell-drawer.jpg');
});
await check('focus stays trapped on Tab; Esc closes and returns focus to the cell', async () => {
    for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press('Tab');
        // a modal dialog makes the page inert: focus is in the drawer, or has left the page for the browser's own controls (body)
        ok(await drawer(page).evaluate((d) => d.contains(document.activeElement) || document.activeElement === document.body), `focus escaped on Tab ${i + 1}`);
    }
    await page.keyboard.press('Escape');
    await drawer(page).waitFor({ state: 'detached' });
    eq(await page.evaluate(() => document.activeElement?.getAttribute('data-cell')), `${id}:places`, 'focus returned');
});
await check('cell edit changes only that domain: untick places:read -> 403; tick -> 200; other scopes untouched', async () => {
    const before = (await keyByName(page, 'e2e-renamed')).scopes;
    await adminApi(page, `/keys/${id}`, 'PATCH', { scopes: [...before, 'digests:read'] });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`[data-cell="${id}:places"]`).click();
    await drawer(page).locator(`#ac-${id}-places-read`).uncheck();
    ok(/Removes places:read\./.test(await diffText(page)), 'diff');
    await clearToasts(page);
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await saved(page, 'e2e-renamed');
    await drawer(page).waitFor({ state: 'detached' });
    eq(status(secret, '/hub/places'), 403, 'places off');
    eq(status(secret, '/hub/digests/recent'), 200, 'digests untouched');
    await page.locator(`[data-cell="${id}:places"]`).click();
    await drawer(page).locator(`#ac-${id}-places-read`).check();
    await drawer(page).getByRole('button', { name: 'Save changes' }).click();
    await drawer(page).waitFor({ state: 'detached' });
    eq(status(secret, '/hub/places'), 200, 'places back');
    eq(JSON.stringify((await keyByName(page, 'e2e-renamed')).scopes.sort()), JSON.stringify(['digests:read', 'places:read']), 'scopes');
});
await check('a key with * shows no checkboxes in the cell, only a pointer to the Keys page', async () => {
    const r = await adminApi(page, '/keys', 'POST', { name: 'e2e-star', scopes: ['*'] });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator(`[data-cell="${r.body.id}:places"]`).click();
    eq(await drawer(page).locator('input[type=checkbox]').count(), 0, 'checkboxes');
    ok(/all access/i.test(await drawer(page).innerText()), 'text');
    await page.keyboard.press('Escape');
});
await check('New key shortcut opens the Keys create drawer', async () => {
    await page.locator('[data-key="new-key-shortcut"]').click();
    await drawer(page).waitFor();
    ok(/keys\?new=1/.test(page.url()), 'url');
    eq(await drawer(page).locator('h2').first().innerText(), 'Create key', 'title');
    await page.keyboard.press('Escape');
});

// ---- revoked ----
await check('a revoked key shows no edit controls and PATCH answers 409', async () => {
    const legacy = await keyByName(page, 'e2e-legacy');
    eq((await adminApi(page, `/keys/${legacy.id}`, 'DELETE')).status, 200, 'revoke');
    await go(page, `keys/${legacy.id}`);
    await drawer(page).waitFor();
    eq(await drawer(page).locator('.access-form, input[type=checkbox]').count(), 0, 'edit controls');
    ok(/cannot be edited/.test(await drawer(page).innerText()), 'note');
    eq((await adminApi(page, `/keys/${legacy.id}`, 'PATCH', { name: 'x' })).status, 409, 'PATCH');
    await page.keyboard.press('Escape');
});

// ---- activity ----
await check('Activity shows the key_updated sentence', async () => {
    await go(page, 'activity?type=keys');
    await page.waitForSelector('.view');
    await page.waitForFunction(() => /updated key/.test(document.querySelector('.view')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
    const t = await page.locator('.view').innerText();
    ok(/updated key/.test(t) && /added/.test(t), 'sentence');
    ok(/renamed from e2e-agent/.test(t), 'rename sentence');
    ok(/removed/.test(t), 'removed part');
    ok(!t.includes(secret), 'no secret');
});
await check('dark mode: drawer renders without horizontal overflow', async () => {
    await page.evaluate(() => localStorage.setItem('hub-theme', 'dark'));
    await page.reload();
    await page.waitForLoadState('networkidle');
    eq(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', 'theme');
    await go(page, `keys/${id}`);
    await drawer(page).locator('.access-form').waitFor();
    await drawer(page).locator('#ke-flights-observe').check();
    ok(await drawer(page).evaluate((d) => d.scrollWidth <= d.clientWidth + 1), 'drawer overflow');
    await drawer(page).getByRole('button', { name: 'Cancel' }).click();
    await page.keyboard.press('Escape');
});
await ctx.close();

// ---- 390 px, dark ----
({ ctx, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 }));
await check('390 px dark: Agent access cells stack, the cell drawer fits', async () => {
    await page.evaluate(() => localStorage.setItem('hub-theme', 'dark'));
    await go(page, 'agents');
    await page.reload();
    await page.waitForLoadState('networkidle');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'page overflow');
    const cell = page.locator(`[data-cell="${id}:places"]`);
    await cell.scrollIntoViewIfNeeded();
    const box = await cell.boundingBox();
    ok(box && box.height >= 44 && box.width > 150, `cell size ${JSON.stringify(box)}`);
    await shot(page, 'agents-390-dark.jpg');
    await cell.click();
    await drawer(page).waitFor();
    ok(await drawer(page).evaluate((d) => d.scrollWidth <= d.clientWidth + 1), 'drawer overflow');
    ok(await drawer(page).evaluate((d) => d.getBoundingClientRect().width <= 390), 'drawer width');
    await page.keyboard.press('Escape');
});
await check('390 px dark: Keys drawer shows Save in reach and the diff', async () => {
    await go(page, `keys/${id}`);
    await drawer(page).locator('.access-form').waitFor();
    await drawer(page).locator('#ke-flights-observe').check();
    const save = drawer(page).getByRole('button', { name: 'Save changes' });
    await save.scrollIntoViewIfNeeded();
    ok(await save.isVisible(), 'Save visible');
    ok(/Adds flights:observe/.test(await diffText(page)), 'diff');
    await shot(page, 'keys-390-dark.jpg');
    await drawer(page).getByRole('button', { name: 'Cancel' }).click();
    await page.keyboard.press('Escape');
});
await check('old scope names are accepted and stored as the new ones; the editor shows the plain-words labels', async () => {
    const r = await adminApi(page, '/keys', 'POST', { name: 'e2e-oldnames', scopes: ['flights:read', 'flights:edit', 'deadlines:write'] });
    eq(r.status, 201, 'create with old names');
    eq(JSON.stringify(r.body.scopes), '["flights:read","flights:agent-write","deadlines:api-write"]', 'stored as new names');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await go(page, `keys/${r.body.id}`);
    await page.waitForFunction(() => document.querySelector('dialog.drawer[open] h2')?.textContent === 'e2e-oldnames');
    await drawer(page).locator('.access-form').waitFor();
    eq(await drawer(page).locator('#ke-flights-agent-write').isChecked(), true, 'flights:agent-write');
    eq(await drawer(page).locator('#ke-deadlines-api-write').isChecked(), true, 'deadlines:api-write');
    eq(await drawer(page).locator('#ke-flights-api-write').isChecked(), false, 'flights:api-write stays off');
    const t = await drawer(page).innerText();
    ok(/Agent write/.test(t) && /API write/.test(t), 'labels');
    ok(/Write through the agent tool \(the domain must also be switched to Read and write on the Overview board\)/.test(t), 'agent sentence');
    ok(/Write through the API \(jobs and scripts\)/.test(t), 'api sentence');
    ok(!/flights:edit|deadlines:write/.test(t), 'no old names shown');
    await drawer(page).locator('#ke-flights-agent-write').scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 900, height: 900 });
    await shot(page, 'keys-new-scope-labels.jpg');
});
await check('Agent access names the verbs Agent write / API write, not Edit / Write', async () => {
    await page.keyboard.press('Escape');
    await drawer(page).waitFor({ state: 'detached' });
    const k = await keyByName(page, 'e2e-oldnames');
    await go(page, 'agents');
    const cell = page.locator(`[data-cell="${k.id}:flights"]`);
    await cell.waitFor();
    const text = await cell.innerText();
    ok(/Agent write/.test(text), `cell text: ${text}`);
    ok(!/\bEdit\b/.test(text), 'no Edit verb');
});
await check('no console or page errors during the whole run', async () => { eq(errors.length, 0, errors.slice(0, 3).join(' | ')); });
await browser.close();

const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
