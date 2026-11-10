// Digests: list and search (#/digests?kind=weekly&q=...), reader with edit, history, compare and restore
// (#/digests/daily/2026-11-08). Ported as is from the old single-file app; stage 2 redesigns it.
import { h, when, fact, dot, emptyState, toast } from '../ui.js';
import { href, navigate } from '../router.js';

const SOURCE_LABEL = { generated: 'Generated', import: 'Imported', edit: 'Edited', restore: 'Restored' };

// Detail state, reset whenever another digest opens.
let detail = { id: null, viewRev: null, editing: false, showHistory: false, compare: null, confirmRestore: null };

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

function sourceHealth(meta) {
    const src = meta && meta.sources;
    if (!src || typeof src !== 'object') return h('span', { class: 'muted', text: 'Not recorded' });
    const names = Object.keys(src);
    const ok = names.filter((k) => src[k] === 'ok').length;
    const bad = names.filter((k) => src[k] === 'failed').length;
    return [dot(bad ? 'warn' : 'good'), `${ok} of ${names.length} sources${bad ? `, ${bad} failed` : ''}`];
}

async function list(ctx) {
    const kind = ctx.route.query.get('kind') === 'weekly' ? 'weekly' : 'daily';
    const q = (ctx.route.query.get('q') || '').trim();
    const data = await ctx.api(`/digests?${q ? `q=${encodeURIComponent(q)}&` : ''}kind=${kind}&limit=200`);
    const open = (k, p) => href('digests', [k, p]);

    const kindSwitch = h('div', { class: 'row', role: 'group', 'aria-label': 'Kind of digest' },
        [['daily', 'Daily'], ['weekly', 'Weekly']].map(([k, label]) => h('a', {
            class: `btn small ${kind === k ? '' : 'quiet'}`,
            href: href('digests', [], { kind: k === 'daily' ? null : k }),
            'aria-current': kind === k ? 'true' : null,
            text: label,
        })));

    const input = h('input', { type: 'search', id: 'd-search', value: q, placeholder: 'Search the text of every digest', 'aria-label': 'Search digests' });
    const search = h('form', {
        class: 'row',
        role: 'search',
        onsubmit: (event) => { event.preventDefault(); navigate(href('digests', [], { kind: kind === 'daily' ? null : kind, q: input.value.trim() })); },
    }, input, h('button', { class: 'btn quiet', type: 'submit', text: 'Search' }),
    q ? h('a', { class: 'btn quiet', href: href('digests', [], { kind: kind === 'daily' ? null : kind }), text: 'Clear' }) : null);

    let body;
    if (q) {
        body = data.results.length
            ? h('ul', { class: 'results' }, data.results.map((r) => h('li', {},
                h('a', { class: 'link', href: open(r.kind, r.period), text: periodTitle(r.kind, r.period) }),
                h('p', { class: 'muted' }, highlight(r.snippet)))))
            : emptyState({ title: `Nothing matches "${q}".`, text: 'Try fewer or different words. Search looks at every revision of every digest.' });
    } else if (data.digests.length) {
        body = h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Day', 'Version', 'Sources', 'Length'].map((t) => h('th', { text: t, class: t === 'Length' ? 'num' : null })))),
            h('tbody', {}, data.digests.map((d) => h('tr', {},
                h('td', {}, h('a', { class: 'link', href: open(d.kind, d.period), text: periodTitle(d.kind, d.period) })),
                h('td', { text: `${SOURCE_LABEL[d.source] || d.source}${d.rev > 1 ? `, revision ${d.rev}` : ''}` }),
                h('td', {}, sourceHealth(d.meta)),
                h('td', { class: 'num', text: `${d.chars.toLocaleString()} characters` }))))));
    } else {
        body = emptyState({ title: `No ${kind} digests yet.`, text: kind === 'daily' ? 'The nightly job publishes one each day at 11 PM.' : 'The weekly review publishes one each Sunday.' });
    }

    return h('div', { class: 'legacy' },
        h('p', { class: 'lede', text: 'Written each night from your day, and each week from the days. You can read, correct and search them here.' }),
        h('section', {}, h('div', { class: 'toolbar' }, kindSwitch, search)),
        h('section', {}, body));
}

async function reader(ctx, kind, period) {
    const id = `${kind}/${period}`;
    if (detail.id !== id) detail = { id, viewRev: null, editing: false, showHistory: false, compare: null, confirmRestore: null };
    const st = detail;
    const render = () => ctx.rerender();
    const base = `/digests/${encodeURIComponent(kind)}/${encodeURIComponent(period)}`;
    const d = await ctx.api(`${base}${st.viewRev ? `?rev=${st.viewRev}` : ''}`);
    const viewingOld = st.viewRev && d.rev !== d.revisions;

    const back = h('a', { class: 'link', href: href('digests', [], { kind: kind === 'daily' ? null : kind }), text: 'All digests' });
    const byline = `${SOURCE_LABEL[d.source] || d.source}${d.model ? ` by ${d.model}` : d.actor ? ` by ${d.actor}` : ''} on ${when(d.revisedAt)}${d.note && d.source !== 'restore' ? `. Note: ${d.note}` : d.note ? `. ${d.note}` : ''}`;

    let content;
    if (st.editing) {
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
                    await ctx.api(base, { method: 'PATCH', body: { body: area.value, note: note.value } });
                    st.editing = false;
                    toast('Digest saved');
                    render();
                } catch (err) {
                    error.textContent = err.message;
                    save.disabled = false;
                }
            },
        }, area, note, error, h('div', { class: 'row' }, save,
            h('button', { class: 'btn quiet', type: 'button', text: 'Cancel', onclick: () => { st.editing = false; render(); } })));
        setTimeout(() => area.focus(), 0);
    } else if (st.compare) {
        const older = await ctx.api(`${base}?rev=${st.compare}`);
        const parts = diffParagraphs(older.body, d.body);
        content = h('div', {},
            h('p', { class: 'banner' }, `Comparing revision ${older.rev} with the current text (revision ${d.rev}). `,
                h('button', { class: 'link', type: 'button', text: 'Close comparison', onclick: () => { st.compare = null; render(); } })),
            h('div', { class: 'diff' }, parts.map(([kindOf, text]) => h('p', { class: kindOf, text }))));
    } else {
        content = h('div', { class: 'digest-body reading' }, d.body.split(/\n{2,}/).map((para) => h('p', { text: para.trim() })));
    }

    const history = st.showHistory && h('section', {},
        h('h3', { text: 'History' }),
        h('p', { class: 'note', text: 'Revision 1 is what first arrived and is never changed. Restoring adds a new revision with the old text.' }),
        h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Revision', 'What', 'Who', 'When', ''].map((t) => h('th', { text: t })))),
            h('tbody', {}, d.history.map((r) => {
                const actions = [];
                if (!r.current) {
                    actions.push(h('button', { class: 'btn quiet small', type: 'button', text: 'View', onclick: () => { st.viewRev = r.rev; st.compare = null; st.editing = false; render(); } }));
                    actions.push(h('button', { class: 'btn quiet small', type: 'button', text: 'Compare', onclick: () => { st.viewRev = null; st.compare = r.rev; st.editing = false; render(); } }));
                    actions.push(st.confirmRestore === r.rev
                        ? h('button', {
                            class: 'btn danger small',
                            type: 'button',
                            text: 'Yes, restore',
                            onclick: async () => {
                                try {
                                    await ctx.api(`${base}/restore`, { method: 'POST', body: { rev: r.rev } });
                                    toast(`Revision ${r.rev} restored`);
                                } catch (err) {
                                    toast(`Could not restore. ${err.message}`, { kind: 'bad' });
                                }
                                st.confirmRestore = null; st.viewRev = null; st.compare = null; render();
                            },
                        })
                        : h('button', { class: 'btn quiet small', type: 'button', text: 'Restore', onclick: () => { st.confirmRestore = r.rev; render(); } }));
                }
                return h('tr', {},
                    h('td', { text: `${r.rev}${r.current ? ' (current)' : ''}` }),
                    h('td', { text: r.source === 'restore' && r.note ? r.note : `${SOURCE_LABEL[r.source] || r.source}${r.note ? `: ${r.note}` : ''}` }),
                    h('td', { text: r.model || r.actor }),
                    h('td', { text: when(r.at) }),
                    h('td', { class: 'num' }, h('span', { class: 'row end' }, actions)));
            })))));

    return h('div', { class: 'legacy' },
        h('header', { class: 'view-head' },
            h('p', { class: 'crumb' }, back),
            h('h2', { class: 'view-title', text: periodTitle(kind, period) }),
            h('p', { class: 'muted', text: byline })),
        viewingOld && h('p', { class: 'banner' }, `You are looking at revision ${d.rev}, not the current text. `,
            h('button', { class: 'link', type: 'button', text: 'Back to the current text', onclick: () => { st.viewRev = null; render(); } })),
        h('section', {},
            content,
            !st.editing && !viewingOld && !st.compare && h('div', { class: 'row actions' },
                h('button', { class: 'btn', type: 'button', text: 'Edit', onclick: () => { st.editing = true; render(); } }),
                h('button', { class: 'btn quiet', type: 'button', 'aria-expanded': String(st.showHistory), text: st.showHistory ? 'Hide history' : `History (${d.revisions} ${d.revisions === 1 ? 'revision' : 'revisions'})`, onclick: () => { st.showHistory = !st.showHistory; render(); } }))),
        !st.editing && d.meta && d.meta.sources && h('section', {},
            h('h3', { text: 'Sources used' }),
            h('dl', { class: 'facts' }, Object.entries(d.meta.sources).map(([name, status]) => fact(name, dot(status === 'ok' ? 'good' : 'warn'), status)))),
        history);
}

export function render(ctx) {
    const [kind, period] = ctx.route.parts;
    if (kind && period) return reader(ctx, kind, period);
    detail.id = null;
    return list(ctx);
}
