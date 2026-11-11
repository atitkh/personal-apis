// Passport map views. A view is a function (container, mapData, ctx) => { destroy() } that draws into `container`
// and returns a handle; destroy() must remove listeners, observers and timers it started (the Passport calls it
// before another view is mounted and when the page is left). Views are registered in MAP_VIEWS (id -> { label, render });
// a later stage replaces an entry with registerMapView(id, label, render).
//   mapData = GET /admin/api/flights/stats -> `map`: { airports: [{ iata, city, lat, lon, visits }], routes: [{ a, b, flights }] }
//             (airports the hub does not know are already left out; no flight numbers, dates or booking references)
//   ctx     = { home: IATA or null, unit: 'km'|'mi', year: '2026'|null, isDark() }
// The admin CSP forbids style attributes: styling goes through classes, SVG presentation attributes or el.style.
// Plain DOM and inline SVG, no libraries and no network. The map is equirectangular (x = longitude + 180,
// y = 90 - latitude), cropped to 84 N..58 S; the land outline is worldmap.js.
import { h, svg, plural } from './ui.js';
import { LAND } from './worldmap.js';
import { GLOBE_LAND, GLOBE_LAKES, landRings } from './globedata.js';
import { project, clipRing, lineRuns, routeRuns, pathData, midpoint, wrapLon, clampLat, clampZoom } from './globe.js';

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
// `size` ({ w, h }) and each item's { w, h } may be cached by the caller (the globe lays labels out every frame);
// an item with `off` set (behind the globe) is hidden.
export function placeLabels(wrap, items, size = null) {
    const W = size ? size.w : wrap.clientWidth;
    const H = size ? size.h : wrap.clientHeight;
    if (!W || !H) return;
    const placed = [];
    const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    for (const it of items) {
        const w = it.w || it.el.offsetWidth + 2;
        const hh = it.h || it.el.offsetHeight + 2;
        const x = (it.px / 100) * W;
        const y = (it.py / 100) * H;
        it.el.classList.remove('is-hidden', 'pos-below', 'pos-right', 'pos-left');
        if (it.off) { it.el.classList.add('is-hidden'); continue; }
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

/* ---------- globe ---------- */

// An orthographic globe in a 500 x 500 SVG, redrawn from globe.js geometry when it turns (no frames while idle).
// Drag (mouse, pen, touch) turns it, the wheel, pinch and the +/- buttons zoom (0.8x..2.5x), double-click, Reset or
// Home returns to the home airport; arrow keys turn it when focused. It spins slowly until touched (Spin resumes);
// prefers-reduced-motion means no spin and no inertia. Rotation, zoom and spin are kept for the page's life, so the
// year switcher redraws without losing the view. The wrap carries data-lon/-lat/-zoom/-spin for tests.
const G = { size: 500, radius: 205, spin: -0.006, friction: 0.92, keyStep: 10, zoomStep: 1.2 };
const globeMemo = { rot: null, zoom: 1, spin: true };
export const resetGlobeMemo = () => Object.assign(globeMemo, { rot: null, zoom: 1, spin: true });
let landCache = null;

function graticuleLines() {
    const lines = [];
    for (let lon = -180; lon < 180; lon += 30) {
        const l = [];
        for (let lat = -80; lat <= 80; lat += 4) l.push([lon, lat]);
        lines.push(l);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        const l = [];
        for (let lon = -180; lon <= 180; lon += 4) l.push([lon, lat]);
        lines.push(l);
    }
    return lines;
}

export function globeView(container, map, ctx = {}) {
    if (!landCache) landCache = { land: landRings(GLOBE_LAND), lakes: landRings(GLOBE_LAKES), grat: graticuleLines() };
    const { land, lakes, grat } = landCache;
    const byCode = new Map(map.airports.map((a) => [a.iata, a]));
    const maxFlights = Math.max(1, ...map.routes.map((r) => r.flights));
    const maxVisits = Math.max(1, ...map.airports.map((a) => a.visits));
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const homeAirport = byCode.get(ctx.home) || map.airports.slice().sort(byVisits)[0] || null;
    const homeRot = () => (homeAirport ? { lon: homeAirport.lon, lat: clampLat(homeAirport.lat) } : midpoint(map.airports));
    const rot = globeMemo.rot ? { ...globeMemo.rot } : (byCode.get(ctx.home) ? homeRot() : midpoint(map.airports));
    let zoom = clampZoom(globeMemo.zoom);
    let spin = globeMemo.spin && !reduced && map.airports.length > 0;
    const vel = { lon: 0, lat: 0 };
    let inertia = false;
    const C = G.size / 2;

    const ocean = svg('circle', { class: 'globe-ocean', cx: C, cy: C });
    const gratPath = svg('path', { class: 'graticule globe-grat' });
    const landPath = svg('path', { class: 'land globe-land' });
    const lakePath = svg('path', { class: 'globe-lake' });
    const rim = svg('circle', { class: 'globe-rim', cx: C, cy: C });
    const arcs = map.routes.filter((r) => byCode.has(r.a) && byCode.has(r.b)).map((r) => {
        const strength = r.flights >= maxFlights * 0.66 ? 'strong' : r.flights > 1 ? 'mid' : 'weak';
        const el = svg('path', { class: `arc arc-${strength}`, 'data-route': `${r.a}-${r.b}` }, svg('title', { text: `${r.a} to ${r.b}: ${plural(r.flights, 'flight')}` }));
        return { r, el, a: byCode.get(r.a), b: byCode.get(r.b) };
    });
    const tip = h('div', { class: 'map-tip', role: 'tooltip', hidden: true });
    let tipFor = null;
    const dots = map.airports.slice().sort((p, q) => p.visits - q.visits).map((a) => {
        const label = `${a.iata}${a.city ? `, ${a.city}` : ''}: ${plural(a.visits, 'visit')}`;
        const dot = svg('circle', { class: `globe-dot${a === homeAirport && a.iata === ctx.home ? ' is-home' : ''}`, 'data-iata': a.iata });
        const hit = svg('circle', { class: 'globe-hit', tabindex: '0', role: 'img', 'aria-label': label, 'data-iata': a.iata });
        const show = () => { tipFor = it; tip.textContent = `${a.iata}${a.city ? ` · ${a.city}` : ''} · ${plural(a.visits, 'visit')}`; placeTip(); };
        const hide = () => { if (tipFor === it) { tipFor = null; tip.hidden = true; } };
        hit.addEventListener('pointerenter', show);
        hit.addEventListener('pointerleave', hide);
        hit.addEventListener('focus', show);
        hit.addEventListener('blur', hide);
        hit.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
        const it = { a, dot, hit, r: Math.min(9, 3 + 1.6 * Math.sqrt(a.visits / maxVisits) * 3), x: 0, y: 0, front: false };
        return it;
    });
    const stage = svg('svg', {
        class: 'route-map globe-map', viewBox: `0 0 ${G.size} ${G.size}`, tabindex: '0', role: 'img',
        'aria-label': `Globe of ${plural(arcs.length, 'route')} and ${plural(map.airports.length, 'airport')}. Drag or use the arrow keys to turn it; the lists below carry the same numbers.`,
    }, ocean, gratPath, landPath, lakePath, rim, svg('g', { class: 'globe-arcs' }, arcs.map((x) => x.el)),
    svg('g', { class: 'globe-dots' }, dots.map((x) => x.dot)), svg('g', { class: 'globe-hits' }, dots.map((x) => x.hit)));
    const wrap = h('div', { class: 'map-wrap globe-wrap', 'data-view': 'globe' }, stage, tip);
    const labels = dots.slice().sort((p, q) => (q.a.iata === ctx.home) - (p.a.iata === ctx.home) || byVisits(p.a, q.a)).slice(0, 12).map((d) => {
        const el = h('span', { class: `map-label${d.a.iata === ctx.home ? ' is-home' : ''}`, 'aria-hidden': 'true', 'data-iata': d.a.iata, text: d.a.iata });
        wrap.append(el);
        return { el, d, px: 0, py: 0, w: 0, h: 0, off: true };
    });
    const btn = (text, aria, onClick, extra = {}) => {
        const b = h('button', { type: 'button', class: 'btn quiet small', text, 'aria-label': aria, ...extra });
        b.addEventListener('click', onClick);
        return b;
    };
    const spinBtn = btn('Spin', 'Spin the globe', () => setSpin(!spin), { 'aria-pressed': 'false', 'data-key': 'globe-spin' });
    const controls = h('div', { class: 'globe-controls', role: 'group', 'aria-label': 'Globe controls' },
        btn('−', 'Zoom out', () => setZoom(zoom / G.zoomStep), { 'data-key': 'globe-out' }),
        btn('+', 'Zoom in', () => setZoom(zoom * G.zoomStep), { 'data-key': 'globe-in' }),
        btn('Reset', 'Back to the home airport', () => reset(), { 'data-key': 'globe-reset' }),
        spinBtn);
    container.append(wrap, controls,
        h('p', { class: 'help', text: map.airports.length
            ? 'Drag to turn the globe, scroll or use + and − to zoom, double-click or Reset to return home. Lines are routes, lifted off the surface; bigger dots are visited more.'
            : 'No flights to draw yet: routes appear on the globe once a flight has departed.' }));

    let box = null;
    function measure() {
        const w = wrap.clientWidth;
        if (!w) return;
        box = { w, h: wrap.clientHeight || w };
        for (const l of labels) { l.w = l.el.offsetWidth + 2; l.h = l.el.offsetHeight + 2; }
        dirty = true;
        schedule();
    }
    function placeTip() {
        if (!tipFor) return;
        if (!tipFor.front) { tip.hidden = true; return; }
        tip.style.left = `${(tipFor.x / G.size) * 100}%`;
        tip.style.top = `${(tipFor.y / G.size) * 100}%`;
        tip.hidden = false;
    }

    function draw() {
        dirty = false;
        const R = G.radius * zoom;
        ocean.setAttribute('r', R.toFixed(1));
        rim.setAttribute('r', R.toFixed(1));
        gratPath.setAttribute('d', pathData(grat.flatMap((l) => lineRuns(l, rot)), C, C, R, false));
        landPath.setAttribute('d', pathData(land.flatMap((r) => clipRing(r, rot)), C, C, R, true));
        lakePath.setAttribute('d', pathData(lakes.flatMap((r) => clipRing(r, rot)), C, C, R, true));
        for (const x of arcs) x.el.setAttribute('d', pathData(routeRuns(x.a, x.b, rot), C, C, R, false));
        for (const d of dots) {
            const v = project(d.a.lon, d.a.lat, rot);
            d.front = v[2] > 0.02;
            d.x = C + R * v[0];
            d.y = C - R * v[1];
            d.dot.setAttribute('cx', d.x.toFixed(1));
            d.dot.setAttribute('cy', d.y.toFixed(1));
            d.dot.setAttribute('r', (d.r * (0.8 + 0.2 * zoom)).toFixed(1));
            d.hit.setAttribute('cx', d.x.toFixed(1));
            d.hit.setAttribute('cy', d.y.toFixed(1));
            d.hit.setAttribute('r', Math.max(8, d.r * 1.4).toFixed(1));
            d.dot.classList.toggle('is-back', !d.front);
            d.hit.classList.toggle('is-back', !d.front);
            d.depth = v[2];
        }
        for (const l of labels) {
            l.off = !l.d.front || l.d.depth < 0.15 || l.d.x < 0 || l.d.x > G.size || l.d.y < 0 || l.d.y > G.size;
            l.px = (l.d.x / G.size) * 100;
            l.py = (l.d.y / G.size) * 100;
            if (!l.off) { l.el.style.left = `${l.px}%`; l.el.style.top = `${l.py}%`; }
        }
        if (box) placeLabels(wrap, labels, box);
        placeTip();
        globeMemo.rot = { ...rot };
        globeMemo.zoom = zoom;
        wrap.dataset.lon = rot.lon.toFixed(2);
        wrap.dataset.lat = rot.lat.toFixed(2);
        wrap.dataset.zoom = zoom.toFixed(2);
        wrap.dataset.spin = spin ? 'on' : 'off';
    }

    // Frames only while something moves: spin, inertia, or a pending redraw.
    let dirty = true;
    let raf = 0;
    let last = 0;
    let alive = true;
    function schedule() { if (!raf && alive && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick); }
    function tick(t) {
        raf = 0;
        const dt = last ? Math.min(64, t - last) : 16;
        let moving = false;
        if (spin && !drag) {
            rot.lon = wrapLon(rot.lon + G.spin * dt);
            dirty = moving = true;
        } else if (inertia && !drag) {
            rot.lon = wrapLon(rot.lon + vel.lon * dt);
            rot.lat = clampLat(rot.lat + vel.lat * dt);
            const f = Math.pow(G.friction, dt / 16);
            vel.lon *= f;
            vel.lat *= f;
            inertia = Math.hypot(vel.lon, vel.lat) > 0.0005;
            dirty = moving = true;
        }
        if (dirty) draw();
        last = moving ? t : 0;
        if (moving) schedule();
    }
    const redraw = () => { dirty = true; schedule(); };
    function setSpin(on) {
        spin = on;
        globeMemo.spin = on;
        if (on) inertia = false;
        spinBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        wrap.dataset.spin = on ? 'on' : 'off';
        redraw();
    }
    function setZoom(z) { zoom = clampZoom(z); redraw(); }
    function reset() {
        Object.assign(rot, homeRot());
        zoom = 1;
        inertia = false;
        redraw();
    }
    const stopMotion = () => { if (spin) setSpin(false); inertia = false; };

    // Pointer drag and pinch.
    const pointers = new Map();
    let drag = null;
    const degPerPx = () => 180 / (Math.PI * G.radius * zoom * ((wrap.clientWidth || G.size) / G.size));
    const onDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        stopMotion();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
        drag = { t: e.timeStamp, pinch: pointers.size === 2 ? pinchDist() : 0 };
        vel.lon = 0;
        vel.lat = 0;
    };
    const pinchDist = () => { const [p, q] = [...pointers.values()]; return Math.hypot(p.x - q.x, p.y - q.y); };
    const onMove = (e) => {
        const p = pointers.get(e.pointerId);
        if (!p || !drag) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;
        if (pointers.size >= 2) {
            const d = pinchDist();
            if (drag.pinch) setZoom(zoom * (d / drag.pinch));
            drag.pinch = d;
            return;
        }
        const k = degPerPx();
        rot.lon = wrapLon(rot.lon - dx * k);
        rot.lat = clampLat(rot.lat + dy * k);
        const dt = Math.max(1, e.timeStamp - drag.t);
        drag.t = e.timeStamp;
        vel.lon = 0.5 * vel.lon + 0.5 * ((-dx * k) / dt);
        vel.lat = 0.5 * vel.lat + 0.5 * ((dy * k) / dt);
        redraw();
    };
    const onUp = (e) => {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size) { if (drag) drag.pinch = pointers.size === 2 ? pinchDist() : 0; return; }
        const recent = drag && e.timeStamp - drag.t < 80;
        drag = null;
        inertia = !reduced && recent && Math.hypot(vel.lon, vel.lat) > 0.002;
        if (inertia) { last = 0; schedule(); }
    };
    const onWheel = (e) => {
        e.preventDefault();
        stopMotion();
        setZoom(zoom * Math.exp(-e.deltaY * 0.0015));
    };
    const onKey = (e) => {
        const turn = { ArrowLeft: [-G.keyStep, 0], ArrowRight: [G.keyStep, 0], ArrowUp: [0, G.keyStep], ArrowDown: [0, -G.keyStep] }[e.key];
        if (turn) {
            stopMotion();
            rot.lon = wrapLon(rot.lon + turn[0]);
            rot.lat = clampLat(rot.lat + turn[1]);
            redraw();
        } else if (e.key === '+' || e.key === '=') { stopMotion(); setZoom(zoom * G.zoomStep); } else if (e.key === '-' || e.key === '_') { stopMotion(); setZoom(zoom / G.zoomStep); } else if (e.key === 'Home') { stopMotion(); reset(); } else return;
        e.preventDefault();
    };
    const onDbl = (e) => { e.preventDefault(); stopMotion(); reset(); };
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('keydown', onKey);
    stage.addEventListener('dblclick', onDbl);

    let watcher = null;
    if (typeof ResizeObserver === 'function') {
        watcher = new ResizeObserver(measure);
        watcher.observe(wrap);
    }
    spinBtn.setAttribute('aria-pressed', spin ? 'true' : 'false');
    draw();
    if (spin) schedule();
    return {
        destroy() {
            alive = false;
            if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
            raf = 0;
            if (watcher) watcher.disconnect();
            watcher = null;
            stage.removeEventListener('pointerdown', onDown);
            stage.removeEventListener('pointermove', onMove);
            stage.removeEventListener('pointerup', onUp);
            stage.removeEventListener('pointercancel', onUp);
            stage.removeEventListener('wheel', onWheel);
            stage.removeEventListener('keydown', onKey);
            stage.removeEventListener('dblclick', onDbl);
            tip.hidden = true;
        },
    };
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
        svg('stop', { class: 'heat-stop', offset: '0%', 'stop-opacity': '.95' }),
        svg('stop', { class: 'heat-stop', offset: '35%', 'stop-opacity': '.5' }),
        svg('stop', { class: 'heat-stop', offset: '100%', 'stop-opacity': '0' })));
    const routes = [];
    for (const r of map.routes) {
        for (const d of arcPaths(byCode.get(r.a), byCode.get(r.b))) {
            routes.push(svg('path', { class: 'heat-route', d, opacity: heatRouteOpacity(r.flights).toFixed(2), 'data-flights': r.flights }));
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
            opacity: heatOpacity(level).toFixed(2), 'data-iata': a.iata, 'data-visits': a.visits, 'data-level': level.toFixed(2),
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
    globe: { label: 'Globe', render: globeView },
    heat: { label: 'Heat', render: heatView },
};

// Replaces or adds a view (soon: true only dims its button).
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
