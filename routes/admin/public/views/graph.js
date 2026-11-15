// Graph: how your records connect. A focused view of one record and its neighbours (1 or 2 hops), the most connected
// records to start from, and the records that have no link yet.
//   #/graph                          start page: search, most connected records, unlinked records
//   #/graph?d=entities&i=9           that record's neighbourhood (?depth=1|2, ?hide=lifelog,digests hides domains)
//   #/graph?u=trips                  the unlinked records of one domain on the start page
// Titles come from the server as text and go in as text. The picture is a drawn aid: the same connections are listed under it.
import { h, icon, button, chip, plural, emptyState, errorState, chipNav, domainHue, pageHeader } from '../ui.js';
import { href, navigate } from '../router.js';
import { recordHref } from './recordHref.js';

const TITLE = { digests: 'Digests', deadlines: 'Deadlines', preferences: 'Preferences', places: 'Places', flights: 'Flights', trips: 'Trips', lifelog: 'Lifelog', portfolio: 'Portfolio', entities: 'Entities' };
const ONE = { digests: 'Digest', deadlines: 'Deadline', preferences: 'Preference', places: 'Place', flights: 'Flight', trips: 'Trip', lifelog: 'Lifelog', portfolio: 'Portfolio', entities: 'Entity' };
const W = 920;
const H = 560;

const nodeHref = (n) => href('graph', [], { d: n.domain, i: n.id });
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// A small deterministic force layout: rings by depth to start, then repulsion between nodes and springs along links.
function layout(nodes, edges) {
    const cx = W / 2;
    const cy = H / 2;
    const by = new Map(nodes.map((n) => [n.key, n]));
    const kids = new Map();
    for (const e of edges) {
        const a = by.get(e.from);
        const b = by.get(e.to);
        if (!a || !b || a.depth === b.depth) continue;
        const [p, c] = a.depth < b.depth ? [a, b] : [b, a];
        if (c.parent == null) { c.parent = p.key; (kids.get(p.key) || kids.set(p.key, []).get(p.key)).push(c.key); }
    }
    const ring1 = nodes.filter((n) => n.depth === 1);
    ring1.forEach((n, i) => {
        const a = (i / Math.max(ring1.length, 1)) * Math.PI * 2 - Math.PI / 2 + 0.7;
        n.x = cx + Math.cos(a) * 150;
        n.y = cy + Math.sin(a) * 150;
        n.angle = a;
    });
    for (const n of nodes) {
        if (n.depth === 0) { n.x = cx; n.y = cy; } else if (n.depth >= 2) {
            const p = by.get(n.parent) || by.get(ring1[0] && ring1[0].key) || { x: cx, y: cy, angle: 0 };
            const sib = kids.get(n.parent) || [n.key];
            const spread = (sib.indexOf(n.key) - (sib.length - 1) / 2) * 0.28;
            const a = (p.angle || 0) + spread;
            n.angle = a;
            n.x = cx + Math.cos(a) * 270;
            n.y = cy + Math.sin(a) * 215;
        }
        n.vx = 0;
        n.vy = 0;
    }
    const pairs = edges.map((e) => [by.get(e.from), by.get(e.to)]).filter(([a, b]) => a && b);
    for (let step = 0; step < 220; step += 1) {
        const cool = 1 - step / 260;
        for (let i = 0; i < nodes.length; i += 1) {
            for (let j = i + 1; j < nodes.length; j += 1) {
                const a = nodes[i];
                const b = nodes[j];
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                const d2 = Math.max(dx * dx + dy * dy, 36);
                const f = 5200 / d2;
                const d = Math.sqrt(d2);
                dx /= d; dy /= d;
                a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
            }
        }
        for (const [a, b] of pairs) {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const f = (d - 120) * 0.035;
            a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
        }
        for (const n of nodes) {
            if (n.depth === 0) { n.x = cx; n.y = cy; continue; }
            n.vx += (cx - n.x) * 0.004;
            n.vy += (cy - n.y) * 0.004;
            n.x = Math.min(W - 70, Math.max(70, n.x + Math.max(-14, Math.min(14, n.vx * cool))));
            n.y = Math.min(H - 40, Math.max(40, n.y + Math.max(-14, Math.min(14, n.vy * cool))));
            n.vx *= 0.55; n.vy *= 0.55;
        }
    }
}

const svgEl = (name, attrs = {}, ...kids) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
    for (const k of kids.flat()) if (k != null) el.append(k);
    return el;
};

function picture(g, hidden, selectedKey, onSelect) {
    const nodes = g.nodes.filter((n) => n.depth === 0 || !hidden.has(n.domain));
    const keys = new Set(nodes.map((n) => n.key));
    const edges = g.edges.filter((e) => keys.has(e.from) && keys.has(e.to));
    const copy = nodes.map((n) => ({ ...n }));
    layout(copy, edges);
    const by = new Map(copy.map((n) => [n.key, n]));
    // Fit the view to the nodes (with room for labels) so a small graph is not lost in a big canvas.
    const xs = copy.map((n) => n.x);
    const ys = copy.map((n) => n.y);
    const bw = Math.max(Math.max(...xs) - Math.min(...xs) + 190, 560);
    const bh = Math.max(Math.max(...ys) - Math.min(...ys) + 120, 340);
    const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - bw / 2;
    const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - bh / 2 + 8;
    const svg = svgEl('svg', { class: 'graph-svg', viewBox: `${Math.round(vx)} ${Math.round(vy)} ${Math.round(bw)} ${Math.round(bh)}`, role: 'group', 'aria-label': `Graph of ${plural(copy.length, 'record')} and ${plural(edges.length, 'link')}. The same records are listed below.` });
    const lines = svgEl('g', { class: 'graph-edges' });
    for (const e of edges) {
        const a = by.get(e.from);
        const b = by.get(e.to);
        const on = e.from === selectedKey || e.to === selectedKey;
        lines.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `graph-edge${on ? ' is-on' : ''}` }, svgEl('title', {}, `${e.rel}`)));
    }
    svg.append(lines);
    for (const n of copy) {
        const r = n.depth === 0 ? 17 : 8 + Math.min(n.degree || 0, 8);
        const grp = svgEl('g', { class: `graph-node hue-${domainHue(n.domain)}${n.key === selectedKey ? ' is-selected' : ''}${n.depth === 0 ? ' is-center' : ''}`, tabindex: '0', role: 'button',
            'aria-label': `${ONE[n.domain] || n.domain}: ${n.title}. ${plural(n.degree || 0, 'link')}. Press Enter to select.`, 'data-key': `node:${n.key}` });
        grp.append(svgEl('circle', { cx: n.x, cy: n.y, r }),
            svgEl('text', { x: n.x, y: n.y + r + 13, 'text-anchor': 'middle' }, clipText(n.title, 26)),
            svgEl('title', {}, `${ONE[n.domain] || n.domain}: ${n.title}`));
        grp.addEventListener('click', () => onSelect(n.key));
        grp.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(n.key); } });
        svg.append(grp);
    }
    return svg;
}

function focused(ctx, g) {
    const q = ctx.route.query;
    const depth = g.depth;
    const hidden = new Set((q.get('hide') || '').split(',').filter(Boolean));
    const center = g.nodes.find((n) => n.key === g.center);
    let selected = g.center;
    const holder = h('div', { class: 'graph-canvas' });
    const info = h('div', { class: 'graph-info', 'aria-live': 'polite' });
    const draw = () => {
        holder.replaceChildren(picture(g, hidden, selected, (k) => { selected = k; draw(); }));
        const n = g.nodes.find((x) => x.key === selected);
        info.replaceChildren(...[
            chip(ONE[n.domain] || n.domain, { hue: domainHue(n.domain) }), ' ', h('strong', { text: n.title }),
            n.date ? h('span', { class: 'muted', text: ` ${n.date}` }) : null,
            h('span', { class: 'muted', text: ` · ${plural(n.degree || 0, 'link')}${n.hidden ? `, ${n.hidden} more not shown` : ''}` }),
            h('span', { class: 'graph-actions' },
                n.key === g.center ? null : h('a', { class: 'btn small', href: nodeHref(n), text: 'Center here' }),
                h('a', { class: 'btn quiet small', href: recordHref(n.domain, n.id, { date: n.date, title: n.title }), text: 'Open record' })),
        ].filter(Boolean));
    };
    draw();

    const present = [...new Set(g.nodes.map((n) => n.domain))].sort();
    const toggles = present.filter((d) => d !== center.domain || g.nodes.some((n) => n.domain === d && n.depth > 0)).map((d) => {
        const on = !hidden.has(d);
        return h('button', { type: 'button', class: 'chip-link graph-toggle', 'aria-pressed': String(on), 'data-key': `hide:${d}`, onclick: () => {
            const next = new Set(hidden);
            if (on) next.add(d); else next.delete(d);
            navigate(href('graph', [], { d: center.domain, i: center.id, depth: depth === 1 ? null : depth, hide: [...next].join(',') || null }), { replace: true });
        } }, on ? icon('check') : null, h('span', { text: `${TITLE[d] || d} ${g.nodes.filter((n) => n.domain === d).length}` }));
    });
    const depthNav = chipNav({ label: 'How far', current: String(depth), items: [1, 2].map((n) => ({ id: String(n), label: n === 1 ? 'Direct links' : 'Two steps', href: href('graph', [], { d: center.domain, i: center.id, depth: n === 1 ? null : n, hide: q.get('hide') || null }) })) });

    const rows = g.nodes.filter((n) => n.depth > 0 && !hidden.has(n.domain)).sort((a, b) => a.depth - b.depth || a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));
    return h('div', { class: 'view graph' },
        pageHeader({ lede: 'A record and what it connects to. Click a point to select it, then center the picture there or open the record.',
            actions: h('a', { class: 'btn quiet small', href: href('graph'), text: 'Start page' }) }),
        h('div', { class: 'toolbar filter-bar' }, depthNav, h('div', { class: 'graph-toggles', role: 'group', 'aria-label': 'Show these domains' }, toggles)),
        g.truncated ? h('p', { class: 'note', text: `Showing the first ${g.nodes.length} records; a busy record hides the rest of its links.` }) : null,
        holder, info,
        h('section', { 'aria-labelledby': 'g-list' },
            h('h2', { id: 'g-list', class: 'section-title', text: `${plural(rows.length, 'connected record')}` }),
            rows.length ? h('ul', { class: 'graph-list' }, rows.map((n) => h('li', {},
                chip(ONE[n.domain] || n.domain, { hue: domainHue(n.domain) }), ' ',
                h('a', { class: 'link', href: nodeHref(n), text: n.title }),
                h('span', { class: 'muted', text: n.depth === 2 ? ' · two steps away' : '' })))) : emptyState({ title: 'Nothing is linked to this record yet.', text: 'Add a link from its page, or let the nightly update make some.', iconName: 'info' })));
}

async function start(ctx) {
    const u = ctx.route.query.get('u') || '';
    const [hubs, unl] = await Promise.all([ctx.api('/graph/hubs?limit=12'), ctx.api(`/graph/unlinked${u ? `?domain=${encodeURIComponent(u)}&limit=50` : ''}`)]);
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
                results.replaceChildren(rows.length ? h('ul', { class: 'graph-list' }, rows.map((r) => h('li', {}, chip(ONE[r.domain] || r.domain, { hue: domainHue(r.domain) }), ' ',
                    h('a', { class: 'link', href: href('graph', [], { d: r.domain, i: r.id }), text: r.title })))) : h('p', { class: 'note', text: 'Nothing found.' }));
            } catch (e) { results.replaceChildren(h('p', { class: 'error', text: e.message })); }
        }, 250);
    });
    const counts = Object.entries(unl.counts);
    const unlNav = chipNav({ label: 'Unlinked records by domain', current: u || '', items: counts.map(([d, c]) => ({ id: d, label: `${TITLE[d] || d} ${c.unlinked}/${c.total}`, href: href('graph', [], { u: d }) })) });
    return h('div', { class: 'view graph' },
        pageHeader({ lede: 'How your records connect. Pick a record to see it with its neighbours.' }),
        h('div', { class: 'toolbar' }, h('div', { class: 'search-form' }, icon('search', 'search-icon'), search)), results,
        h('section', { 'aria-labelledby': 'g-hubs' }, h('h2', { id: 'g-hubs', class: 'section-title', text: 'Most connected' }),
            hubs.hubs.length ? h('ul', { class: 'graph-list' }, hubs.hubs.map((n) => h('li', {}, chip(ONE[n.domain] || n.domain, { hue: domainHue(n.domain) }), ' ',
                h('a', { class: 'link', href: nodeHref(n), text: n.title }), h('span', { class: 'muted', text: ` · ${plural(n.degree, 'link')}` }))))
                : emptyState({ title: 'No links yet.', text: 'Link records from their pages and they show up here.', iconName: 'info' })),
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
