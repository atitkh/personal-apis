// Personal hub dashboard. Plain JavaScript, no build step. All text from the server goes in through
// textContent (see h()), never innerHTML.
(() => {
    'use strict';

    const root = document.getElementById('app');
    const state = {
        session: null, view: 'overview', newKey: null, confirmRevoke: null, filter: '', confirmDomain: null,
        digestKind: 'daily', digestQuery: '', digest: null, viewRev: null, editing: false, showHistory: false,
        compare: null, confirmRestore: null, activityFilter: 'all', backupMsg: '', backingUp: false,
    };

    const VIEWS = [
        ['overview', 'Overview'],
        ['digests', 'Digests'],
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
        for (const kid of kids.flat(Infinity)) {
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
    const resetDigest = () => Object.assign(state, { digest: null, viewRev: null, editing: false, showHistory: false, compare: null, confirmRestore: null });
    const go = (view) => { state.view = view; state.confirmRevoke = null; state.confirmDomain = null; resetDigest(); render(); };

    const SOURCE_LABEL = { generated: 'Generated', import: 'Imported', edit: 'Edited', restore: 'Restored' };

    function periodTitle(kind, period) {
        if (kind !== 'daily') return period;
        return new Date(`${period}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }

    // Shows a search snippet, turning [matched] words into <mark> without using innerHTML.
    function highlight(snippet) {
        return snippet.split(/(\[[^\]]*\])/).filter(Boolean).map((part) => (/^\[.*\]$/.test(part) ? h('mark', { text: part.slice(1, -1) }) : part));
    }

    // Paragraph-level comparison of an older and a newer text.
    function diffParagraphs(older, newer) {
        const A = older.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
        const B = newer.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
        const n = A.length;
        const m = B.length;
        const L = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        }
        const out = [];
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (A[i] === B[j]) { out.push(['same', A[i]]); i++; j++; }
            else if (L[i + 1][j] >= L[i][j + 1]) out.push(['del', A[i++]]);
            else out.push(['add', B[j++]]);
        }
        while (i < n) out.push(['del', A[i++]]);
        while (j < m) out.push(['add', B[j++]]);
        return out;
    }

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

    function domainsSection(list) {
        const toggle = async (name, enabled) => {
            try { await api(`/domains/${name}`, { method: 'PUT', body: { enabled } }); } catch (e) { /* the reload shows the real state */ }
            state.confirmDomain = null;
            render();
        };
        const rows = list.map((d) => {
            const confirming = state.confirmDomain === d.name;
            let action;
            if (d.enabled && d.confirmOff) {
                action = confirming
                    ? h('span', { class: 'row' },
                        h('button', { class: 'btn danger small', type: 'button', text: 'Yes, turn off', onclick: () => toggle(d.name, false) }),
                        h('button', { class: 'btn quiet small', type: 'button', text: 'Cancel', onclick: () => { state.confirmDomain = null; render(); } }))
                    : h('button', { class: 'btn quiet small', type: 'button', text: 'Turn off', onclick: () => { state.confirmDomain = d.name; render(); } });
            } else {
                action = h('button', { class: 'btn quiet small', type: 'button', text: d.enabled ? 'Turn off' : 'Turn on', onclick: () => toggle(d.name, !d.enabled) });
            }
            const contents = d.records == null ? '' : `${d.records} ${d.recordLabel}${d.lastChange ? `, changed ${ago(d.lastChange)}` : ''}`;
            return [
                h('tr', {},
                    h('td', { text: d.title }),
                    h('td', { text: d.sensitivity === 'public' ? 'Public' : 'Private' }),
                    h('td', { text: d.storage === 'db' ? 'Database' : 'Files in git' }),
                    h('td', { text: contents }),
                    h('td', {}, dot(d.enabled ? 'good' : 'warn'), d.enabled ? 'On' : 'Off'),
                    h('td', { class: 'num' }, action)),
                confirming && d.confirmOff ? h('tr', {}, h('td', { colspan: '6', class: 'warn-note', text: d.confirmOff })) : null,
            ];
        });
        return h('section', {},
            h('h2', { text: 'Domains' }),
            h('p', { class: 'note', text: 'Each kind of data the hub holds. Turning one off pauses it for every key and visitor. Nothing is deleted.' }),
            h('div', { class: 'table-wrap' }, h('table', {},
                h('thead', {}, h('tr', {}, ['Domain', 'Visibility', 'Stored in', 'Contents', 'State', ''].map((t) => h('th', { text: t })))),
                h('tbody', {}, rows))));
    }

    async function overview() {
        const o = await api('/overview');
        const issues = [];
        if (o.database.status !== 'healthy') issues.push('The database is not responding.');
        const newest = o.backups.newest;
        if (!newest) issues.push('No backup has been made yet.');
        else if (Date.now() - Date.parse(newest.modifiedAt) > 36 * 3600 * 1000) issues.push(`The last backup is ${ago(newest.modifiedAt).replace(' ago', '')} old.`);
        if (o.digests && o.digests.missing) issues.push(`The daily digest for ${o.digests.expectedDaily} has not arrived.`);
        if (o.portfolio.problems) issues.push(`${plural(o.portfolio.problems, 'portfolio file')} ${o.portfolio.problems === 1 ? 'needs' : 'need'} a look.`);

        const headline = issues.length ? 'Needs attention.' : 'Everything is running.';
        const lede = issues.length
            ? issues.join(' ')
            : `The database is healthy, the last backup was ${ago(newest.modifiedAt)}, and ${plural(o.keys.active, 'API key')} ${o.keys.active === 1 ? 'is' : 'are'} active.`;

        const tile = (label, value, detail, target, kind) => h(target ? 'button' : 'div', {
            class: `tile${kind ? ` ${kind}` : ''}`,
            type: target ? 'button' : null,
            onclick: target ? () => go(target) : null,
        }, h('span', { class: 'tile-label', text: label }), h('span', { class: 'tile-value', text: value }), h('span', { class: 'tile-detail', text: detail }));

        const on = (o.domains || []).filter((d) => d.enabled).length;
        const cov = o.digests && o.digests.coverage;
        const tiles = h('div', { class: 'tiles' },
            tile('Domains on', `${on} of ${(o.domains || []).length}`, 'Switch them below', null),
            tile('Digests', String(o.digests ? o.digests.dailyCount : 0), o.digests && o.digests.latestDaily ? `Latest: ${o.digests.latestDaily}` : 'None yet', 'digests', o.digests && o.digests.missing ? 'warn' : ''),
            tile('API keys', String(o.keys.active), o.keys.lastUsedAt ? `Used ${ago(o.keys.lastUsedAt)}` : 'Never used', 'keys'),
            tile('Last backup', newest ? ago(newest.modifiedAt).replace(' ago', '') : 'None', newest ? `${plural(o.backups.count, 'copy', 'copies')} kept` : 'Make one in Backups', 'backups', !newest ? 'warn' : ''),
            tile('Portfolio', plural(o.portfolio.entryCount, 'entry', 'entries'), o.portfolio.problems ? plural(o.portfolio.problems, 'problem') : 'No problems', 'portfolio', o.portfolio.problems ? 'warn' : ''));

        const coverage = cov && cov.total ? h('section', {},
            h('h2', { text: 'Daily digests, last 30 days' }),
            h('p', { class: 'note', text: `${cov.present} of ${cov.total} days have one. Gaps are days the nightly job did not deliver.` }),
            h('div', { class: 'strip', role: 'img', 'aria-label': `${cov.present} of ${cov.total} days have a daily digest` },
                cov.days.map((d) => h('button', {
                    class: `cell ${d.present ? 'have' : 'gap'}`,
                    type: 'button',
                    title: `${d.day}${d.present ? '' : ' (missing)'}`,
                    'aria-label': `${d.day}: ${d.present ? 'digest present' : 'missing'}`,
                    onclick: () => { if (d.present) { state.view = 'digests'; state.digestKind = 'daily'; state.digest = { kind: 'daily', period: d.day }; render(); } },
                })))) : null;

        return h('div', {},
            h('header', {},
                h('h1', { class: `status${issues.length ? ' warn' : ''}`, text: headline }),
                h('p', { class: 'lede', text: lede })),
            tiles,
            coverage,
            domainsSection(o.domains || []),
            h('section', {},
                h('h2', { text: 'System' }),
                h('dl', { class: 'facts' },
                    fact('Database', dot(o.database.status === 'healthy' ? 'good' : 'bad'), o.database.status === 'healthy' ? 'Healthy' : 'Not responding'),
                    fact('Size', bytes(o.database.bytes), o.database.walBytes ? ` (plus ${bytes(o.database.walBytes)} of recent writes)` : ''),
                    fact('Schema', `${plural(o.database.migrations, 'migration')} applied`),
                    fact('Portfolio edited', `${when(o.portfolio.updatedAt)} (${ago(o.portfolio.updatedAt)})`),
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
                h('p', { class: 'lede', text: 'The database is copied once a day, from inside the service. The newest seven copies are kept next to the database file.' }),
                h('p', { class: 'row' },
                    h('button', {
                        class: 'btn',
                        type: 'button',
                        disabled: state.backingUp,
                        text: state.backingUp ? 'Backing up…' : 'Back up now',
                        onclick: async () => {
                            state.backingUp = true; state.backupMsg = ''; render();
                            try { await api('/backups', { method: 'POST' }); state.backupMsg = 'Done. A fresh copy of today is saved.'; } catch (err) { state.backupMsg = err.message; }
                            state.backingUp = false; render();
                        },
                    }),
                    state.backupMsg ? h('span', { class: 'muted', role: 'status', text: state.backupMsg }) : null)),
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

    function sourceHealth(meta) {
        const src = meta && meta.sources;
        if (!src || typeof src !== 'object') return h('span', { class: 'muted', text: 'Not recorded' });
        const names = Object.keys(src);
        const ok = names.filter((k) => src[k] === 'ok').length;
        const bad = names.filter((k) => src[k] === 'failed').length;
        return [dot(bad ? 'warn' : 'good'), `${ok} of ${names.length} sources${bad ? `, ${bad} failed` : ''}`];
    }

    function kindSwitch() {
        return h('div', { class: 'row', role: 'group', 'aria-label': 'Kind of digest' },
            [['daily', 'Daily'], ['weekly', 'Weekly']].map(([kind, label]) => h('button', {
                class: `btn small ${state.digestKind === kind ? '' : 'quiet'}`,
                type: 'button',
                'aria-pressed': state.digestKind === kind ? 'true' : 'false',
                text: label,
                onclick: () => { state.digestKind = kind; state.digestQuery = ''; render(); },
            })));
    }

    async function digestList() {
        const q = state.digestQuery.trim();
        const data = await api(`/digests?${q ? `q=${encodeURIComponent(q)}&` : ''}kind=${state.digestKind}&limit=200`);
        const open = (kind, period) => { state.digest = { kind, period }; render(); };

        const input = h('input', { type: 'search', id: 'd-search', value: state.digestQuery, placeholder: 'Search the text of every digest', 'aria-label': 'Search digests' });
        const search = h('form', {
            class: 'row',
            onsubmit: (event) => { event.preventDefault(); state.digestQuery = input.value; render(); },
        }, input, h('button', { class: 'btn quiet', type: 'submit', text: 'Search' }),
        q ? h('button', { class: 'btn quiet', type: 'button', text: 'Clear', onclick: () => { state.digestQuery = ''; render(); } }) : null);

        let body;
        if (q) {
            body = data.results.length
                ? h('ul', { class: 'results' }, data.results.map((r) => h('li', {},
                    h('button', { class: 'link', type: 'button', text: periodTitle(r.kind, r.period), onclick: () => open(r.kind, r.period) }),
                    h('p', { class: 'muted' }, highlight(r.snippet)))))
                : h('p', { class: 'muted', text: `Nothing matches "${q}".` });
        } else if (data.digests.length) {
            body = h('div', { class: 'table-wrap' }, h('table', {},
                h('thead', {}, h('tr', {}, ['Day', 'Version', 'Sources', 'Length'].map((t) => h('th', { text: t })))),
                h('tbody', {}, data.digests.map((d) => h('tr', {},
                    h('td', {}, h('button', { class: 'link', type: 'button', text: periodTitle(d.kind, d.period), onclick: () => open(d.kind, d.period) })),
                    h('td', { text: `${SOURCE_LABEL[d.source] || d.source}${d.rev > 1 ? `, revision ${d.rev}` : ''}` }),
                    h('td', {}, sourceHealth(d.meta)),
                    h('td', { class: 'num', text: `${d.chars.toLocaleString()} characters` }))))));
        } else {
            body = h('p', { class: 'muted', text: `No ${state.digestKind} digests yet.` });
        }

        return h('div', {},
            h('header', {},
                h('h1', { class: 'status', text: 'Digests' }),
                h('p', { class: 'lede', text: 'Written each night from your day, and each week from the days. You can read, correct and search them here.' })),
            h('section', {}, h('div', { class: 'toolbar' }, kindSwitch(), search)),
            h('section', {}, body));
    }

    async function digestDetail() {
        const { kind, period } = state.digest;
        const d = await api(`/digests/${kind}/${period}${state.viewRev ? `?rev=${state.viewRev}` : ''}`);
        const viewingOld = state.viewRev && d.rev !== d.revisions;

        const back = h('button', { class: 'link', type: 'button', text: 'All digests', onclick: () => { resetDigest(); render(); } });
        const byline = `${SOURCE_LABEL[d.source] || d.source}${d.model ? ` by ${d.model}` : d.actor ? ` by ${d.actor}` : ''} on ${when(d.revisedAt)}${d.note && d.source !== 'restore' ? `. Note: ${d.note}` : d.note ? `. ${d.note}` : ''}`;

        let content;
        if (state.editing) {
            const area = h('textarea', { id: 'd-body', rows: '14', 'aria-label': 'Digest text' });
            area.value = d.body;
            const note = h('input', { type: 'text', id: 'd-note', placeholder: 'What did you change? (optional)', maxlength: '200', 'aria-label': 'Note about this change' });
            const error = h('p', { class: 'error', role: 'alert' });
            const save = h('button', { class: 'btn', type: 'submit', text: 'Save changes' });
            content = h('form', {
                class: 'edit',
                onsubmit: async (event) => {
                    event.preventDefault();
                    error.textContent = '';
                    save.disabled = true;
                    try {
                        await api(`/digests/${kind}/${period}`, { method: 'PATCH', body: { body: area.value, note: note.value } });
                        state.editing = false;
                        render();
                    } catch (err) {
                        error.textContent = err.message;
                        save.disabled = false;
                    }
                },
            }, area, note, error, h('div', { class: 'row' }, save,
                h('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => { state.editing = false; render(); } })));
            setTimeout(() => area.focus(), 0);
        } else if (state.compare) {
            const older = await api(`/digests/${kind}/${period}?rev=${state.compare}`);
            const parts = diffParagraphs(older.body, d.body);
            content = h('div', {},
                h('p', { class: 'banner' }, `Comparing revision ${older.rev} with the current text (revision ${d.rev}). `,
                    h('button', { class: 'link', type: 'button', text: 'Close comparison', onclick: () => { state.compare = null; render(); } })),
                h('div', { class: 'diff' }, parts.map(([kindOf, text]) => h('p', { class: kindOf, text }))));
        } else {
            content = h('div', { class: 'digest-body' }, d.body.split(/\n{2,}/).map((para) => h('p', { text: para.trim() })));
        }

        const history = state.showHistory && h('section', {},
            h('h2', { text: 'History' }),
            h('p', { class: 'note', text: 'Revision 1 is what first arrived and is never changed. Restoring adds a new revision with the old text.' }),
            h('div', { class: 'table-wrap' }, h('table', {},
                h('thead', {}, h('tr', {}, ['Revision', 'What', 'Who', 'When', ''].map((t) => h('th', { text: t })))),
                h('tbody', {}, d.history.map((r) => {
                    const actions = [];
                    if (!r.current) {
                        actions.push(h('button', { class: 'btn quiet small', type: 'button', text: 'View', onclick: () => { state.viewRev = r.rev; state.compare = null; state.editing = false; render(); } }));
                        actions.push(h('button', { class: 'btn quiet small', type: 'button', text: 'Compare', onclick: () => { state.viewRev = null; state.compare = r.rev; state.editing = false; render(); } }));
                        actions.push(state.confirmRestore === r.rev
                            ? h('button', {
                                class: 'btn danger small',
                                type: 'button',
                                text: 'Yes, restore',
                                onclick: async () => {
                                    try { await api(`/digests/${kind}/${period}/restore`, { method: 'POST', body: { rev: r.rev } }); } catch (e) { /* reload shows state */ }
                                    state.confirmRestore = null; state.viewRev = null; state.compare = null; render();
                                },
                            })
                            : h('button', { class: 'btn quiet small', type: 'button', text: 'Restore', onclick: () => { state.confirmRestore = r.rev; render(); } }));
                    }
                    return h('tr', {},
                        h('td', { text: `${r.rev}${r.current ? ' (current)' : ''}` }),
                        h('td', { text: r.source === 'restore' && r.note ? r.note : `${SOURCE_LABEL[r.source] || r.source}${r.note ? `: ${r.note}` : ''}` }),
                        h('td', { text: r.model || r.actor }),
                        h('td', { text: when(r.at) }),
                        h('td', { class: 'num' }, h('span', { class: 'row end' }, actions)));
                })))));

        return h('div', {},
            h('header', {},
                h('p', { class: 'crumb' }, back),
                h('h1', { class: 'status', text: periodTitle(kind, period) }),
                h('p', { class: 'lede muted', text: byline })),
            viewingOld && h('p', { class: 'banner' }, `You are looking at revision ${d.rev}, not the current text. `,
                h('button', { class: 'link', type: 'button', text: 'Back to the current text', onclick: () => { state.viewRev = null; render(); } })),
            h('section', {},
                content,
                !state.editing && !viewingOld && !state.compare && h('div', { class: 'row actions' },
                    h('button', { class: 'btn', type: 'button', text: 'Edit', onclick: () => { state.editing = true; render(); } }),
                    h('button', { class: 'btn quiet', type: 'button', text: state.showHistory ? 'Hide history' : `History (${d.revisions} ${d.revisions === 1 ? 'revision' : 'revisions'})`, onclick: () => { state.showHistory = !state.showHistory; render(); } }))),
            !state.editing && d.meta && d.meta.sources && h('section', {},
                h('h2', { text: 'Sources used' }),
                h('dl', { class: 'facts' }, Object.entries(d.meta.sources).map(([name, status]) => fact(name, dot(status === 'ok' ? 'good' : 'warn'), status)))),
            history);
    }

    async function digests() {
        return state.digest ? digestDetail() : digestList();
    }

    const WHAT = {
        domain_enabled: (d) => `Turned on ${d && d.name ? d.name : 'a domain'}`,
        domain_disabled: (d) => `Turned off ${d && d.name ? d.name : 'a domain'}`,
        digest_edited: (d) => `Edited the ${d ? `${d.kind} digest for ${d.period}` : 'digest'}`,
        digest_restored: (d) => `Restored an older version of the ${d ? `${d.kind} digest for ${d.period}` : 'digest'}`,
        login: () => 'Signed in',
        logout: () => 'Signed out',
        login_failed: () => 'Tried a wrong key',
        key_created: (d) => `Created key ${d && d.name ? d.name : ''}${d && d.scopes ? ` (${d.scopes.join(', ')})` : ''}`,
        key_revoked: (d) => `Revoked key ${d && d.name ? d.name : ''}`,
        backup_run: () => 'Made a backup by hand',
    };

    const GROUPS = [
        ['all', 'Everything', null],
        ['signins', 'Sign-ins', ['login', 'logout', 'login_failed']],
        ['keys', 'Keys', ['key_created', 'key_revoked']],
        ['domains', 'Domains', ['domain_enabled', 'domain_disabled']],
        ['digests', 'Digests', ['digest_edited', 'digest_restored']],
        ['backups', 'Backups', ['backup_run']],
    ];

    async function activity() {
        const { events: all } = await api('/activity?limit=200');
        const group = GROUPS.find((g) => g[0] === state.activityFilter) || GROUPS[0];
        const events = group[2] ? all.filter((e) => group[2].includes(e.action)) : all;
        return h('div', {},
            h('header', {},
                h('h1', { class: 'status', text: 'Activity' }),
                h('p', { class: 'lede', text: 'Sign-ins, key and domain changes, digest edits and backups, newest first.' })),
            h('section', {},
                h('div', { class: 'row', role: 'group', 'aria-label': 'Filter activity' }, GROUPS.map(([id, label]) => h('button', {
                    class: `btn small ${state.activityFilter === id ? '' : 'quiet'}`,
                    type: 'button',
                    'aria-pressed': state.activityFilter === id ? 'true' : 'false',
                    text: label,
                    onclick: () => { state.activityFilter = id; render(); },
                }))),
                events.length
                    ? h('div', { class: 'table-wrap' }, h('table', {},
                        h('thead', {}, h('tr', {}, ['When', 'What', 'From'].map((t) => h('th', { text: t })))),
                        h('tbody', {}, events.map((e) => h('tr', {},
                            h('td', { text: when(e.at) }),
                            h('td', { text: (WHAT[e.action] || (() => e.action))(e.detail).trim() }),
                            h('td', { class: 'muted', text: e.ip || '' }))))))
                    : h('p', { class: 'muted', text: all.length ? 'Nothing of that kind in the recent events.' : 'Nothing has happened yet.' })));
    }

    const VIEW_FN = { overview, digests, keys, backups, portfolio, activity };

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
