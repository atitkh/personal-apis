// API keys: create (secret shown once), list, revoke. #/keys/12 highlights one key, #/keys?new=1 focuses the
// create form. Ported from the old single-file app; stage 2 adds the detail drawer and revoke dialog.
import { h, plural, when, ago, emptyState, toast, confirmDialog } from '../ui.js';
import { href, navigate } from '../router.js';

let newKey = null; // the just-created key, shown once

export async function render(ctx) {
    const { keys: list } = await ctx.api('/keys');
    const focusId = ctx.route.parts[0] ? Number(ctx.route.parts[0]) : null;
    const wantsNew = ctx.route.query.get('new') === '1';

    const name = h('input', { type: 'text', id: 'k-name', name: 'name', placeholder: 'home-assistant', autocomplete: 'off', required: true });
    const scopes = h('input', { type: 'text', id: 'k-scopes', name: 'scopes', placeholder: 'attendance:read, flights:*', autocomplete: 'off', required: true });
    const error = h('p', { class: 'error', role: 'alert' });
    const create = h('button', { class: 'btn', type: 'submit', text: 'Create key' });

    const form = h('form', {
        onsubmit: async (event) => {
            event.preventDefault();
            error.textContent = '';
            create.disabled = true;
            try {
                newKey = await ctx.api('/keys', { method: 'POST', body: { name: name.value, scopes: scopes.value } });
                toast('Key created');
                if (wantsNew) navigate(href('keys'), { replace: true });
                else ctx.rerender();
            } catch (err) {
                error.textContent = err.message;
                create.disabled = false;
            }
        },
    },
    h('div', { class: 'form-grid' },
        h('label', { for: 'k-name' }, 'Name', name, h('span', { class: 'help', text: 'The service that will use it.' })),
        h('label', { for: 'k-scopes' }, 'Scopes', scopes, h('span', { class: 'help', text: 'domain:action, or domain:* for a whole domain.' })),
        h('div', { class: 'action' }, create)),
    error);

    const rows = list.map((k) => {
        const revoked = Boolean(k.revoked_at);
        const action = revoked ? null : h('button', {
            class: 'btn quiet small',
            type: 'button',
            text: 'Revoke',
            'aria-label': `Revoke ${k.name}`,
            onclick: async () => {
                const ok = await confirmDialog({
                    title: `Revoke ${k.name}?`,
                    body: 'Anything using this key loses access at once. This cannot be undone; you would create a new key instead.',
                    confirm: 'Revoke key',
                    danger: true,
                });
                if (!ok) return;
                try {
                    await ctx.api(`/keys/${k.id}`, { method: 'DELETE' });
                    toast('Key revoked');
                } catch (err) {
                    toast(`Could not revoke the key. ${err.message}`, { kind: 'bad' });
                }
                ctx.rerender();
            },
        });
        return h('tr', { class: `${revoked ? 'revoked' : ''}${k.id === focusId ? ' focus-row' : ''}`.trim() || null, id: `key-${k.id}` },
            h('td', { text: k.name }),
            h('td', {}, h('span', { class: 'scopes', text: k.scopes.join(', ') })),
            h('td', { text: when(k.created_at) }),
            h('td', { text: revoked ? `Revoked ${when(k.revoked_at)}` : (k.last_used_at ? ago(k.last_used_at) : 'Never used') }),
            h('td', { class: 'num' }, action));
    });

    const reveal = newKey && h('div', { class: 'reveal', role: 'status' },
        h('p', {}, h('strong', { text: `Key created for ${newKey.name}. ` }), 'Copy it now. It is not stored and cannot be shown again.'),
        h('code', { text: newKey.key }),
        h('div', { class: 'row' },
            h('button', {
                class: 'btn',
                type: 'button',
                text: 'Copy key',
                onclick: async (event) => {
                    const btn = event.currentTarget;
                    try {
                        await navigator.clipboard.writeText(newKey.key);
                        btn.textContent = 'Copied';
                        toast('Key copied');
                    } catch (e) {
                        btn.textContent = 'Select the key and copy it by hand';
                    }
                },
            }),
            h('button', { class: 'btn quiet', type: 'button', text: 'Done', onclick: () => { newKey = null; ctx.rerender(); } })));

    const node = h('div', { class: 'legacy' },
        h('p', { class: 'lede', text: 'Each service that reads or writes the hub gets its own key, limited to the scopes you give it.' }),
        reveal,
        h('section', {},
            h('h2', { text: 'New key' }),
            form),
        h('section', {},
            h('h2', { text: plural(list.filter((k) => !k.revoked_at).length, 'active key') }),
            list.length
                ? h('div', { class: 'table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {}, ['Name', 'Scopes', 'Created', 'Last used', ''].map((t) => h('th', { text: t })))),
                    h('tbody', {}, rows)))
                : emptyState({ title: 'No keys yet.', text: 'Create one above for the first service that needs access.' })));

    setTimeout(() => {
        if (wantsNew && name.isConnected) name.focus();
        const row = focusId && document.getElementById(`key-${focusId}`);
        if (row) row.scrollIntoView({ block: 'center' });
    }, 0);
    return node;
}
