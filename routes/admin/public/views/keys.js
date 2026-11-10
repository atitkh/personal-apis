// API keys. #/keys is the table; #/keys/12 opens that key's drawer (scopes explained, recent agent calls,
// revoke); #/keys?new=1 opens the create drawer (scope picker, the secret shown once with a copy button).
// The URL is the truth: closing a drawer goes back to #/keys.
import {
    h, icon, button, plural, when, ago, dot, emptyState, toast, confirmDialog, openDrawer, copyButton, fact, hidden,
} from '../ui.js';
import { href, navigate, parse } from '../router.js';
import { CATALOGUE, explain, scopeChip, scopeHue } from '../scopes.js';

let drawer = null;      // { kind: 'key' | 'new', id, handle, fromList }
let lastWasList = false; // the previous render was the plain table (so closing a drawer can go back)

const callName = (c) => `${c.tool || 'unknown'}${c.action ? `.${c.action}` : ''}`;

function closeDrawerTo(fromList) {
    if (fromList && history.length > 1) history.back();
    else navigate(href('keys'), { replace: true });
}

/* ---------- key drawer ---------- */

function keyDrawer(ctx, k, use) {
    const revoked = Boolean(k.revoked_at);
    const calls = h('div', { class: 'calls' }, h('p', { class: 'muted', text: 'Loading recent calls…' }));

    const reach = !use || revoked ? null : use.visibleTools.length
        ? h('ul', { class: 'reach' }, use.visibleTools.map((t) => {
            const e = explain(`${t.tool}:read`);
            return h('li', {}, h('span', { class: `swatch hue-${scopeHue(t.tool)}`, 'aria-hidden': 'true' }),
                h('span', {}, h('strong', { text: e.title }), `: ${t.actions.join(', ')}`));
        }))
        : h('p', { class: 'muted', text: 'Nothing right now. Its scopes, a domain switched off, or agent access set to Off hide every tool.' });

    const revoke = revoked ? null : button({
        text: 'Revoke key',
        variant: 'danger',
        iconName: 'close',
        onClick: async () => {
            const ok = await confirmDialog({
                title: `Revoke ${k.name}?`,
                body: ['Anything using this key loses access at once.', 'This cannot be undone. To give access again, create a new key.'],
                confirm: 'Revoke key',
                danger: true,
            });
            if (!ok) return;
            try {
                await ctx.api(`/keys/${k.id}`, { method: 'DELETE' });
                toast(`Key ${k.name} revoked`);
                const d = drawer;
                drawer = null;
                if (d) d.handle.close(true);
                closeDrawerTo(d && d.fromList);
            } catch (err) {
                toast(`Could not revoke the key. ${err.message}`, { kind: 'bad' });
            }
        },
    });

    const content = [
        h('section', { class: 'drawer-section' },
            h('dl', { class: 'facts' },
                fact('Status', revoked ? [dot('bad'), `Revoked ${when(k.revoked_at)}`] : [dot('good'), 'Active']),
                fact('Created', when(k.created_at)),
                fact('Key starts with', h('code', { text: `${k.key_prefix}…` })),
                fact('Last used', k.last_used_at ? `${ago(k.last_used_at)} (${when(k.last_used_at)})` : 'Never'),
                fact('Agent calls', use ? `${use.calls30d.toLocaleString()} in 30 days${use.lastCallAt ? `, last ${ago(use.lastCallAt)}` : ''}` : 'None'))),
        h('section', { class: 'drawer-section', 'aria-labelledby': 'kd-scopes' },
            h('h3', { id: 'kd-scopes', text: 'What it may do' }),
            h('ul', { class: 'scope-list' }, k.scopes.map((s) => {
                const e = explain(s);
                return h('li', {}, h('div', { class: 'scope-line' }, scopeChip(s), h('code', { class: 'scope-code', text: s })), h('p', { class: 'scope-text', text: e.text }));
            }))),
        reach ? h('section', { class: 'drawer-section', 'aria-labelledby': 'kd-reach' },
            h('h3', { id: 'kd-reach', text: 'Through the agent endpoint, right now' }),
            use.canWrite ? h('p', { class: 'warn-line' }, icon('warn'), 'Can change data') : null,
            reach,
            h('p', { class: 'note' }, 'Domain switches and agent access are set on the ', h('a', { class: 'link', href: href('overview'), text: 'overview' }), '.')) : null,
        h('section', { class: 'drawer-section', 'aria-labelledby': 'kd-calls' },
            h('h3', { id: 'kd-calls', text: 'Recent agent calls' }),
            calls),
        revoke ? h('section', { class: 'drawer-section danger-zone' },
            h('p', { class: 'note', text: 'Revoking ends access for whatever uses this key.' }), revoke) : null,
    ];

    ctx.api(`/keys/${k.id}/calls?limit=15`).then(({ calls: list }) => {
        calls.replaceChildren(list.length
            ? h('ol', { class: 'call-list' }, list.map((c) => h('li', {},
                h('time', { datetime: c.at, text: when(c.at) }),
                h('code', { text: callName(c) }),
                h('span', { class: `call-result ${c.ok ? 'ok' : 'failed'}` }, icon(c.ok ? 'good' : 'bad'), c.ok ? 'OK' : 'Failed'))))
            : h('p', { class: 'muted', text: 'No agent calls from this key yet. Calls to the /hub REST routes only update "Last used".' }));
    }).catch((err) => calls.replaceChildren(h('p', { class: 'error', text: `Could not load the calls. ${err.message}` })));

    return content;
}

/* ---------- create drawer ---------- */

function createForm(ctx, onCreated) {
    const name = h('input', { type: 'text', id: 'k-name', name: 'name', autocomplete: 'off', spellcheck: 'false', required: true, 'aria-describedby': 'k-name-help' });
    const error = h('p', { class: 'error', role: 'alert' });
    const submit = button({ text: 'Create key', type: 'submit' });
    const boxes = [];

    const groups = CATALOGUE.map((d) => {
        const all = h('input', { type: 'checkbox', value: `${d.domain}:*`, id: `sc-${d.domain}-all` });
        const items = d.scopes.map((s) => {
            const box = h('input', { type: 'checkbox', value: s.scope, id: `sc-${s.scope.replace(':', '-')}` });
            boxes.push(box);
            return h('li', {}, h('label', { class: 'pick', for: box.id }, box,
                h('span', { class: 'pick-text' },
                    h('span', { class: 'pick-name' }, h('span', { text: s.label }), s.write ? h('span', { class: 'chip chip-write', text: 'changes data' }) : null),
                    h('span', { class: 'pick-help', text: s.text }),
                    h('code', { class: 'scope-code', text: s.scope }))));
        });
        boxes.push(all);
        all.addEventListener('change', () => {
            for (const li of items) {
                const b = li.querySelector('input');
                b.disabled = all.checked;
                if (all.checked) b.checked = false;
            }
        });
        return h('fieldset', { class: `pick-group hue-${scopeHue(d.domain)}` },
            h('legend', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), d.title),
            h('ul', {}, items,
                h('li', {}, h('label', { class: 'pick pick-all', for: all.id }, all,
                    h('span', { class: 'pick-text' },
                        h('span', { class: 'pick-name', text: `Everything in ${d.title}` }),
                        h('span', { class: 'pick-help', text: 'Includes actions added later.' }),
                        h('code', { class: 'scope-code', text: `${d.domain}:*` }))))));
    });

    const everything = h('input', { type: 'checkbox', value: '*', id: 'sc-star' });
    boxes.push(everything);
    const other = h('input', { type: 'text', id: 'k-other', autocomplete: 'off', spellcheck: 'false', placeholder: 'flights:read, notes:*', 'aria-describedby': 'k-other-help' });

    const chosen = () => [...boxes.filter((b) => b.checked && !b.disabled).map((b) => b.value),
        ...other.value.split(',').map((s) => s.trim()).filter(Boolean)];

    const form = h('form', {
        class: 'create-form',
        novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            error.textContent = '';
            name.removeAttribute('aria-invalid');
            if (!name.value.trim()) {
                error.textContent = 'Give the key a name: the service that will use it.';
                name.setAttribute('aria-invalid', 'true');
                name.focus();
                return;
            }
            const scopes = chosen();
            if (!scopes.length) { error.textContent = 'Pick at least one thing the key may do.'; return; }
            submit.disabled = true;
            try {
                const key = await ctx.api('/keys', { method: 'POST', body: { name: name.value.trim(), scopes } });
                toast('Key created');
                onCreated(key);
            } catch (err) {
                error.textContent = err.message;
                submit.disabled = false;
            }
        },
    },
    h('div', { class: 'field' },
        h('label', { for: 'k-name', text: 'Name' }), name,
        h('p', { class: 'help', id: 'k-name-help', text: 'The service that will use it, for example openclaw or home-assistant. One active key per name.' })),
    h('div', { class: 'field' },
        h('p', { class: 'field-label', id: 'k-scopes-label', text: 'What it may do' }),
        h('p', { class: 'help', text: 'Give each service only what it needs. Agents also need the domain switched on and agent access allowed on the overview.' }),
        h('div', { class: 'pick-groups', role: 'group', 'aria-labelledby': 'k-scopes-label' }, groups,
            h('fieldset', { class: 'pick-group hue-neutral' },
                h('legend', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), 'Everything'),
                h('ul', {}, h('li', {}, h('label', { class: 'pick', for: 'sc-star' }, everything,
                    h('span', { class: 'pick-text' },
                        h('span', { class: 'pick-name' }, h('span', { text: 'Every domain and action' }), h('span', { class: 'chip chip-write', text: 'changes data' })),
                        h('span', { class: 'pick-help', text: explain('*').text }),
                        h('code', { class: 'scope-code', text: '*' }))))))),
        h('div', { class: 'field' },
            h('label', { for: 'k-other', text: 'Other scopes (optional)' }), other,
            h('p', { class: 'help', id: 'k-other-help', text: 'Comma separated, as domain:action or domain:*.' }))),
    error,
    h('div', { class: 'row' }, submit));
    setTimeout(() => name.focus(), 0);
    return form;
}

function reveal(key, { onDone, onCopied }) {
    const field = h('input', { type: 'text', class: 'secret', readonly: true, value: key.key, 'aria-label': `API key for ${key.name}`, spellcheck: 'false', onfocus: (e) => e.target.select() });
    const copy = copyButton({ value: key.key, field, text: 'Copy key', done: 'Key copied', variant: 'primary', onCopied });
    setTimeout(() => copy.focus(), 0);
    return h('div', { class: 'reveal' },
        h('div', { class: 'reveal-warn', role: 'status' },
            icon('warn'),
            h('div', {},
                h('p', { class: 'reveal-title', text: "Copy this key now. You won't see it again." }),
                h('p', { text: 'The hub keeps only a fingerprint of it. If it is lost, revoke it and create a new one.' }))),
        field,
        h('div', { class: 'row' }, copy, button({ text: 'Done', variant: 'quiet', onClick: onDone })),
        h('div', { class: 'reveal-scopes' }, h('p', { class: 'muted', text: `${key.name} may:` }), h('div', { class: 'chips' }, key.scopes.map(scopeChip))),
        h('p', { class: 'note' }, 'Send it as ', h('code', { text: 'Authorization: Bearer <key>' }), '.'));
}

function openCreate(ctx, fromList) {
    let created = null;
    let copied = false;
    const handle = openDrawer({
        title: 'Create key',
        subtitle: 'A key for one service, limited to what you pick.',
        content: createForm(ctx, (key) => {
            created = key;
            handle.setTitle('Key created', key.name);
            handle.setContent(reveal(key, { onCopied: () => { copied = true; }, onDone: () => handle.close() }));
        }),
        beforeClose: async () => {
            if (!created || copied) return true;
            return confirmDialog({
                title: 'Close without copying the key?',
                body: 'It cannot be shown again. You would have to revoke it and create another.',
                confirm: 'Close anyway',
                cancel: 'Keep it open',
                danger: true,
            });
        },
        onClose: () => {
            created = null; // drop the secret
            const mine = drawer && drawer.handle === handle;
            if (mine) { drawer = null; closeDrawerTo(fromList); }
        },
        returnFocus: () => document.querySelector('[data-key="new-key"]'),
    });
    drawer = { kind: 'new', handle, fromList };
}

function openKey(ctx, k, use, fromList) {
    const handle = openDrawer({
        title: k.name,
        subtitle: k.revoked_at ? 'Revoked key' : 'API key',
        content: keyDrawer(ctx, k, use),
        onClose: () => {
            const mine = drawer && drawer.handle === handle;
            if (mine) { drawer = null; closeDrawerTo(fromList); }
        },
        returnFocus: () => document.querySelector(`[data-key="key:${k.id}"]`),
    });
    drawer = { kind: 'key', id: k.id, handle, fromList };
}

// Opens, keeps or closes the drawer so it matches the URL.
function syncDrawer(ctx, list, usage) {
    const route = ctx.route;
    const id = route.parts[0] ? Number(route.parts[0]) : null;
    const wantsNew = !id && route.query.get('new') === '1';
    const want = id ? `key:${id}` : wantsNew ? 'new' : null;
    const have = drawer ? (drawer.kind === 'key' ? `key:${drawer.id}` : 'new') : null;
    if (want === have) return;
    if (drawer) { const d = drawer; drawer = null; d.handle.close(true); }
    const fromList = lastWasList;
    if (id) {
        const k = list.find((x) => x.id === id);
        if (!k) { toast('There is no key with that id.', { kind: 'info' }); navigate(href('keys'), { replace: true }); return; }
        setTimeout(() => openKey(ctx, k, usage.get(id), fromList), 0);
    } else if (wantsNew) {
        setTimeout(() => openCreate(ctx, fromList), 0);
    }
}

/* ---------- table ---------- */

function keyRow(k, use) {
    const revoked = Boolean(k.revoked_at);
    const link = h('a', { class: 'row-link', href: href('keys', [String(k.id)]), 'data-key': `key:${k.id}` }, k.name);
    return h('tr', { class: revoked ? 'revoked' : null, onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('td', { class: 'cell-main' }, h('div', { class: 'key-name' }, link, h('code', { class: 'key-prefix', text: `${k.key_prefix}…` }))),
        h('td', { 'data-label': 'May do' }, h('div', { class: 'chips' }, k.scopes.map(scopeChip))),
        h('td', { 'data-label': revoked ? 'Revoked' : 'Last used', text: revoked ? when(k.revoked_at) : (k.last_used_at ? ago(k.last_used_at) : 'Never used') }),
        h('td', { 'data-label': 'Agent calls, 30 days', class: 'num', text: use ? use.calls30d.toLocaleString() : '0' }),
        // Phones: a thumb-sized open button on the right (the name link is the keyboard and reader route).
        h('td', { class: 'cell-side only-narrow' }, h('a', { class: 'btn ghost icon-only', href: link.getAttribute('href'), tabindex: '-1', 'aria-hidden': 'true' }, icon('next'))));
}

function keyTable(rows, { revoked = false } = {}) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'stack keys-table' },
        h('thead', {}, h('tr', {},
            h('th', { scope: 'col', text: 'Name' }),
            h('th', { scope: 'col', text: 'May do' }),
            h('th', { scope: 'col', text: revoked ? 'Revoked' : 'Last used' }),
            h('th', { scope: 'col', class: 'num', text: 'Agent calls, 30 days' }))),
        h('tbody', {}, rows)));
}

export async function render(ctx) {
    const [{ keys: list }, agents] = await Promise.all([ctx.api('/keys'), ctx.api('/agents')]);
    const usage = new Map(agents.keys.map((k) => [k.id, k]));
    const active = list.filter((k) => !k.revoked_at);
    const revoked = list.filter((k) => k.revoked_at);

    syncDrawer(ctx, list, usage);
    lastWasList = !ctx.route.parts[0] && ctx.route.query.get('new') !== '1';
    // Leaving the view closes any drawer; moving within it is handled by syncDrawer.
    ctx.onCleanup(() => {
        if (drawer && parse().name !== 'keys') { const d = drawer; drawer = null; d.handle.close(true); }
    });

    const create = h('a', { class: 'btn', href: href('keys', [], { new: '1' }), 'data-key': 'new-key' }, icon('plus'), h('span', { text: 'Create key' }));

    return h('div', { class: 'view keys' },
        h('div', { class: 'view-intro row-between' },
            h('p', { class: 'lede', text: 'Each service that reads or writes the hub gets its own key, limited to what you allow. Open a key to see what it can reach and what it did.' }),
            create),
        h('section', { 'aria-labelledby': 'k-active' },
            h('h2', { id: 'k-active', class: 'section-title', text: plural(active.length, 'active key') }),
            active.length
                ? keyTable(active.map((k) => keyRow(k, usage.get(k.id))))
                : emptyState({ title: 'No active keys.', text: 'Create one for the first service that needs the hub.', iconName: 'keys' })),
        revoked.length ? h('details', { class: 'revoked-keys' },
            h('summary', {}, `${plural(revoked.length, 'revoked key')}`, hidden(', show')),
            keyTable(revoked.map((k) => keyRow(k, usage.get(k.id))), { revoked: true })) : null);
}
