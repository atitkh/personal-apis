// Portfolio inventory: entries, detail pages, missing and orphan files. The search lives in the URL
// (#/portfolio?q=...). Ported from the old app; stage 2 redoes it.
import { h, plural, ago, bytes, fact, dot } from '../ui.js';
import { setQuery } from '../router.js';

export async function render(ctx) {
    const p = await ctx.api('/portfolio');
    const problems = [];
    if (p.missingPages.length) problems.push(`Entries that expect a detail page but have none: ${p.missingPages.join(', ')}.`);
    if (p.orphanPages.length) problems.push(`Detail pages with no matching entry: ${p.orphanPages.join(', ')}.`);

    const body = h('tbody');
    const paint = (filter) => {
        const q = filter.trim().toLowerCase();
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

    return h('div', { class: 'legacy' },
        h('p', { class: 'lede', text: `${plural(p.entryCount, 'entry', 'entries')}, last edited ${ago(p.updatedAt)}. Changes to atit.json go live as soon as the file is saved.` }),
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
