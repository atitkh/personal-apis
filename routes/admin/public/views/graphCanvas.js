// The Graph page's drawing: two deterministic layouts and an interactive SVG canvas (wheel/pinch zoom, drag to pan, drag a
// node, hover to highlight, click to select, double-click to focus). The view is a viewBox driven by pan/zoom state; node
// positions live in memory only and nothing is saved. No libraries.
import { h, svg, domainHue, plural } from '../ui.js';

const BASE_W = 920;     // world units across the canvas at zoom 1
const BASE_H = 560;
const K_MIN = 0.15;
const K_MAX = 6;
const DRAG_PX = 5;      // a press that moves less than this is a tap
const DOUBLE_MS = 350;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- layouts (positions are written onto the node objects) ----

// A focused record: rings by depth to start, then repulsion between nodes and springs along links.
export function layoutFocused(nodes, edges) {
    const cx = BASE_W / 2;
    const cy = BASE_H / 2;
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
            n.x += Math.max(-14, Math.min(14, n.vx * cool));
            n.y += Math.max(-14, Math.min(14, n.vy * cool));
            n.vx *= 0.55; n.vy *= 0.55;
        }
    }
}

// The whole graph: every domain gets an anchor on a ring, its nodes start in a spiral around it (busiest in the middle), and
// the forces are repulsion, link springs and a pull to the anchor. No randomness, so the picture is the same on every visit.
// It stops when nothing moves any more, and never runs more than MAX_STEPS (400 nodes: about 100 ms).
const MAX_STEPS = 220;
export function layoutOverview(nodes, edges) {
    const n = nodes.length;
    if (!n) return;
    const doms = [...new Set(nodes.map((x) => x.domain))].sort();
    const spread = 38 * Math.sqrt(Math.max(n, 4));
    const ring = doms.length > 1 ? spread * 0.7 : 0;
    const anchor = new Map(doms.map((d, i) => {
        const a = (i / doms.length) * Math.PI * 2 - Math.PI / 2;
        return [d, { x: BASE_W / 2 + Math.cos(a) * ring, y: BASE_H / 2 + Math.sin(a) * ring * 0.8 }];
    }));
    const order = [...nodes].sort((a, b) => a.domain.localeCompare(b.domain) || (b.degree || 0) - (a.degree || 0) || (a.key < b.key ? -1 : 1));
    const seen = {};
    for (const nd of order) {
        const i = seen[nd.domain] || 0;
        seen[nd.domain] = i + 1;
        const a = i * 2.39996;
        const r = 11 * Math.sqrt(i + 0.5);
        const p = anchor.get(nd.domain);
        nd.x = p.x + Math.cos(a) * r;
        nd.y = p.y + Math.sin(a) * r;
        nd.vx = 0;
        nd.vy = 0;
    }
    const idx = new Map(nodes.map((x, i) => [x.key, i]));
    const ends = edges.map((e) => [idx.get(e.from), idx.get(e.to)]).filter(([a, b]) => a != null && b != null);
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);
    const CUT2 = 190 * 190;
    for (let step = 0; step < MAX_STEPS; step += 1) {
        const cool = Math.max(0.08, 1 - step / MAX_STEPS);
        fx.fill(0); fy.fill(0);
        for (let i = 0; i < n; i += 1) {
            const a = nodes[i];
            for (let j = i + 1; j < n; j += 1) {
                const b = nodes[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const d2 = dx * dx + dy * dy;
                if (d2 > CUT2) continue;
                const dd = Math.max(d2, 49);
                const f = 2600 / dd / Math.sqrt(dd);
                fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
            }
        }
        for (const [i, j] of ends) {
            const a = nodes[i];
            const b = nodes[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const f = (d - 50) * 0.04 / d;
            fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
        }
        let moved = 0;
        for (let i = 0; i < n; i += 1) {
            const a = nodes[i];
            const p = anchor.get(a.domain);
            fx[i] += (p.x - a.x) * 0.007;
            fy[i] += (p.y - a.y) * 0.007;
            a.vx = (a.vx + fx[i]) * 0.55;
            a.vy = (a.vy + fy[i]) * 0.55;
            const sx = clamp(a.vx * cool, -16, 16);
            const sy = clamp(a.vy * cool, -16, 16);
            a.x += sx; a.y += sy;
            moved = Math.max(moved, Math.abs(sx) + Math.abs(sy));
        }
        if (step > 30 && moved < 0.15) break;
    }
}

// ---- the canvas ----

// o: { nodes (with x, y), edges, centerKey, selected, hidden (Set of domains), dense, label, oneLabel(domain),
//      onSelect(key), onFocus(key) } -> { el, setSelected, setHidden, fit, zoomBy, destroy }
export function createCanvas(o) {
    const { nodes, edges } = o;
    const dense = Boolean(o.dense);
    const by = new Map(nodes.map((n) => [n.key, n]));
    const adj = new Map(nodes.map((n) => [n.key, new Set()]));
    const inc = new Map(nodes.map((n) => [n.key, []]));
    const nodeEls = new Map();
    const edgeEls = [];
    const view = { cx: BASE_W / 2, cy: BASE_H / 2, k: 1 };
    let hidden = new Set(o.hidden || []);
    let selected = o.selected || null;
    let hovered = null;
    let tween = 0;
    let last = { key: null, t: 0 };

    const root = svg('svg', { class: `graph-svg${dense ? ' is-dense' : ''}`, viewBox: `0 0 ${BASE_W} ${BASE_H}`, role: 'group', 'aria-label': o.label });
    const gEdges = svg('g', { class: 'graph-edges' });
    const gNodes = svg('g', { class: 'graph-nodes' });
    const tip = h('div', { class: 'graph-tip', role: 'presentation' });
    tip.hidden = true;
    const button = (text, label, key, fn) => h('button', { type: 'button', class: 'btn quiet small', 'aria-label': label, 'data-key': key, onclick: fn }, text);
    const tools = h('div', { class: 'graph-tools', role: 'group', 'aria-label': 'Zoom' },
        button('+', 'Zoom in', 'graph-zoom-in', () => zoomBy(1.4)), button('−', 'Zoom out', 'graph-zoom-out', () => zoomBy(1 / 1.4)),
        button('Reset view', 'Reset the view to fit everything', 'graph-fit', () => fit(true)));
    const el = h('div', { class: `graph-canvas${dense ? ' is-dense' : ''}` }, root, tip, tools);

    for (const e of edges) {
        const a = by.get(e.from);
        const b = by.get(e.to);
        if (!a || !b) continue;
        const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'graph-edge' }, dense ? null : svg('title', {}, e.rel));
        const item = { el: line, a: a.key, b: b.key };
        edgeEls.push(item);
        inc.get(a.key).push(item); inc.get(b.key).push(item);
        adj.get(a.key).add(b.key); adj.get(b.key).add(a.key);
        gEdges.append(line);
    }
    const topKeys = new Set([...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, dense ? 40 : nodes.length).map((n) => n.key));
    const radius = (n) => (n.key === o.centerKey ? 17 : dense ? 4 + Math.min(Math.sqrt(n.degree || 0) * 2.4, 13) : 8 + Math.min(n.degree || 0, 8));
    // Drawn from the least to the most connected, so the busy records sit on top of their neighbours.
    for (const n of [...nodes].sort((a, b) => (a.degree || 0) - (b.degree || 0))) {
        const r = radius(n);
        const hub = dense && (n.degree || 0) >= 4;
        const g = svg('g', { class: `graph-node hue-${domainHue(n.domain)}${n.key === o.centerKey ? ' is-center' : ''}${hub ? ' is-hub' : ''}`, transform: `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`,
            tabindex: topKeys.has(n.key) ? '0' : '-1', role: 'button', 'data-key': `node:${n.key}`,
            'aria-label': `${o.oneLabel(n.domain)}: ${n.title}. ${plural(n.degree || 0, 'link')}. Press Enter to select, Shift and Enter to focus on it.` },
        svg('circle', { r }), svg('text', { y: r + 13, 'text-anchor': 'middle' }, clipText(n.title, 26)));
        n.r = r;
        nodeEls.set(n.key, g);
        gNodes.append(g);
    }
    root.append(gEdges, gNodes);

    // -- view state --
    const dims = () => {
        const r = root.getBoundingClientRect();
        const w = r.width || BASE_W;
        const hh = r.height || (w * BASE_H) / BASE_W;
        const vw = BASE_W / view.k;
        return { r, w, hh, vw, vh: (vw * hh) / w };
    };
    const apply = () => {
        const d = dims();
        root.setAttribute('viewBox', `${(view.cx - d.vw / 2).toFixed(2)} ${(view.cy - d.vh / 2).toFixed(2)} ${d.vw.toFixed(2)} ${d.vh.toFixed(2)}`);
        root.style.setProperty('--ls', clamp(1 / view.k, 0.7, 1.8).toFixed(2));
        root.dataset.zoom = view.k.toFixed(3);
        root.classList.toggle('show-labels', view.k >= 1.5);
        if (hovered) placeTip(hovered);
    };
    const toWorld = (px, py) => {
        const d = dims();
        return { x: view.cx - d.vw / 2 + ((px - d.r.left) / d.w) * d.vw, y: view.cy - d.vh / 2 + ((py - d.r.top) / d.hh) * d.vh };
    };
    const zoomAt = (px, py, factor) => {
        const k = clamp(view.k * factor, K_MIN, K_MAX);
        if (k === view.k) return;
        const before = toWorld(px, py);
        view.k = k;
        const after = toWorld(px, py);
        view.cx += before.x - after.x;
        view.cy += before.y - after.y;
        apply();
    };
    const panBy = (dxPx, dyPx) => {
        const d = dims();
        view.cx -= (dxPx / d.w) * d.vw;
        view.cy -= (dyPx / d.hh) * d.vh;
        apply();
    };
    const goTo = (to, animate) => {
        cancelAnimationFrame(tween);
        if (!animate || reduced()) { Object.assign(view, to); apply(); return; }
        const from = { ...view };
        const t0 = performance.now();
        const step = (now) => {
            const t = Math.min((now - t0) / 220, 1);
            const e = 1 - (1 - t) ** 3;
            view.cx = from.cx + (to.cx - from.cx) * e;
            view.cy = from.cy + (to.cy - from.cy) * e;
            view.k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
            apply();
            if (t < 1) tween = requestAnimationFrame(step);
        };
        tween = requestAnimationFrame(step);
    };
    const zoomBy = (factor) => goTo({ cx: view.cx, cy: view.cy, k: clamp(view.k * factor, K_MIN, K_MAX) }, true);
    const fit = (animate) => {
        const shown = nodes.filter((n) => !isHidden(n));
        if (!shown.length) { goTo({ cx: BASE_W / 2, cy: BASE_H / 2, k: 1 }, animate); return; }
        const xs = shown.map((n) => n.x);
        const ys = shown.map((n) => n.y);
        const x0 = Math.min(...xs); const x1 = Math.max(...xs);
        const y0 = Math.min(...ys); const y1 = Math.max(...ys);
        const bw = Math.max(x1 - x0 + 150, dense ? 400 : 560);
        const bh = Math.max(y1 - y0 + 110, dense ? 280 : 340);
        const d = dims();
        const k = clamp(Math.min(BASE_W / bw, (BASE_W * d.hh) / (d.w * bh)), K_MIN, K_MAX);
        goTo({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 + 8, k }, animate);
    };
    const isHidden = (n) => hidden.has(n.domain) && n.key !== o.centerKey;

    // -- highlight --
    let lit = [];
    const placeTip = (key) => {
        const n = by.get(key);
        const d = dims();
        const box = el.getBoundingClientRect();
        const sx = d.r.left - box.left + ((n.x - (view.cx - d.vw / 2)) / d.vw) * d.w;
        const sy = d.r.top - box.top + ((n.y - (view.cy - d.vh / 2)) / d.vh) * d.hh;
        tip.style.left = `${clamp(sx, 8, box.width - 8).toFixed(0)}px`;
        tip.style.top = `${Math.max(sy - (n.r * d.w) / d.vw - 8, 22).toFixed(0)}px`;
    };
    const hover = (key) => {
        if (key === hovered) return;
        for (const x of lit) x.classList.remove('is-near', 'is-hover');
        lit = [];
        hovered = key;
        root.classList.toggle('has-hover', Boolean(key));
        if (!key) { tip.hidden = true; return; }
        const add = (x) => { x.classList.add('is-near'); lit.push(x); };
        nodeEls.get(key).classList.add('is-hover'); lit.push(nodeEls.get(key));
        for (const k of adj.get(key)) add(nodeEls.get(k));
        for (const item of inc.get(key)) add(item.el);
        const n = by.get(key);
        tip.textContent = `${o.oneLabel(n.domain)}: ${n.title}`;
        tip.hidden = false;
        placeTip(key);
    };
    const setSelected = (key) => {
        if (selected && nodeEls.get(selected)) {
            nodeEls.get(selected).classList.remove('is-selected');
            for (const item of inc.get(selected)) item.el.classList.remove('is-on');
        }
        selected = key;
        if (key && nodeEls.get(key)) {
            nodeEls.get(key).classList.add('is-selected');
            for (const item of inc.get(key)) item.el.classList.add('is-on');
        }
    };
    const setHidden = (set) => {
        hidden = new Set(set);
        for (const n of nodes) nodeEls.get(n.key).toggleAttribute('hidden', isHidden(n));
        for (const item of edgeEls) item.el.toggleAttribute('hidden', isHidden(by.get(item.a)) || isHidden(by.get(item.b)));
    };
    const tap = (key) => {
        const now = Date.now();
        if (last.key === key && now - last.t < DOUBLE_MS) { last = { key: null, t: 0 }; o.onFocus(key); return; }
        last = { key, t: now };
        o.onSelect(key);
    };

    // -- pointers: one pointer pans or drags a node, two pinch --
    const ptrs = new Map();
    let gesture = null;
    let pinch = null;
    const nodeAt = (target) => {
        const g = target && target.closest ? target.closest('.graph-node') : null;
        return g ? g.getAttribute('data-key').slice(5) : null;
    };
    const mid = () => {
        const [a, b] = [...ptrs.values()];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1) };
    };
    root.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        cancelAnimationFrame(tween);
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ptrs.size === 2) { pinch = mid(); gesture = { type: 'pinch', moved: true }; return; }
        const key = nodeAt(e.target);
        gesture = { type: key ? 'node' : 'pan', key, sx: e.clientX, sy: e.clientY, moved: false };
        hover(null);
    });
    root.addEventListener('pointermove', (e) => {
        const p = ptrs.get(e.pointerId);
        if (!p || !gesture) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (gesture.type === 'pinch') {
            if (ptrs.size < 2) return;
            const m = mid();
            zoomAt(m.x, m.y, m.dist / pinch.dist);
            panBy(m.x - pinch.x, m.y - pinch.y);
            pinch = mid();
            return;
        }
        if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < DRAG_PX) return;
        gesture.moved = true;
        if (gesture.type === 'pan') { panBy(dx, dy); return; }
        const d = dims();
        const n = by.get(gesture.key);
        n.x += (dx / d.w) * d.vw;
        n.y += (dy / d.hh) * d.vh;
        nodeEls.get(n.key).setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
        for (const item of inc.get(n.key)) {
            const mine = item.a === n.key;
            item.el.setAttribute(mine ? 'x1' : 'x2', n.x.toFixed(1));
            item.el.setAttribute(mine ? 'y1' : 'y2', n.y.toFixed(1));
        }
    });
    const release = (e, cancelled) => {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.delete(e.pointerId);
        const g = gesture;
        if (g && g.type === 'pinch') {
            gesture = ptrs.size === 1 ? { type: 'pan', moved: true, sx: 0, sy: 0 } : null;
            pinch = null;
            return;
        }
        gesture = null;
        if (g && g.type === 'node' && !g.moved && !cancelled) tap(g.key);
    };
    root.addEventListener('pointerup', (e) => release(e, false));
    root.addEventListener('pointercancel', (e) => release(e, true));
    root.addEventListener('wheel', (e) => {
        e.preventDefault();
        cancelAnimationFrame(tween);
        const unit = e.deltaMode === 1 ? 16 : 1;
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0016)));
    }, { passive: false });
    root.addEventListener('pointerover', (e) => { if (e.pointerType !== 'touch' && !gesture) hover(nodeAt(e.target)); });
    root.addEventListener('pointerleave', () => { if (!gesture) hover(null); });
    root.addEventListener('focusin', (e) => {
        const key = nodeAt(e.target);
        if (!key) return;
        const n = by.get(key);
        const d = dims();
        const inside = Math.abs(n.x - view.cx) < d.vw / 2 - 30 && Math.abs(n.y - view.cy) < d.vh / 2 - 30;
        if (!inside) { view.cx = n.x; view.cy = n.y; apply(); }
        hover(key);
    });
    root.addEventListener('focusout', () => hover(null));

    // -- keyboard: Enter selects a node, arrows pan, + and - zoom, 0 resets --
    el.addEventListener('keydown', (e) => {
        if (e.target.closest && e.target.closest('button')) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const key = nodeAt(e.target);
        if ((e.key === 'Enter' || e.key === ' ') && key) { e.preventDefault(); if (e.shiftKey) o.onFocus(key); else o.onSelect(key); return; }
        const d = dims();
        const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (move) { e.preventDefault(); goTo({ cx: view.cx + move[0] * d.vw * 0.15, cy: view.cy + move[1] * d.vh * 0.15, k: view.k }, false); return; }
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.4); } else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.4); } else if (e.key === '0') { e.preventDefault(); fit(true); }
    });

    // The size is only known once the canvas is on the page: fit then, and keep the view in step with later resizes.
    let ready = false;
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        if (!root.getBoundingClientRect().width) return;
        if (!ready) { ready = true; fit(false); root.setAttribute('data-ready', '1'); } else apply();
    }) : null;
    if (watch) watch.observe(root);
    setHidden(hidden);
    setSelected(selected);
    return { el, setSelected, setHidden, fit, zoomBy, destroy: () => { cancelAnimationFrame(tween); if (watch) watch.disconnect(); } };
}
