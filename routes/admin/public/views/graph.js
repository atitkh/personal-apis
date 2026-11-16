// Graph: how your records connect, drawn like Obsidian's graph view. The start page (Global) is one big canvas of every linked
// record (a dot per record, coloured by domain, bigger with more links), with the most connected records and the records that
// have no link yet below it; Local shows one record and its neighbours (1 or 2 hops). Settings, domain toggles and search float
// over the canvas; a selected record gets a small card. A node can be dragged (positions only, nothing is saved).
//   #/graph                          start page: the whole graph, search, most connected records, unlinked records
//   #/graph?d=entities&i=9           that record's neighbourhood (?depth=1|2)
//   ?hide=lifelog,digests            hides those domains in either picture
//   ?hiderel=related,about           hides the links with those relation words (a soft hide: nothing moves)
//   ?at=2026-03-14                   the timeline's playhead: only what exists on that day shows (T opens the bar); absent = everything
// Links can be added and removed here, but only after turning on "Edit links" (pencil button, or E; it is off on every visit):
// drag from the ring around a record to another record, or press L on a record and pick another, or tap "Link from here" and
// then another record. Those use the same audited endpoints as the Linked panel on a record.
//   #/graph?u=trips                  the unlinked records of one domain on the start page
// Titles come from the server as text and go in as text. The picture is a drawn aid: the same connections are listed under it.
import { h, icon, chip, plural, emptyState, errorState, chipNav, domainHue } from '../ui.js';
import { href, navigate, setQuery } from '../router.js';
import { recordHref } from './recordHref.js';
import { createCanvas, seedFocused, seedOverview } from './graphCanvas.js';

const TITLE = { digests: 'Digests', deadlines: 'Deadlines', preferences: 'Preferences', places: 'Places', flights: 'Flights', trips: 'Trips', lifelog: 'Lifelog', portfolio: 'Portfolio', entities: 'Entities' };
const ONE = { digests: 'Digest', deadlines: 'Deadline', preferences: 'Preference', places: 'Place', flights: 'Flight', trips: 'Trip', lifelog: 'Lifelog', portfolio: 'Portfolio', entities: 'Entity' };
// `keep` carries the hidden domains and link types over to the next page: { hide, hiderel, at } (comma lists, and the timeline's playhead, or null).
const nodeHref = (n, keep) => href('graph', [], { d: n.domain, i: n.id, hide: (keep && keep.hide) || null, hiderel: (keep && keep.hiderel) || null, at: (keep && keep.at) || null });

const oneLabel = (d) => ONE[d] || d;
const hiddenFrom = (q) => new Set((q.get('hide') || '').split(',').filter(Boolean));
const hiddenRelFrom = (q) => new Set((q.get('hiderel') || '').split(',').filter(Boolean));
const hideText = (set) => [...set].join(',') || null;
const linkApi = (ctx) => ({
    create: (body) => ctx.api('/links', { method: 'POST', body }),
    remove: (id) => ctx.api(`/links/${id}`, { method: 'DELETE', body: { confirm: true } }),
});

// The Global | Local switch (and, in Local, how far: 1 or 2 steps). Local needs a record: in Global it waits for a selection.
function modes({ local, depth, center, keep, goLocal }) {
    const seg = (key, text, pressed, fn, extra) => h('button', { type: 'button', class: 'graph-seg-btn', 'data-key': key, 'aria-pressed': String(pressed), onclick: fn, ...extra }, text);
    const localBtn = seg('graph-local', 'Local', local, goLocal, local ? {} : { disabled: '', title: 'Select a record first' });
    const row = h('div', { class: 'graph-modes' },
        h('div', { class: 'graph-seg', role: 'group', 'aria-label': 'Graph scope' }, seg('graph-global', 'Global', !local, () => { if (local) navigate(href('graph', [], keep())); }), localBtn),
        local ? h('div', { class: 'graph-seg', role: 'group', 'aria-label': 'How far' }, [1, 2].map((n) => seg(`graph-depth-${n}`, n === 1 ? '1 step' : '2 steps', depth === n,
            () => { if (depth !== n) navigate(href('graph', [], { d: center.domain, i: center.id, depth: n === 1 ? null : n, ...keep() })); }))) : null);
    return { el: row, setLocal(ok) { if (!local) { localBtn.disabled = !ok; localBtn.title = ok ? 'Show just this record and its neighbours' : 'Select a record first'; } } };
}

// The card for the selected record or link. A record: what it is, its links (relation and direction, each one can be selected), and
// what you can do with it. A link: both ends (click either to jump), the relation in words, the note, and (editing only) Remove.
function details({ by, edges, centerKey, jump, close, keep, editing, selectEdge, linkFrom, removeLink }) {
    const card = h('aside', { class: 'graph-card', 'aria-label': 'Selected record', 'data-key': 'graph-card' });
    card.hidden = true;
    let now = null;   // { key } | { edge, confirm }
    const closeBtn = () => h('button', { type: 'button', class: 'graph-btn', 'aria-label': 'Close the details', title: 'Close (Esc)', 'data-key': 'graph-card-close', onclick: close }, icon('close'));
    const end = (k, label) => {
        const m = by.get(k);
        return m ? h('div', { class: 'graph-link-end' }, h('span', { class: 'muted', text: label }),
            h('button', { type: 'button', class: 'graph-near', 'data-key': `${label.toLowerCase()}:${m.key}`, onclick: () => jump(m.key) },
                h('span', { class: `graph-swatch hue-${domainHue(m.domain)}`, 'aria-hidden': 'true' }), h('span', { text: m.title }))) : null;
    };
    const showEdge = (e, confirm) => {
        const a = by.get(e.from); const b = by.get(e.to);
        card.setAttribute('aria-label', 'Selected link');
        const err = h('p', { class: 'error', 'data-key': 'graph-edge-error' });
        const remove = () => {
            const yes = h('button', { type: 'button', class: 'btn danger small', 'data-key': 'graph-edge-remove-yes', text: 'Remove' });
            yes.addEventListener('click', async () => {
                yes.disabled = true;
                try { await removeLink(e.id); } catch (x) { err.textContent = x.message; yes.disabled = false; }
            });
            return h('div', { class: 'graph-confirm', role: 'group', 'aria-label': 'Remove this link' },
                h('p', { text: 'Remove this link? It cannot be undone.' }),
                h('div', { class: 'graph-actions' }, yes, h('button', { type: 'button', class: 'btn quiet small', 'data-key': 'graph-edge-remove-no', onclick: () => showEdge(e, false), text: 'Keep' })), err);
        };
        card.replaceChildren(...[
            h('div', { class: 'graph-card-head' }, h('span', { class: 'chip' }, h('span', { text: 'Link' })), closeBtn()),
            h('p', { class: 'graph-card-meta muted', text: a && b ? `${a.title} —${e.rel}→ ${b.title}` : 'A link' }),
            h('div', { class: 'graph-link-ends' }, end(e.from, 'From'), h('p', { class: 'graph-link-rel', 'data-key': 'graph-edge-rel' }, h('span', { text: `—${e.rel}→` })), end(e.to, 'To')),
            e.note ? h('p', { class: 'graph-link-note', 'data-key': 'graph-edge-note', text: e.note }) : null,
            editing() ? (confirm ? remove() : h('div', { class: 'graph-actions' }, h('button', { type: 'button', class: 'btn quiet small', 'data-key': 'graph-edge-remove', onclick: () => showEdge(e, true), text: 'Remove link' }))) : null,
        ].filter(Boolean));
        if (confirm) { const k = card.querySelector('[data-key="graph-edge-remove-no"]'); if (k) k.focus(); }
    };
    const showNode = (key) => {
        const n = by.get(key);
        card.setAttribute('aria-label', 'Selected record');
        // one row per neighbour, with each link to it (relation and direction)
        const rows = new Map();
        for (const e of edges) {
            const other = e.from === key ? e.to : e.to === key ? e.from : null;
            if (!other || !by.get(other)) continue;
            (rows.get(other) || rows.set(other, []).get(other)).push({ e, out: e.from === key });
        }
        const near = [...rows.keys()].map((k) => by.get(k)).sort((a, b) => (b.degree || 0) - (a.degree || 0) || a.title.localeCompare(b.title));
        card.replaceChildren(...[
            h('div', { class: 'graph-card-head' }, chip(oneLabel(n.domain), { hue: domainHue(n.domain) }), closeBtn()),
            h('strong', { class: 'graph-card-title', text: n.title }),
            h('p', { class: 'graph-card-meta muted', text: [n.kind, n.date, plural(n.degree || 0, 'link') + (n.hidden ? `, ${n.hidden} more not shown` : '')].filter(Boolean).join(' · ') }),
            h('div', { class: 'graph-actions' },
                n.key === centerKey ? null : h('button', { type: 'button', class: 'btn small', 'data-key': 'graph-focus', onclick: () => navigate(nodeHref(n, keep())), text: 'Focus' }),
                h('a', { class: 'btn quiet small', href: recordHref(n.domain, n.id, { date: n.date, title: n.title }), text: 'Open record' }),
                editing() ? h('button', { type: 'button', class: 'btn quiet small', 'data-key': 'graph-link-from', onclick: () => linkFrom(n.key), text: 'Link from here' }) : null),
            near.length ? h('ul', { class: 'graph-card-near', 'aria-label': 'Connected records' }, near.slice(0, 6).map((m) => h('li', { class: 'graph-near-row' },
                h('button', { type: 'button', class: 'graph-near', 'data-key': `jump:${m.key}`, onclick: () => jump(m.key) },
                    h('span', { class: `graph-swatch hue-${domainHue(m.domain)}`, 'aria-hidden': 'true' }), h('span', { text: m.title })),
                h('span', { class: 'graph-rels-of' }, rows.get(m.key).map(({ e, out }) => h('button', { type: 'button', class: 'graph-relbtn', 'data-key': `edge:${e.id}`,
                    'aria-label': out ? `${n.title} ${e.rel} ${m.title}. Select this link.` : `${m.title} ${e.rel} ${n.title}. Select this link.`, title: 'Select this link', onclick: () => selectEdge(e.id),
                    text: out ? `${e.rel} →` : `← ${e.rel}` })))))) : null,
            near.length > 6 ? h('p', { class: 'muted graph-card-more', text: `and ${near.length - 6} more` }) : null,
        ].filter(Boolean));
    };
    const show = (key) => {
        const n = key && by.get(key);
        card.hidden = !n;
        now = n ? { key } : null;
        if (!n) { card.replaceChildren(); return; }
        showNode(key);
    };
    const showLink = (e, { confirm } = {}) => { now = { edge: e, confirm: Boolean(confirm) }; card.hidden = false; showEdge(e, Boolean(confirm)); };
    // Redraws what is shown (edit mode turned on or off, a link added or removed).
    const refresh = () => { if (!now) return; if (now.key) show(now.key); else showEdge(now.edge, now.confirm); };
    return { el: card, show, showLink, refresh };
}

function focused(ctx, g) {
    const q = ctx.route.query;
    const depth = g.depth;
    const hidden = hiddenFrom(q);
    const hiddenRel = hiddenRelFrom(q);
    let canvas;
    const keep = () => ({ hide: hideText(hidden), hiderel: hideText(hiddenRel), at: canvas && canvas.timeline ? canvas.timeline.at() : (ctx.route.query.get('at') || null) });
    const center = g.nodes.find((n) => n.key === g.center);
    const nodes = g.nodes.map((n) => ({ ...n }));
    const anchors = seedFocused(nodes, g.edges);
    const by = new Map(nodes.map((n) => [n.key, n]));
    const rowsList = h('ul', { class: 'graph-list' });
    const rowsTitle = h('h2', { id: 'g-list', class: 'section-title' });
    const rowsEmpty = emptyState({ title: 'Nothing is linked to this record yet.', text: 'Add a link from its page, or let the nightly update make some.', iconName: 'info' });
    const paintRows = () => {
        const rows = nodes.filter((n) => n.depth > 0 && !hidden.has(n.domain)).sort((a, b) => a.depth - b.depth || a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));
        rowsTitle.textContent = plural(rows.length, 'connected record');
        rowsList.replaceChildren(...rows.map((n) => h('li', {}, chip(oneLabel(n.domain), { hue: domainHue(n.domain) }), ' ',
            h('a', { class: 'link', href: nodeHref(n, keep()), text: n.title }), h('span', { class: 'muted', text: n.depth === 2 ? ' · two steps away' : '' }))));
        rowsList.hidden = !rows.length;
        rowsEmpty.hidden = rows.length > 0;
    };
    paintRows();
    const select = (k) => { canvas.setSelected(k); card.show(k); };
    const edgeOf = (id) => g.edges.find((e) => e.id === id);
    const card = details({ by, edges: g.edges, centerKey: g.center, keep, jump: (k) => { select(k); canvas.focusOn(k); }, close: () => { canvas.setSelected(null); card.show(null); },
        editing: () => canvas.isEditing(), selectEdge: (id) => { canvas.setSelectedEdge(id); card.showLink(edgeOf(id)); }, linkFrom: (k) => canvas.startLink(k), removeLink: (id) => canvas.removeLink(id) });
    const sw = modes({ local: true, depth, center, keep });
    const present = [...new Set(nodes.map((n) => n.domain))].sort().filter((d) => d !== center.domain || nodes.some((n) => n.domain === d && n.depth > 0));
    canvas = createCanvas({ nodes, edges: g.edges, anchors, centerKey: g.center, selected: g.center, hidden, hiddenRel, at: ctx.route.query.get('at'), onAt: (v) => setQuery({ at: v }), oneLabel, hudLeft: [sw.el], card: card.el, api: linkApi(ctx),
        groups: present.map((d) => ({ d, text: `${TITLE[d] || d} ${nodes.filter((n) => n.domain === d).length}` })),
        label: `Graph of ${plural(nodes.length, 'record')} and ${plural(g.edges.length, 'link')}. The same records are listed below.`,
        onSelect: select, onClear: () => { canvas.setSelected(null); card.show(null); },
        onSelectEdge: (e, opts) => card.showLink(e, opts), onEdit: () => card.refresh(), onEdges: () => card.refresh(),
        onFocus: (k) => { if (k !== g.center) navigate(nodeHref(by.get(k), keep())); },
        onHidden: (set) => { hidden.clear(); for (const d of set) hidden.add(d); setQuery({ hide: hideText(set) }); paintRows(); },
        onHiddenRel: (set) => { hiddenRel.clear(); for (const r of set) hiddenRel.add(r); setQuery({ hiderel: hideText(set) }); } });
    ctx.onCleanup(canvas.destroy);
    card.show(g.center);
    return h('div', { class: 'view graph graph-full' },
        canvas.el,
        h('div', { class: 'graph-below' },
            g.truncated ? h('p', { class: 'note', text: `Showing the first ${g.nodes.length} records; a busy record hides the rest of its links.` }) : null,
            h('section', { 'aria-labelledby': 'g-list' }, rowsTitle, rowsList, rowsEmpty)));
}

// The whole graph for the start page: every linked record, one picture.
function everything(ctx, ov) {
    if (!ov.nodes.length) return { el: emptyState({ title: 'No links yet.', text: 'Link records from their pages and the whole picture shows up here.', iconName: 'info' }), note: null };
    const hidden = hiddenFrom(ctx.route.query);
    const hiddenRel = hiddenRelFrom(ctx.route.query);
    let canvas;
    const keep = () => ({ hide: hideText(hidden), hiderel: hideText(hiddenRel), at: canvas && canvas.timeline ? canvas.timeline.at() : (ctx.route.query.get('at') || null) });
    const nodes = ov.nodes.map((n) => ({ ...n }));
    const anchors = seedOverview(nodes);
    const by = new Map(nodes.map((n) => [n.key, n]));
    let picked = null;
    const sw = modes({ local: false, depth: 1, center: null, keep, goLocal: () => { if (picked) navigate(nodeHref(by.get(picked), keep())); } });
    const select = (k) => { picked = k; canvas.setSelected(k); card.show(k); sw.setLocal(Boolean(k)); };
    const edgeOf = (id) => ov.edges.find((e) => e.id === id);
    const card = details({ by, edges: ov.edges, centerKey: null, keep, jump: (k) => { select(k); canvas.focusOn(k); }, close: () => select(null),
        editing: () => canvas.isEditing(), selectEdge: (id) => { picked = null; sw.setLocal(false); canvas.setSelectedEdge(id); card.showLink(edgeOf(id)); }, linkFrom: (k) => canvas.startLink(k), removeLink: (id) => canvas.removeLink(id) });
    canvas = createCanvas({ nodes, edges: ov.edges, anchors, centerKey: null, selected: null, hidden, hiddenRel, at: ctx.route.query.get('at'), onAt: (v) => setQuery({ at: v }), oneLabel, dense: nodes.length > 60, hudLeft: [sw.el], card: card.el, api: linkApi(ctx),
        groups: Object.keys(ov.domains).sort().map((d) => ({ d, text: `${TITLE[d] || d} ${ov.domains[d].shown}${ov.domains[d].total > ov.domains[d].shown ? `/${ov.domains[d].total}` : ''}` })),
        label: `Graph of ${plural(nodes.length, 'linked record')} and ${plural(ov.edges.length, 'link')}, grouped by domain. The most connected records are listed below.`,
        onSelect: select, onClear: () => select(null),
        onSelectEdge: (e, opts) => { picked = null; sw.setLocal(false); card.showLink(e, opts); }, onEdit: () => card.refresh(), onEdges: () => card.refresh(),
        onFocus: (k) => navigate(nodeHref(by.get(k), keep())),
        onHidden: (set) => { hidden.clear(); for (const d of set) hidden.add(d); setQuery({ hide: hideText(set) }); },
        onHiddenRel: (set) => { hiddenRel.clear(); for (const r of set) hiddenRel.add(r); setQuery({ hiderel: hideText(set) }); } });
    ctx.onCleanup(canvas.destroy);
    return { el: canvas.el, note: ov.leftOut ? h('p', { class: 'note', 'data-key': 'graph-left-out', text: `Showing the ${plural(ov.shown, 'most connected record')} of ${ov.shown + ov.leftOut}; ${ov.leftOut} less connected ${ov.leftOut === 1 ? 'record is' : 'records are'} left out. Search or pick a record below to see its own links.` }) : null };
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
    const map = everything(ctx, ov);
    return h('div', { class: `view graph${ov.nodes.length ? ' graph-full' : ''}` },
        map.el,
        h('div', { class: 'graph-below' }, map.note,
        h('div', { class: 'toolbar' }, h('div', { class: 'search-form' }, icon('search', 'search-icon'), search)), results,
        h('section', { 'aria-labelledby': 'g-hubs' }, h('h2', { id: 'g-hubs', class: 'section-title', text: 'Most connected' }),
            hubs.hubs.length ? h('ul', { class: 'graph-list' }, hubs.hubs.map((n) => h('li', {}, chip(oneLabel(n.domain), { hue: domainHue(n.domain) }), ' ',
                h('a', { class: 'link', href: nodeHref(n), text: n.title }), h('span', { class: 'muted', text: ` · ${plural(n.degree, 'link')}` }))))
                : h('p', { class: 'note', text: 'No record has a link yet.' })),
        h('section', { 'aria-labelledby': 'g-unl' }, h('h2', { id: 'g-unl', class: 'section-title', text: 'Not linked yet' }),
            h('p', { class: 'note', text: 'Records that no link points to or from. Pick a domain to list them (pages of 50).' }), unlNav,
            u ? (unl.records.length ? h('ul', { class: 'graph-list' }, unl.records.map((r) => h('li', {}, h('a', { class: 'link', href: recordHref(r.domain, r.id, { date: r.date, title: r.title }), text: r.title }),
                r.kind ? h('span', { class: 'muted', text: ` · ${r.kind}` }) : null, r.date ? h('span', { class: 'muted', text: ` · ${r.date}` }) : null)))
                : emptyState({ title: 'Everything here is linked.', iconName: 'good' })) : null)));
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
        return h('div', { class: 'view graph' },
            errorState({ err, what: 'That record', retry: () => ctx.rerender() }),
            h('p', {}, h('a', { class: 'btn quiet small', href: href('graph'), text: 'Start page' })));
    }
}
