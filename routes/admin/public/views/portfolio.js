// Portfolio inventory: counts, a to-do list of missing and orphan detail pages, and the entries with a
// search that lives in the URL (#/portfolio?q=...). The data is routes/portfolio/atit/atit.json plus md/, img/, pdf/.
import { h, icon, button, plural, ago, when, bytes, emptyState } from '../ui.js';
import { setQuery } from '../router.js';

const DIR = 'routes/portfolio/atit';

function count(label, value, detail) {
    return h('div', { class: 'count' }, h('p', { class: 'count-value', text: value }), h('p', { class: 'count-label', text: label }), detail ? h('p', { class: 'count-detail', text: detail }) : null);
}

export async function render(ctx) {
    const p = await ctx.api('/portfolio');
    const byId = new Map(p.rows.map((r) => [String(r.id), r]));
    const todo = [
        ...p.missingPages.map((id) => {
            const r = byId.get(String(id));
            return { kind: 'missing', title: `Write the detail page for "${r ? r.title : id}"`, text: `Entry ${id} links to a detail page, but ${DIR}/md/${id}.md does not exist. Add the file, or remove "more" from the entry in atit.json.` };
        }),
        ...p.orphanPages.map((id) => ({ kind: 'orphan', title: `Page ${id}.md has no entry`, text: `${DIR}/md/${id}.md is not linked from any entry in atit.json. Add an entry with id ${id}, or delete the file.` })),
    ];
    const withPage = p.rows.filter((r) => r.hasPage).length;

    const body = h('tbody');
    const status = h('p', { class: 'note', 'aria-live': 'polite' });
    const paint = (filter) => {
        const q = filter.trim().toLowerCase();
        const shown = p.rows.filter((r) => !q || `${r.id} ${r.title} ${r.category}`.toLowerCase().includes(q));
        body.replaceChildren(...shown.map((r) => h('tr', {},
            h('td', { 'data-label': 'Id', class: 'num', text: String(r.id) }),
            h('td', { class: 'cell-main', text: r.title }),
            h('td', { 'data-label': 'Category', text: r.category || 'None' }),
            h('td', { 'data-label': 'Date', text: r.date }),
            h('td', { class: 'cell-side' }, r.hasPage
                ? (r.pageExists ? h('span', { class: 'state good' }, icon('good'), 'Page') : h('span', { class: 'state warn' }, icon('warn'), 'Missing'))
                : h('span', { class: 'muted', text: 'None' })))));
        if (!shown.length) {
            body.append(h('tr', {}, h('td', { colspan: '5' }, emptyState({
                title: `Nothing matches "${filter.trim()}".`,
                text: 'The search looks at ids, titles and categories.',
                action: button({ text: 'Clear the search', variant: 'quiet', size: 'small', onClick: () => { search.value = ''; search.dispatchEvent(new Event('input')); search.focus(); } }),
            }))));
        }
        status.textContent = q ? `${plural(shown.length, 'entry', 'entries')} match.` : '';
    };
    const initial = ctx.route.query.get('q') || '';
    paint(initial);

    const search = h('input', {
        type: 'search',
        id: 'p-filter',
        placeholder: 'Search by title, id or category',
        value: initial,
        'aria-label': 'Search entries',
        oninput: (event) => { paint(event.target.value); setQuery({ q: event.target.value || null }); },
    });

    return h('div', { class: 'view portfolio' },
        h('p', { class: 'lede', text: `The public portfolio site reads atit.json and its files directly; saving the file is publishing. Last edited ${ago(p.updatedAt)} (${when(p.updatedAt)}).` }),
        h('section', { class: 'counts', 'aria-label': 'Counts' },
            count('Entries', p.entryCount.toLocaleString(), `${withPage} with a detail page`),
            count('Detail pages', p.files.pages.count.toLocaleString(), bytes(p.files.pages.bytes)),
            count('Images', p.files.images.count.toLocaleString(), bytes(p.files.images.bytes)),
            count('PDFs', p.files.pdfs.count.toLocaleString(), bytes(p.files.pdfs.bytes)),
            count('To do', String(todo.length), todo.length ? 'see below' : 'nothing to fix')),
        h('section', { class: 'panel todo', 'aria-labelledby': 'p-todo' },
            h('h2', { id: 'p-todo', text: todo.length ? `To do (${todo.length})` : 'To do' }),
            todo.length
                ? h('ul', { class: 'todo-list' }, todo.map((t) => h('li', { class: `todo-item ${t.kind}` },
                    icon('warn'),
                    h('div', {}, h('p', { class: 'todo-title', text: t.title }), h('p', { class: 'todo-text', text: t.text })))))
                : emptyState({ title: 'Nothing to fix.', text: 'Every entry that links to a detail page has one, and every page belongs to an entry.', iconName: 'good' })),
        h('section', { 'aria-labelledby': 'p-entries' },
            h('div', { class: 'section-head' },
                h('h2', { id: 'p-entries', class: 'section-title', text: 'Entries' }),
                h('div', { class: 'search-form small' }, icon('search', 'search-icon'), search)),
            status,
            h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
                h('thead', {}, h('tr', {}, [['Id', 'num'], ['Title'], ['Category'], ['Date'], ['Detail page']].map(([t, c]) => h('th', { scope: 'col', class: c || null, text: t })))),
                body))));
}
