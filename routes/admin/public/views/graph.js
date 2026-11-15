// Graph: how your records connect. The start page draws every linked record as one graph (coloured by domain, sized by how
// many links it has) above the most connected records and the records that have no link yet; a focused view shows one record
// and its neighbours (1 or 2 hops). Both can be zoomed, panned, hovered and selected; a node can be dragged (positions only).
//   #/graph                          start page: the whole graph, search, most connected records, unlinked records
//   #/graph?d=entities&i=9           that record's neighbourhood (?depth=1|2)
//   ?hide=lifelog,digests            hides those domains in either picture
//   #/graph?u=trips                  the unlinked records of one domain on the start page
// Titles come from the server as text and go in as text. The picture is a drawn aid: the same connections are listed under it.
import { h, icon, chip, plural, emptyState, errorState, chipNav, domainHue, pageHeader } from '../ui.js';
import { href, navigate, setQuery } from '../router.js';
import { recordHref } from './recordHref.js';
import { createCanvas, layoutFocused, layoutOverview } from './graphCanvas.js';

const TITLE = { digests: 'Digests', deadlines: 'Deadlines', preferences: 'Preferences', places: 'Places', flights: 'Flights', trips: 'Trips', lifelog: 'Lifelog', portfolio: 'Portfolio', entities: 'Entities' };
const ONE = { digests: 'Digest', deadlines: 'Deadline', preferences: 'Preference', places: 'Place', flights: 'Flight', trips: 'Trip', lifelog: 'Lifelog', portfolio: 'Portfolio', entities: 'Entity' };
const nodeHref = (n) => href('graph', [], { d: n.domain, i: n.id });

const oneLabel = (d) => ONE[d] || d;
const hiddenFrom = (q) => new Set((q.get('hide') || '').split(',').filter(Boolean));

// What the selected record is, with the two things you can do with it. `center` is the record the picture is centred on, if any.
function infoFor(n, center) {
    return [
        chip(oneLabel(n.domain), { hue: domainHue(n.domain) }), ' ', h('strong', { text: n.title }),
        n.date ? h('span', { class: 'muted', text: ` ${n.date}` }) : null,
        h('span', { class: 'muted', text: ` · ${plural(n.degree || 0, 'link')}${n.hidden ? `, ${n.hidden} more not shown` : ''}` }),
        h('span', { class: 'graph-actions' },
            n.key === center ? null : h('button', { type: 'button', class: 'btn small', 'data-key': 'graph-focus', onclick: () => navigate(nodeHref(n)), text: 'Focus' }),
            h('a', { class: 'btn quiet small', href: recordHref(n.domain, n.id, { date: n.date, title: n.title }), text: 'Open record' })),
    ].filter(Boolean);
}

// The domain legend, which is also the show/hide switch: one toggle per domain. `change(set)` is called with the hidden domains.
function legend(items, hidden, change) {
    const buttons = new Map();
    const paint = () => {
        for (const [d, b] of buttons) {
            const on = !hidden.has(d);
            b.setAttribute('aria-pressed', String(on));
            b.replaceChildren(on ? icon('check') : h('span', { class: 'graph-swatch', 'aria-hidden': 'true' }), h('span', { text: items.find((i) => i.d === d).text }));
        }
    };
    const row = h('div', { class: 'graph-toggles', role: 'group', 'aria-label': 'Show these domains' }, items.map(({ d }) => {
        const b = h('button', { type: 'button', class: `chip-link graph-toggle hue-${domainHue(d)}`, 'data-key': `hide:${d}`, onclick: () => {
            if (hidden.has(d)) hidden.delete(d); else hidden.add(d);
            paint();
            setQuery({ hide: [...hidden].join(',') || null });
            change(hidden);
        } });
        buttons.set(d, b);
        return b;
    }));
    paint();
    return row;
}

function focused(ctx, g) {
    const q = ctx.route.query;
    const depth = g.depth;
    const hidden = hiddenFrom(q);
    const center = g.nodes.find((n) => n.key === g.center);
    const nodes = g.nodes.map((n) => ({ ...n }));
    layoutFocused(nodes, g.edges);
    const by = new Map(nodes.map((n) => [n.key, n]));
    const info = h('div', { class: 'graph-info', 'aria-live': 'polite' });
    const showInfo = (key) => info.replaceChildren(...infoFor(by.get(key), g.center));
    const canvas = createCanvas({ nodes, edges: g.edges, centerKey: g.center, selected: g.center, hidden, oneLabel,
        label: `Graph of ${plural(nodes.length, 'record')} and ${plural(g.edges.length, 'link')}. The same records are listed below.`,
        onSelect: (k) => { canvas.setSelected(k); showInfo(k); },
        onFocus: (k) => { if (k !== g.center) navigate(nodeHref(by.get(k))); } });
    ctx.onCleanup(canvas.destroy);
    showInfo(g.center);

    const rowsList = h('ul', { class: 'graph-list' });
    const rowsTitle = h('h2', { id: 'g-list', class: 'section-title' });
    const rowsEmpty = emptyState({ title: 'Nothing is linked to this record yet.', text: 'Add a link from its page, or let the nightly update make some.', iconName: 'info' });
    const paintRows = () => {
        const rows = nodes.filter((n) => n.depth > 0 && !hidden.has(n.domain)).sort((a, b) => a.depth - b.depth || a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));
        rowsTitle.textContent = plural(rows.length, 'connected record');
        rowsList.replaceChildren(...rows.map((n) => h('li', {}, chip(oneLabel(n.domain), { hue: domainHue(n.domain) }), ' ',
            h('a', { class: 'link', href: nodeHref(n), text: n.title }), h('span', { class: 'muted', text: n.depth === 2 ? ' · two steps away' : '' }))));
        rowsList.hidden = !rows.length;
        rowsEmpty.hidden = rows.length > 0;
    };
    paintRows();

    const present = [...new Set(nodes.map((n) => n.domain))].sort().filter((d) => d !== center.domain || nodes.some((n) => n.domain === d && n.depth > 0));
    const toggles = legend(present.map((d) => ({ d, text: `${TITLE[d] || d} ${nodes.filter((n) => n.domain === d).length}` })), hidden, (set) => { canvas.setHidden(set); paintRows(); });
    const depthNav = chipNav({ label: 'How far', current: String(depth), items: [1, 2].map((n) => ({ id: String(n), label: n === 1 ? 'Direct links' : 'Two steps', href: href('graph', [], { d: center.domain, i: center.id, depth: n === 1 ? null : n, hide: q.get('hide') || null }) })) });
    return h('div', { class: 'view graph' },
        pageHeader({ lede: 'A record and what it connects to. Click a point to select it; double-click or press Focus to center the picture on it. Scroll to zoom, drag to move around.',
            actions: h('a', { class: 'btn quiet small', href: href('graph'), text: 'Start page' }) }),
        h('div', { class: 'toolbar filter-bar' }, depthNav, toggles),
        g.truncated ? h('p', { class: 'note', text: `Showing the first ${g.nodes.length} records; a busy record hides the rest of its links.` }) : null,
        canvas.el, info,
        h('section', { 'aria-labelledby': 'g-list' }, rowsTitle, rowsList, rowsEmpty));
}

// The whole graph for the start page: every linked record, one picture.
function everything(ctx, ov) {
    if (!ov.nodes.length) return emptyState({ title: 'No links yet.', text: 'Link records from their pages and the whole picture shows up here.', iconName: 'info' });
    const hidden = hiddenFrom(ctx.route.query);
    const nodes = ov.nodes.map((n) => ({ ...n }));
    layoutOverview(nodes, ov.edges);
    const by = new Map(nodes.map((n) => [n.key, n]));
    const info = h('div', { class: 'graph-info', 'aria-live': 'polite' }, h('span', { class: 'muted', text: 'Click a point to see what it is. Double-click it, or press Focus, to see just its neighbours.' }));
    const canvas = createCanvas({ nodes, edges: ov.edges, centerKey: null, selected: null, hidden, oneLabel, dense: nodes.length > 60,
        label: `Graph of ${plural(nodes.length, 'linked record')} and ${plural(ov.edges.length, 'link')}, grouped by domain. The most connected records are listed below.`,
        onSelect: (k) => { canvas.setSelected(k); info.replaceChildren(...infoFor(by.get(k), null)); },
        onFocus: (k) => navigate(nodeHref(by.get(k))) });
    ctx.onCleanup(canvas.destroy);
    const items = Object.keys(ov.domains).sort().map((d) => ({ d, text: `${TITLE[d] || d} ${ov.domains[d].shown}${ov.domains[d].total > ov.domains[d].shown ? `/${ov.domains[d].total}` : ''}` }));
    return h('div', { class: 'graph-overview' },
        h('div', { class: 'toolbar filter-bar' }, legend(items, hidden, (set) => canvas.setHidden(set))),
        ov.leftOut ? h('p', { class: 'note', 'data-key': 'graph-left-out', text: `Showing the ${plural(ov.shown, 'most connected record')} of ${ov.shown + ov.leftOut}; ${ov.leftOut} less connected ${ov.leftOut === 1 ? 'record is' : 'records are'} left out. Search or pick a record below to see its own links.` }) : null,
        canvas.el, info);
}

async function start(ctx) {
    const u = ctx.route.query.get('u') || '';
    const [ov, hubs, unl] = await Promise.all([ctx.api('/graph/overview'), ctx.api('/graph/hubs?limit=12'), ctx.api(`/graph/unlinked${u ? `?domain=${encodeURIComponent(u)}&limit=50` : ''}`)]);
    const search = h('input', { type: 'search', name: 'q', placeholder: 'Find a record to start from', 'aria-label': 'Find a record to start from', autocomplete: 'off', 'data-key': 'g-search' });
    const results = h('div', { class: 'graph-results', 'aria-live': 'polite' });
    let timer = null;
    search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const text = search.value.trim();
            if (text.length < 2) { results.replaceChildren(); return; }
            try {
                const out = await ctx.api(`/search?q=${encodeURIComponent(text)}&per_domain=4&mode=keyword`);
                const rows = out.groups.flatMap((g) => g.results.map((r) => ({ ...r, domain: g.domain })));
                results.replaceChildren(rows.length ? h('ul', { class: 'graph-list' }, rows.map((r) => h('li', {}, chip(oneLabel(r.domain), { hue: domainHue(r.domain) }), ' ',
                    h('a', { class: 'link', href: href('graph', [], { d: r.domain, i: r.id }), text: r.title })))) : h('p', { class: 'note', text: 'Nothing found.' }));
            } catch (e) { results.replaceChildren(h('p', { class: 'error', text: e.message })); }
        }, 250);
    });
    const counts = Object.entries(unl.counts);
    const unlNav = chipNav({ label: 'Unlinked records by domain', current: u || '', items: counts.map(([d, c]) => ({ id: d, label: `${TITLE[d] || d} ${c.unlinked}/${c.total}`, href: href('graph', [], { u: d }) })) });
    return h('div', { class: 'view graph' },
        pageHeader({ lede: 'How your records connect: everything that has a link, colored by domain. Scroll to zoom, drag to move around, hover a point to see its links.' }),
        everything(ctx, ov),
        h('div', { class: 'toolbar' }, h('div', { class: 'search-form' }, icon('search', 'search-icon'), search)), results,
        h('section', { 'aria-labelledby': 'g-hubs' }, h('h2', { id: 'g-hubs', class: 'section-title', text: 'Most connected' }),
            hubs.hubs.length ? h('ul', { class: 'graph-list' }, hubs.hubs.map((n) => h('li', {}, chip(oneLabel(n.domain), { hue: domainHue(n.domain) }), ' ',
                h('a', { class: 'link', href: nodeHref(n), text: n.title }), h('span', { class: 'muted', text: ` · ${plural(n.degree, 'link')}` }))))
                : h('p', { class: 'note', text: 'No record has a link yet.' })),
        h('section', { 'aria-labelledby': 'g-unl' }, h('h2', { id: 'g-unl', class: 'section-title', text: 'Not linked yet' }),
            h('p', { class: 'note', text: 'Records that no link points to or from. Pick a domain to list them (pages of 50).' }), unlNav,
            u ? (unl.records.length ? h('ul', { class: 'graph-list' }, unl.records.map((r) => h('li', {}, h('a', { class: 'link', href: recordHref(r.domain, r.id, { date: r.date, title: r.title }), text: r.title }),
                r.kind ? h('span', { class: 'muted', text: ` · ${r.kind}` }) : null, r.date ? h('span', { class: 'muted', text: ` · ${r.date}` }) : null)))
                : emptyState({ title: 'Everything here is linked.', iconName: 'good' })) : null));
}

export async function render(ctx) {
    const d = ctx.route.query.get('d');
    const i = ctx.route.query.get('i');
    if (!d || !i) return start(ctx);
    try {
        const depth = ctx.route.query.get('depth') === '2' ? 2 : 1;
        const g = await ctx.api(`/graph?domain=${encodeURIComponent(d)}&id=${encodeURIComponent(i)}&depth=${depth}`);
        return focused(ctx, g);
    } catch (err) {
        return h('div', { class: 'view graph' }, pageHeader({ lede: 'How your records connect.' }),
            errorState({ err, what: 'That record', retry: () => ctx.rerender() }),
            h('p', {}, h('a', { class: 'btn quiet small', href: href('graph'), text: 'Start page' })));
    }
}
