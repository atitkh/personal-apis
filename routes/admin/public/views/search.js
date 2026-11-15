// Search across every domain: #/search?q=hong+kong. Results are grouped by domain with a short snippet; each links to
// the record in its own page. The text is plain text (set with textContent, never as HTML).
import { h, icon, button, plural, emptyState, errorState, pageHeader } from '../ui.js';
import { setQuery } from '../router.js';
import { recordHref } from './recordHref.js';

function resultRow(r) {
    const open = recordHref(r.domain, r.id, { date: r.date, title: r.title });
    return h('li', { class: 'search-result' },
        h('a', { class: 'search-title link', href: open, text: r.title }),
        r.date ? h('span', { class: 'search-date note', text: r.date }) : null,
        r.kind ? h('span', { class: 'chip', text: r.kind }) : null,
        r.match === 'semantic' ? h('span', { class: 'chip', title: 'Found by meaning, not by the exact words', text: 'by meaning' }) : null,
        r.snippet ? h('p', { class: 'search-snippet note', text: r.snippet }) : null);
}

export async function render(ctx) {
    const q = (ctx.route.query.get('q') || '').trim();
    const input = h('input', { type: 'search', name: 'q', value: q, placeholder: 'Search every domain', 'aria-label': 'Search every domain', autocomplete: 'off', spellcheck: 'false', 'data-key': 'search-input' });
    const form = h('form', { class: 'search-form toolbar', role: 'search', onsubmit: (e) => {
        e.preventDefault();
        const next = input.value.trim();
        setQuery({ q: next || '' });
        ctx.rerender();
    } }, input, button({ text: 'Search', type: 'submit', iconName: 'search', 'data-key': 'search-go' }));

    const header = pageHeader({
        title: 'Search',
        lede: 'Look up anything across digests, deadlines, preferences, places, flights, trips, lifelog episodes, entities and the portfolio. Every word must appear. Raw lifelog lines are not searched here.',
    });

    let body;
    if (!q) {
        body = emptyState({ title: 'Type a few words.', text: 'Results are grouped by domain, with a short snippet around the match.', iconName: 'search' });
    } else {
        try {
            const out = await ctx.api(`/search?q=${encodeURIComponent(q)}&per_domain=10`);
            const note = out.semantic_error ? h('p', { class: 'note', text: `Meaning-based search is not available right now (${out.semantic_error}); showing keyword matches only.` }) : null;
            body = out.total
                ? h('div', { class: 'search-groups' }, note, out.groups.map((g) => h('section', { class: 'panel search-group', 'aria-labelledby': `sg-${g.domain}` },
                    h('h2', { id: `sg-${g.domain}`, class: 'section-title', text: `${g.title} (${g.count})` }),
                    h('ul', { class: 'search-list' }, g.results.map(resultRow)))))
                : emptyState({ title: `Nothing found for "${q}".`, text: 'Try fewer or shorter words. Booking references, document numbers and addresses are never searched.', iconName: 'search' });
        } catch (e) {
            body = errorState({ err: e, retry: () => ctx.rerender(), what: 'Search' });
        }
    }
    setTimeout(() => { if (!q && input.isConnected) input.focus(); }, 0);
    return h('div', { class: 'view search' }, header, form, body, h('span', { class: 'visually-hidden', 'aria-live': 'polite', text: q ? `Search results for ${q}` : '' }));
}
