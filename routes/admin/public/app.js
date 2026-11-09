// Personal hub dashboard. Plain JavaScript, no build step. All text from the server goes in through
// textContent (see h()), never innerHTML.
(() => {
    'use strict';

    const root = document.getElementById('app');
    const state = { session: null, view: 'overview', newKey: null, confirmRevoke: null, filter: '' };

    const VIEWS = [
        ['overview', 'Overview'],
        ['keys', 'API keys'],
        ['backups', 'Backups'],
        ['portfolio', 'Portfolio'],
        ['activity', 'Activity'],
    ];

    /* ---------- small helpers ---------- */

    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (value == null || value === false) continue;
            if (key === 'class') el.className = value;
            else if (key === 'text') el.textContent = value;
            else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
            else el.setAttribute(key, value === true ? '' : value);
        }
        for (const kid of kids.flat()) {
            if (kid == null || kid === false) continue;
            el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
        }
        return el;
    }

    async function api(path, { method = 'GET', body } = {}) {
        const res = await fetch(`api${path}`, {
            method,
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'hub-admin', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        let data = null;
        try { data = await res.json(); } catch (e) { /* no body */ }
        if (res.status === 401 && path !== '/login') {
            state.session = null;
            render();
            throw new Error('Sign in first.');
        }
        if (!res.ok) {
            throw new Error((data && data.error) || `The request failed (${res.status}).`);
        }
        return data;
    }

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

    function bytes(n) {
        if (!n) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
        const v = n / 1024 ** i;
        return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
    }

    const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const when = (iso) => (iso ? dateFmt.format(new Date(iso)) : 'never');

    function ago(iso) {
        if (!iso) return 'never';
        const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
        if (s < 60) return 'just now';
        const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
        for (const [size, name] of units) {
            if (s >= size) return `${plural(Math.floor(s / size), name)} ago`;
        }
        return 'just now';
    }

    function span(seconds) {
        const d = Math.floor(seconds / 86400);
        const hrs = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d) return `${plural(d, 'day')}, ${plural(hrs, 'hour')}`;
        if (hrs) return `${plural(hrs, 'hour')}, ${plural(m, 'minute')}`;
        return plural(m, 'minute');
    }

    const fact = (label, ...value) => [h('dt', { text: label }), h('dd', {}, ...value)];
    const dot = (kind) => h('span', { class: `dot ${kind}`, 'aria-hidden': 'true' });
    const go = (view) => { state.view = view; state.confirmRevoke = null; render(); };

    /* ---------- sign in ---------- */

    function renderSignIn() {
        const error = h('p', { class: 'error', role: 'alert' });
        const input = h('input', { type: 'password', id: 'key', name: 'key', autocomplete: 'current-password', required: true });
        const button = h('button', { class: 'btn', type: 'submit', text: 'Sign in' });

        const form = h('form', {
            onsubmit: async (event) => {
                event.preventDefault();
                error.textContent = '';
                button.disabled = true;
                try {
                    await api('/login', { method: 'POST', body: { key: input.value } });
                    input.value = '';
                    state.session = await api('/session');
                    state.view = 'overview';
                    render();
                } catch (err) {
                    error.textContent = err.message;
                    input.select();
                } finally {
                    button.disabled = false;
                }
            },
        },
        h('h1', { text: 'Personal hub' }),
        h('p', { class: 'hint', text: 'Enter the admin key to continue.' }),
        h('label', { for: 'key' }, 'Admin key', input),
        error,
        h('div', { class: 'row' }, button));

        root.replaceChildren(h('div', { class: 'signin' }, form));
        input.focus();
    }

    /* ---------- shell ---------- */

    function shell(content) {
        const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' },
            VIEWS.map(([id, label]) => h('button', {
                type: 'button',
                'aria-current': state.view === id ? 'page' : null,
                onclick: () => go(id),
                text: label,
            })));

        return h('div', { class: 'shell' },
            h('aside', { class: 'rail' },
                h('div', { class: 'brand', text: 'Personal hub' }),
                nav,
                h('div', { class: 'rail-foot' },
                    h('span', { class: 'small', text: state.session ? `Signed in until ${when(state.session.expiresAt)}` : '' }),
                    h('button', {
                        class: 'btn quiet small',
                        type: 'button',
                        text: 'Sign out',
                        onclick: async () => {
                            try { await api('/logout', { method: 'POST' }); } catch (e) { /* already out */ }
                            state.session = null;
                            render();
                        },
                    }))),
            h('main', {}, content));
    }

    /* ---------- views ---------- */

    async function overview() {
        const o = await api('/overview');
        const issues = [];
        if (o.database.status !== 'healthy') issues.push('The database is not responding.');
        const newest = o.backups.newest;
        if (!newest) issues.push('No backup has been made yet.');
        else if (Date.now() - Date.parse(newest.modifiedAt) > 36 * 3600 * 1000) issues.push(`The last backup is ${ago(newest.modifiedAt).replace(' ago', '')} old.`);
        if (o.portfolio.problems) issues.push(`${plural(o.portfolio.problems, 'portfolio file')} ${o.portfolio.problems === 1 ? 'needs' : 'need'} a look.`);

        const headline = issues.length ? 'Needs attention.' : 'Everything is running.';
        const lede = issues.length
            ? issues.join(' ')
            : `The database is healthy, the last backup was ${ago(newest.modifiedAt)}, and ${plural(o.keys.active, 'API key')} ${o.keys.active === 1 ? 'is' : 'are'} active.`;

        return h('div', {},
            h('header', {},
                h('h1', { class: `status${issues.length ? ' warn' : ''}`, text: headline }),
                h('p', { class: 'lede', text: lede })),
            h('section', {},
                h('h2', { text: 'Database' }),
                h('dl', { class: 'facts' },
                    fact('Status', dot(o.database.status === 'healthy' ? 'good' : 'bad'), o.database.status === 'healthy' ? 'Healthy' : 'Not responding'),
                    fact('Size', bytes(o.database.bytes), o.database.walBytes ? ` (plus ${bytes(o.database.walBytes)} of recent writes)` : ''),
                    fact('Schema', `${plural(o.database.migrations, 'migration')} applied`))),
            h('section', {},
                h('h2', { text: 'Backups' }),
                h('dl', { class: 'facts' },
                    fact('Newest', newest ? `${when(newest.modifiedAt)} (${ago(newest.modifiedAt)})` : 'None yet'),
                    fact('Kept', plural(o.backups.count, 'copy', 'copies'))),
                h('p', {}, h('button', { class: 'btn quiet small', type: 'button', text: 'See backups', onclick: () => go('backups') }))),
            h('section', {},
                h('h2', { text: 'API keys' }),
                h('dl', { class: 'facts' },
                    fact('Active', String(o.keys.active)),
                    fact('Revoked', String(o.keys.revoked)),
                    fact('Last used', o.keys.lastUsedAt ? `${when(o.keys.lastUsedAt)} (${ago(o.keys.lastUsedAt)})` : 'Never')),
                h('p', {}, h('button', { class: 'btn quiet small', type: 'button', text: 'Manage keys', onclick: () => go('keys') }))),
            h('section', {},
                h('h2', { text: 'Portfolio' }),
                h('dl', { class: 'facts' },
                    fact('Entries', String(o.portfolio.entryCount)),
                    fact('Last edited', `${when(o.portfolio.updatedAt)} (${ago(o.portfolio.updatedAt)})`),
                    fact('Problems', o.portfolio.problems ? [dot('warn'), plural(o.portfolio.problems, 'file')] : [dot('good'), 'None'])),
                h('p', {}, h('button', { class: 'btn quiet small', type: 'button', text: 'Open the portfolio inventory', onclick: () => go('portfolio') }))),
            h('section', {},
                h('h2', { text: 'Server' }),
                h('dl', { class: 'facts' },
                    fact('Service', `${o.app.name} ${o.app.version}`),
                    fact('Running for', span(o.app.uptimeSeconds)),
                    fact('Runtime', `Node ${o.app.node.replace(/^v/, '')}, ${o.app.environment}`))));
    }

    async function keys() {
        const { keys: list } = await api('/keys');

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
                    state.newKey = await api('/keys', { method: 'POST', body: { name: name.value, scopes: scopes.value } });
                    render();
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
            let action = null;
            if (!revoked) {
                action = state.confirmRevoke === k.id
                    ? h('span', { class: 'row' },
                        h('button', {
                            class: 'btn danger small',
                            type: 'button',
                            text: 'Yes, revoke',
                            onclick: async () => {
                                try { await api(`/keys/${k.id}`, { method: 'DELETE' }); } catch (e) { /* shown by reload */ }
                                state.confirmRevoke = null;
                                render();
                            },
                        }),
                        h('button', { class: 'btn quiet small', type: 'button', text: 'Cancel', onclick: () => { state.confirmRevoke = null; render(); } }))
                    : h('button', { class: 'btn quiet small', type: 'button', text: 'Revoke', onclick: () => { state.confirmRevoke = k.id; render(); } });
            }
            return h('tr', { class: revoked ? 'revoked' : null },
                h('td', { text: k.name }),
                h('td', {}, h('span', { class: 'scopes', text: k.scopes.join(', ') })),
                h('td', { text: when(k.created_at) }),
                h('td', { text: revoked ? `Revoked ${when(k.revoked_at)}` : (k.last_used_at ? ago(k.last_used_at) : 'Never used') }),
                h('td', { class: 'num' }, action));
        });

        const reveal = state.newKey && h('div', { class: 'reveal', role: 'status' },
            h('p', {}, h('strong', { text: `Key created for ${state.newKey.name}. ` }), 'Copy it now. It is not stored and cannot be shown again.'),
            h('code', { text: state.newKey.key }),
            h('div', { class: 'row' },
                h('button', {
                    class: 'btn',
                    type: 'button',
                    text: 'Copy key',
                    onclick: async (event) => {
                        const btn = event.currentTarget;
                        try {
                            await navigator.clipboard.writeText(state.newKey.key);
                            btn.textContent = 'Copied';
                        } catch (e) {
                            btn.textContent = 'Select the key and copy it by hand';
                        }
                    },
                }),
                h('button', { class: 'btn quiet', type: 'button', text: 'Done', onclick: () => { state.newKey = null; render(); } })));

        return h('div', {},
            h('header', {},
                h('h1', { class: 'status', text: 'API keys' }),
                h('p', { class: 'lede', text: 'Each service that reads or writes the hub gets its own key, limited to the scopes you give it.' })),
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
                    : h('p', { class: 'muted', text: 'No keys yet. Create one above for the first service that needs access.' })));
    }

    async function backups() {
        const { backups: list } = await api('/backups');
        return h('div', {},
            h('header', {},
                h('h1', { class: 'status', text: 'Backups' }),
                h('p', { class: 'lede', text: 'The database is copied once a day, from inside the service. The newest seven copies are kept next to the database file.' })),
            h('section', {},
                list.length
                    ? h('div', { class: 'table-wrap' }, h('table', {},
                        h('thead', {}, h('tr', {}, h('th', { text: 'Copy' }), h('th', { text: 'Saved' }), h('th', { class: 'num', text: 'Size' }))),
                        h('tbody', {}, list.map((b) => h('tr', {},
                            h('td', { text: b.name }),
                            h('td', { text: `${when(b.modifiedAt)} (${ago(b.modifiedAt)})` }),
                            h('td', { class: 'num', text: bytes(b.bytes) }))))))
                    : h('p', { class: 'muted', text: 'No copies yet. The first one is made shortly after the service starts.' })));
    }

    async function portfolio() {
        const p = await api('/portfolio');
        const problems = [];
        if (p.missingPages.length) problems.push(`Entries that expect a detail page but have none: ${p.missingPages.join(', ')}.`);
        if (p.orphanPages.length) problems.push(`Detail pages with no matching entry: ${p.orphanPages.join(', ')}.`);

        const body = h('tbody');
        const paint = () => {
            const q = state.filter.trim().toLowerCase();
            const shown = p.rows.filter((r) => !q || `${r.id} ${r.title} ${r.category}`.toLowerCase().includes(q));
            body.replaceChildren(...shown.map((r) => h('tr', {},
                h('td', { text: String(r.id) }),
                h('td', { text: r.title }),
                h('td', { text: r.category }),
                h('td', { text: r.date }),
                h('td', {}, r.hasPage
                    ? (r.pageExists ? [dot('good'), 'Page'] : [dot('warn'), 'Missing'])
                    : h('span', { class: 'muted', text: 'None' })))));
            if (!shown.length) body.append(h('tr', {}, h('td', { colspan: '5', class: 'muted', text: 'Nothing matches that search.' })));
        };
        paint();

        const search = h('input', {
            type: 'search',
            id: 'p-filter',
            placeholder: 'Search by title, id or category',
            value: state.filter,
            'aria-label': 'Search entries',
            oninput: (event) => { state.filter = event.target.value; paint(); },
        });

        return h('div', {},
            h('header', {},
                h('h1', { class: 'status', text: 'Portfolio' }),
                h('p', { class: 'lede', text: `${plural(p.entryCount, 'entry', 'entries')}, last edited ${ago(p.updatedAt)}. Changes to atit.json go live as soon as the file is saved.` })),
            h('section', {},
                h('h2', { text: 'Files' }),
                h('dl', { class: 'facts' },
                    fact('Detail pages', `${p.files.pages.count} (${bytes(p.files.pages.bytes)})`),
                    fact('Images', `${p.files.images.count} (${bytes(p.files.images.bytes)})`),
                    fact('PDFs', `${p.files.pdfs.count} (${bytes(p.files.pdfs.bytes)})`),
                    fact('Problems', problems.length ? problems.map((t) => h('div', { text: t })) : [dot('good'), 'None']))),
            h('section', {},
                h('h2', { text: 'Entries' }),
                h('p', { class: 'note' }, search),
                h('div', { class: 'table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {}, ['Id', 'Title', 'Category', 'Date', 'Detail page'].map((t) => h('th', { text: t })))),
                    body))));
    }

    const WHAT = {
        login: () => 'Signed in',
        logout: () => 'Signed out',
        login_failed: () => 'Tried a wrong key',
        key_created: (d) => `Created key ${d && d.name ? d.name : ''}${d && d.scopes ? ` (${d.scopes.join(', ')})` : ''}`,
        key_revoked: (d) => `Revoked key ${d && d.name ? d.name : ''}`,
    };

    async function activity() {
        const { events } = await api('/activity?limit=100');
        return h('div', {},
            h('header', {},
                h('h1', { class: 'status', text: 'Activity' }),
                h('p', { class: 'lede', text: 'Sign-ins and key changes, newest first.' })),
            h('section', {},
                events.length
                    ? h('div', { class: 'table-wrap' }, h('table', {},
                        h('thead', {}, h('tr', {}, ['When', 'What', 'From'].map((t) => h('th', { text: t })))),
                        h('tbody', {}, events.map((e) => h('tr', {},
                            h('td', { text: when(e.at) }),
                            h('td', { text: (WHAT[e.action] || (() => e.action))(e.detail).trim() }),
                            h('td', { class: 'muted', text: e.ip || '' }))))))
                    : h('p', { class: 'muted', text: 'Nothing has happened yet.' })));
    }

    const VIEW_FN = { overview, keys, backups, portfolio, activity };

    /* ---------- render loop ---------- */

    let renderToken = 0;

    async function render() {
        const token = ++renderToken;
        if (!state.session) return renderSignIn();
        root.replaceChildren(shell(h('p', { class: 'muted', text: 'Loading…' })));
        let content;
        try {
            content = await VIEW_FN[state.view]();
        } catch (err) {
            if (!state.session) return;
            content = h('div', {}, h('h1', { class: 'status warn', text: 'That did not load.' }), h('p', { class: 'lede', text: err.message }));
        }
        if (token === renderToken && state.session) root.replaceChildren(shell(content));
    }

    (async () => {
        try {
            const s = await api('/session');
            state.session = s.authenticated ? s : null;
        } catch (e) {
            state.session = null;
        }
        render();
    })();
})();
