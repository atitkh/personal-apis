// Passport map views. A view is a function (container, mapData, ctx) => { destroy() } that draws into `container`
// and returns a handle; destroy() must remove listeners, observers and timers it started (the Passport calls it
// before another view is mounted and when the page is left). Views are registered in MAP_VIEWS (id -> { label, render });
// a later stage replaces an entry with registerMapView(id, label, render).
//   mapData = GET /admin/api/flights/stats -> `map`: { airports: [{ iata, city, lat, lon, visits }], routes: [{ a, b, flights }] }
//             (airports the hub does not know are already left out; no flight numbers, dates or booking references)
//   ctx     = { home: IATA or null, unit: 'km'|'mi', year: '2026'|null, isDark() }
// Plain DOM and inline SVG, no libraries and no network. The map is equirectangular (x = longitude + 180,
// y = 90 - latitude), cropped to 84 N..58 S; the land outline is worldmap.js.
import { h, svg, plural } from './ui.js';
import { LAND } from './worldmap.js';

export const VIEW = { x: 0, y: 6, w: 360, h: 142 };
export const MAPVIEW_KEY = 'hub-flights-mapview';

/* ---------- shared drawing helpers ---------- */

// A route as a quadratic curve that bows north (as flat maps draw great circles). Shorter way round the
// globe: a route that crosses the date line is drawn off the edge and repeated on the other side.
export function arcPaths(a, b) {
    let x1 = a.lon + 180;
    let x2 = b.lon + 180;
    const y1 = 90 - a.lat;
    const y2 = 90 - b.lat;
    if (x2 - x1 > 180) x2 -= 360;
    else if (x1 - x2 > 180) x2 += 360;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - Math.min(35, Math.hypot(x2 - x1, y2 - y1) * 0.22);
    const at = (dx) => `M${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}Q${(mx + dx).toFixed(1)} ${my.toFixed(1)} ${(x2 + dx).toFixed(1)} ${y2.toFixed(1)}`;
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    const out = [at(0)];
    if (lo < 0) out.push(at(360));
    if (hi > 360) out.push(at(-360));
    return out;
}

function graticule() {
    const d = [];
    for (let lon = 0; lon <= 360; lon += 30) d.push(`M${lon} ${VIEW.y}V${VIEW.y + VIEW.h}`);
    for (let lat = 60; lat >= -30; lat -= 30) d.push(`M0 ${90 - lat}H360`);
    return d.join('');
}

const pctX = (a) => (((a.lon + 180) - VIEW.x) / VIEW.w) * 100;
const pctY = (a) => (((90 - a.lat) - VIEW.y) / VIEW.h) * 100;
const byVisits = (p, q) => q.visits - p.visits || (p.iata < q.iata ? -1 : 1);
const noop = { destroy() {} };

function frame(map, cls, ...layers) {
    return svg('svg', {
        class: `route-map ${cls}`.trim(),
        viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`,
        role: 'img',
        'aria-label': `Map of ${plural(map.routes.length, 'route')} between ${plural(map.airports.length, 'airport')}. The lists below carry the same numbers.`,
        preserveAspectRatio: 'xMidYMid meet',
    }, svg('path', { class: 'graticule', d: graticule() }), svg('path', { class: 'land', d: LAND }), ...layers);
}

/* ---------- flat ---------- */

// Greedy label placement. Labels come in busiest first; each tries above its dot, below, right, left, and is hidden
// when all four overlap a label already placed. Boxes are computed from the label size and the CSS offsets.
const SPOTS = [
    ['', (x, y, w, hh) => [x - w / 2, y - hh * 1.35]],
    ['pos-below', (x, y, w, hh) => [x - w / 2, y + hh * 0.35]],
    ['pos-right', (x, y, w, hh) => [x + 7, y - hh / 2]],
    ['pos-left', (x, y, w, hh) => [x - 7 - w, y - hh / 2]],
];
export function placeLabels(wrap, items) {
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (!W || !H) return;
    const placed = [];
    const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    for (const it of items) {
        const w = it.el.offsetWidth + 2;
        const hh = it.el.offsetHeight + 2;
        const x = (it.px / 100) * W;
        const y = (it.py / 100) * H;
        it.el.classList.remove('is-hidden', 'pos-below', 'pos-right', 'pos-left');
        let chosen = null;
        for (const [cls, at] of SPOTS) {
            const [l, t] = at(x, y, w, hh);
            const box = [l, t, l + w, t + hh];
            if (!placed.some((p) => hit(box, p))) { chosen = { cls, box }; break; }
        }
        if (!chosen) { it.el.classList.add('is-hidden'); continue; }
        if (chosen.cls) it.el.classList.add(chosen.cls);
        placed.push(chosen.box);
    }
}

export function flatView(container, map, ctx = {}) {
    const byCode = new Map(map.airports.map((a) => [a.iata, a]));
    const maxFlights = Math.max(1, ...map.routes.map((r) => r.flights));
    const arcs = [];
    for (const r of map.routes) {
        const a = byCode.get(r.a);
        const b = byCode.get(r.b);
        const strength = r.flights >= maxFlights * 0.66 ? 'strong' : r.flights > 1 ? 'mid' : 'weak';
        for (const d of arcPaths(a, b)) arcs.push(svg('path', { class: `arc arc-${strength}`, d }, svg('title', { text: `${r.a} to ${r.b}: ${plural(r.flights, 'flight')}` })));
    }
    const dots = map.airports.map((a) => svg('path', {
        class: `pt${a.iata === ctx.home ? ' pt-home' : ''}`,
        d: `M${(a.lon + 180).toFixed(1)} ${(90 - a.lat).toFixed(1)}h0`,
    }, svg('title', { text: `${a.iata}${a.city ? `, ${a.city}` : ''}: ${plural(a.visits, 'visit')}` })));

    // Labels for the busiest airports: HTML over the SVG so the text keeps its size on a phone.
    const wrap = h('div', { class: 'map-wrap', 'data-view': 'flat' }, frame(map, '', arcs, dots));
    const items = [];
    const busiest = map.airports.slice().sort((p, q) => (q.iata === ctx.home) - (p.iata === ctx.home) || byVisits(p, q)).slice(0, 12);
    for (const a of busiest) {
        const el = h('span', { class: `map-label${a.iata === ctx.home ? ' is-home' : ''}`, 'aria-hidden': 'true', 'data-iata': a.iata, text: a.iata });
        el.style.left = `${pctX(a)}%`;
        el.style.top = `${pctY(a)}%`;
        wrap.append(el);
        items.push({ el, px: pctX(a), py: pctY(a) });
    }
    container.append(wrap, h('p', { class: 'help', text: 'Each line is a route, drawn as a curve on a flat map; darker lines are flown more often. The dots are airports.' }));

    let watcher = null;
    if (typeof ResizeObserver === 'function') {
        watcher = new ResizeObserver(() => placeLabels(wrap, items));
        watcher.observe(wrap);
    } else placeLabels(wrap, items);
    return { destroy() { if (watcher) watcher.disconnect(); watcher = null; } };
}

/* ---------- globe (placeholder until the next stage) ---------- */

export function globePlaceholder(container) {
    container.append(h('div', { class: 'map-wrap map-soon', 'data-view': 'globe' },
        h('p', { class: 'muted', text: 'The globe view arrives with the next update.' })));
    return noop;
}

/* ---------- heat ---------- */

// Intensity of an airport: sqrt of its visits against the busiest airport (at least 4, so a lone flight is
// still a modest glow rather than the maximum), 0..1. Radius 3..13 map units, glow opacity .35..0.9.
export const heatLevel = (visits, max) => Math.min(1, Math.sqrt(visits / Math.max(max, 4)));
export const heatRadius = (level) => 3 + 10 * level;
export const heatOpacity = (level) => 0.35 + 0.55 * level;
// A route's stroke opacity: low, so crossings accumulate; a little stronger for a route flown many times.
export const heatRouteOpacity = (flights) => Math.min(0.4, 0.14 + 0.05 * (flights - 1));

export function heatView(container, map) {
    const maxVisits = Math.max(1, ...map.airports.map((a) => a.visits));
    const byCode = new Map(map.airports.map((a) => [a.iata, a]));
    const defs = svg('defs', {}, svg('radialGradient', { id: 'heat-glow' },
        svg('stop', { offset: '0%', style: 'stop-color:var(--teal);stop-opacity:.95' }),
        svg('stop', { offset: '35%', style: 'stop-color:var(--teal);stop-opacity:.5' }),
        svg('stop', { offset: '100%', style: 'stop-color:var(--teal);stop-opacity:0' })));
    const routes = [];
    for (const r of map.routes) {
        for (const d of arcPaths(byCode.get(r.a), byCode.get(r.b))) {
            routes.push(svg('path', { class: 'heat-route', d, style: `opacity:${heatRouteOpacity(r.flights).toFixed(2)}`, 'data-flights': r.flights }));
        }
    }
    const tip = h('div', { class: 'map-tip', role: 'tooltip', hidden: true });
    const wrap = h('div', { class: 'map-wrap', 'data-view': 'heat' });
    const glows = [];
    const spots = [];
    for (const a of map.airports.slice().sort((p, q) => p.visits - q.visits || (p.iata < q.iata ? 1 : -1))) {
        const level = heatLevel(a.visits, maxVisits);
        const r = heatRadius(level);
        const cx = a.lon + 180;
        const cy = 90 - a.lat;
        const label = `${a.iata}${a.city ? `, ${a.city}` : ''}: ${plural(a.visits, 'visit')}`;
        glows.push(svg('circle', {
            class: 'heat-glow', cx: cx.toFixed(1), cy: cy.toFixed(1), r: r.toFixed(1), fill: 'url(#heat-glow)',
            style: `opacity:${heatOpacity(level).toFixed(2)}`, 'data-iata': a.iata, 'data-visits': a.visits, 'data-level': level.toFixed(2),
        }));
        const spot = svg('circle', {
            class: 'heat-hit', cx: cx.toFixed(1), cy: cy.toFixed(1), r: Math.max(3, r * 0.55).toFixed(1), tabindex: '0', role: 'img',
            'aria-label': label, 'data-iata': a.iata,
        });
        const show = () => {
            tip.textContent = `${a.iata}${a.city ? ` · ${a.city}` : ''} · ${plural(a.visits, 'visit')}`;
            tip.style.left = `${pctX(a)}%`;
            tip.style.top = `${pctY(a)}%`;
            tip.hidden = false;
        };
        const hide = () => { tip.hidden = true; };
        spot.addEventListener('pointerenter', show);
        spot.addEventListener('pointerleave', hide);
        spot.addEventListener('focus', show);
        spot.addEventListener('blur', hide);
        spot.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
        spots.push(spot);
    }
    wrap.append(frame(map, 'heat-map', defs, svg('g', { class: 'heat-routes' }, routes), svg('g', { class: 'heat-glows' }, glows), svg('g', { class: 'heat-spots' }, spots)), tip);
    container.append(wrap,
        h('p', { class: 'help heat-legend' }, h('span', { class: 'heat-swatch', 'aria-hidden': 'true' }), ' Brighter = visited more'));
    return { destroy() { tip.hidden = true; } };
}

/* ---------- registry ---------- */

export const MAP_VIEWS = {
    flat: { label: 'Flat', render: flatView },
    globe: { label: 'Globe', render: globePlaceholder, soon: true },
    heat: { label: 'Heat', render: heatView },
};

// The next stage calls this to replace the globe placeholder.
export function registerMapView(id, label, render, { soon = false } = {}) {
    MAP_VIEWS[id] = { label, render, soon };
}

export const getMapView = () => {
    try {
        const v = localStorage.getItem(MAPVIEW_KEY);
        return MAP_VIEWS[v] ? v : 'flat';
    } catch (e) { return 'flat'; }
};
export const setMapView = (v) => {
    try { localStorage.setItem(MAPVIEW_KEY, v); } catch (e) { /* keep the default */ }
};

const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

// Clears `container` and draws view `id`; a view that throws leaves a short message instead of a broken page.
export function mountMapView(container, id, map, ctx = {}) {
    container.replaceChildren();
    const def = MAP_VIEWS[id] || MAP_VIEWS.flat;
    try {
        return def.render(container, map, { isDark, ...ctx }) || noop;
    } catch (e) {
        container.replaceChildren(h('p', { class: 'help warn-text', text: 'This map view could not be drawn.' }));
        return noop;
    }
}
