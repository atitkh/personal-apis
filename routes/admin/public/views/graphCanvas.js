// The Graph page's drawing, in the manner of Obsidian's graph view: a borderless dark canvas with small muted dots, hairline
// links and labels that fade in with the zoom (busiest records first). The layout is a live force simulation: it is seeded the
// same way every time (spirals around one anchor per domain), drifts into place, reacts when a node is dragged (its neighbours
// follow along the links) and goes to sleep (no animation frames at all) once it is still. Floating over the canvas: a
// settings panel (filters, groups, display, forces), zoom buttons and whatever the view hands in (mode switch, details card).
// Positions live in memory only; the settings are kept in localStorage under `hub-graph`. No libraries.
import { h, svg, icon, domainHue, plural, toast } from '../ui.js';
import { createTimeline } from './graphTimeline.js';

const BASE_W = 920;     // world units across the canvas at zoom 1
const BASE_H = 560;
const K_MIN = 0.15;
const K_MAX = 6;
const DRAG_PX = 5;      // a press that moves less than this is a tap
const DOUBLE_MS = 350;
const STORE = 'hub-graph';
const REL_RE = /^[a-z][a-z0-9_-]{0,29}$/;   // the same rule as the server's (services/links.js)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- settings (display and forces only; never any record data) ----

export const DEFAULTS = { nodeSize: 1, linkThick: 1, textFade: 0.5, arrows: false, linkLabels: false, center: 0.3, repel: 0.5, link: 0.5, linkDist: 60 };
const RANGE = { nodeSize: [0.4, 2.5, 0.05], linkThick: [0.3, 3, 0.1], textFade: [0, 1, 0.01], center: [0, 1, 0.01], repel: [0, 1, 0.01], link: [0, 1, 0.01], linkDist: [20, 200, 1] };
const PART = { nodeSize: 'display', linkThick: 'display', textFade: 'display', arrows: 'display', linkLabels: 'display', center: 'forces', repel: 'forces', link: 'forces', linkDist: 'forces' };

export function loadSettings(store) {
    const out = { ...DEFAULTS };
    try {
        const raw = JSON.parse((store || localStorage).getItem(STORE) || 'null');
        for (const [k, v] of Object.entries(DEFAULTS)) {
            const given = raw && raw[PART[k]] && raw[PART[k]][k];
            if (typeof v === 'boolean') { if (typeof given === 'boolean') out[k] = given; } else if (typeof given === 'number' && Number.isFinite(given)) out[k] = clamp(given, RANGE[k][0], RANGE[k][1]);
        }
    } catch (e) { /* no storage, or not ours: defaults */ }
    return out;
}
function saveSettings(s) {
    try {
        const out = { v: 1, display: {}, forces: {} };
        for (const k of Object.keys(DEFAULTS)) out[PART[k]][k] = s[k];
        localStorage.setItem(STORE, JSON.stringify(out));
    } catch (e) { /* private mode: it just will not be remembered */ }
}

// ---- seeds: where the nodes start (no randomness, so every visit opens the same way) ----

// The whole graph: every domain gets an anchor on a ring and its nodes start in a spiral around it, busiest in the middle.
// Returns the anchors, which the simulation pulls each domain towards (gently).
export function seedOverview(nodes) {
    const n = nodes.length;
    const doms = [...new Set(nodes.map((x) => x.domain))].sort();
    const ring = doms.length > 1 ? 52 * Math.sqrt(Math.max(n, 4)) : 0;
    const anchors = new Map(doms.map((d, i) => {
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
        const p = anchors.get(nd.domain);
        nd.x = p.x + Math.cos(a) * r;
        nd.y = p.y + Math.sin(a) * r;
        nd.vx = 0; nd.vy = 0; nd.sx = nd.x; nd.sy = nd.y;
    }
    return doms.length > 1 && ring ? anchors : new Map();
}

// A focused record: rings by depth. The centre record is pinned in the middle.
export function seedFocused(nodes, edges) {
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
        if (n.depth === 0) { n.x = cx; n.y = cy; n.pinned = true; n.fixed = true; n.fx = cx; n.fy = cy; } else if (n.depth >= 2) {
            const p = by.get(n.parent) || by.get(ring1[0] && ring1[0].key) || { x: cx, y: cy, angle: 0 };
            const sib = kids.get(n.parent) || [n.key];
            const a = (p.angle || 0) + (sib.indexOf(n.key) - (sib.length - 1) / 2) * 0.28;
            n.x = cx + Math.cos(a) * 270;
            n.y = cy + Math.sin(a) * 215;
        }
        n.vx = 0; n.vy = 0; n.sx = n.x; n.sy = n.y;
    }
    return new Map();
}

// ---- the simulation ----

// Repulsion between near nodes (a grid, so 400 nodes cost about 400 x 20 pairs), a spring along every link, a pull to the
// centre and (overview) a gentle pull of each node towards its domain's anchor. `alpha` is the heat: it cools towards
// `target` each step and the simulation is asleep when it is cool and nothing holds it up (target 0). A node with `fixed` is held
// at fx, fy (being dragged, or the pinned centre record).
const CUT = 300;
const SPRING = 0.6;
const ALPHA_MIN = 0.015;
const DECAY = 0.017;
// Records the timeline has taken off the picture (`gone`) are left out of the forces and keep their place.
export function createSim(all, edges, anchors, forces) {
    let nodes = all;
    let n; let idx; let ends; let fx; let fy; let next; let charge; let tug;
    // (Re)reads the nodes and edges: called once, and again after a link is added or removed (positions are kept).
    const build = () => {
        nodes = all.some((x) => x.gone) ? all.filter((x) => !x.gone) : all;
        n = nodes.length;
        idx = new Map(nodes.map((x, i) => [x.key, i]));
        ends = edges.map((e) => [idx.get(e.from), idx.get(e.to)]).filter(([a, b]) => a != null && b != null);
        fx = new Float64Array(n);
        fy = new Float64Array(n);
        next = new Int32Array(n);
        // Busy records push harder (so hubs keep their groups apart) and tug less per link (one hub is not dragged around by each leaf).
        charge = Float64Array.from(nodes, (x) => 1 + 0.5 * Math.sqrt(x.degree || 0));
        tug = ends.map(([a, b]) => 1 / Math.sqrt(Math.max(Math.min(nodes[a].degree || 1, nodes[b].degree || 1), 1)));
    };
    build();
    let head = new Int32Array(0);
    const sim = { alpha: 1, target: 0, forces: { ...forces }, ticks: 0 };
    sim.rebuild = build;
    sim.asleep = () => sim.target === 0 && sim.alpha < ALPHA_MIN;
    sim.step = () => {
        sim.alpha += (sim.target - sim.alpha) * DECAY;
        sim.ticks += 1;
        if (!n) return;   // the timeline can take every record off the picture
        const { center, repel, link, linkDist } = sim.forces;
        const push = 5200 * repel;
        const spring = SPRING * link;
        const pull = 0.0004 + center * 0.004;
        fx.fill(0); fy.fill(0);
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        for (const a of nodes) { if (a.x < x0) x0 = a.x; if (a.x > x1) x1 = a.x; if (a.y < y0) y0 = a.y; if (a.y > y1) y1 = a.y; }
        const cs = Math.max(CUT, (x1 - x0) / 63, (y1 - y0) / 63);
        const gw = Math.floor((x1 - x0) / cs) + 1;
        const gh = Math.floor((y1 - y0) / cs) + 1;
        if (head.length < gw * gh) head = new Int32Array(gw * gh);
        head.fill(-1, 0, gw * gh);
        for (let i = 0; i < n; i += 1) {
            const cell = Math.floor((nodes[i].y - y0) / cs) * gw + Math.floor((nodes[i].x - x0) / cs);
            next[i] = head[cell];
            head[cell] = i;
        }
        const cut2 = CUT * CUT;
        for (let i = 0; i < n; i += 1) {
            const a = nodes[i];
            const gx = Math.floor((a.x - x0) / cs);
            const gy = Math.floor((a.y - y0) / cs);
            for (let cy = Math.max(gy - 1, 0); cy <= Math.min(gy + 1, gh - 1); cy += 1) {
                for (let cx = Math.max(gx - 1, 0); cx <= Math.min(gx + 1, gw - 1); cx += 1) {
                    for (let j = head[cy * gw + cx]; j >= 0; j = next[j]) {
                        if (j <= i) continue;
                        const b = nodes[j];
                        let dx = a.x - b.x;
                        let dy = a.y - b.y;
                        let d2 = dx * dx + dy * dy;
                        if (d2 > cut2) continue;
                        if (d2 < 1e-6) { dx = ((i * 7 + j) % 5 - 2) * 0.3 || 0.3; dy = ((i * 3 + j) % 5 - 2) * 0.3 || -0.3; d2 = dx * dx + dy * dy; }
                        const dd = Math.max(d2, 49);
                        const f = (push * charge[i] * charge[j]) / dd / Math.sqrt(dd);
                        fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
                    }
                }
            }
        }
        for (let e = 0; e < ends.length; e += 1) {
            const [i, j] = ends[e];
            const a = nodes[i];
            const b = nodes[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const f = ((d - linkDist) * spring * tug[e]) / d;
            fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
        }
        for (let i = 0; i < n; i += 1) {
            const a = nodes[i];
            if (a.fixed) { a.x = a.fx; a.y = a.fy; a.vx = 0; a.vy = 0; continue; }
            const p = anchors.get(a.domain);
            fx[i] += (BASE_W / 2 - a.x) * pull;
            fy[i] += (BASE_H / 2 - a.y) * pull;
            if (p) { fx[i] += (p.x - a.x) * 0.012; fy[i] += (p.y - a.y) * 0.012; }
            a.vx = (a.vx + fx[i] * sim.alpha) * 0.6;
            a.vy = (a.vy + fy[i] * sim.alpha) * 0.6;
            a.x += clamp(a.vx, -16, 16);
            a.y += clamp(a.vy, -16, 16);
        }
    };
    // Runs until cool (used for reduced motion and by tests).
    sim.settle = (max = 600) => { for (let i = 0; i < max && !sim.asleep(); i += 1) sim.step(); };
    return sim;
}

// ---- the canvas ----

// o: { nodes (seeded: x, y), edges, anchors, centerKey, selected, hidden (Set of domains), dense, label, oneLabel(domain),
//      groups [{ d, text }], hudLeft [elements], card (element), hiddenRel (Set of relation words), onSelect(key), onFocus(key),
//      onSelectEdge(edge, { confirm }), onClear(), onHidden(set), onHiddenRel(set), onEdit(on), onEdges(),
//      api { create(body), remove(id) } (the only writes: both audited by the server, and only ever called while editing) }
//   -> { el, setSelected, setSelectedEdge, setHidden, setHiddenRel, setEditing, isEditing, startLink, removeLink, fit, zoomBy, focusOn, search, replay, sim, destroy }
// `edges` ({ id, from, to, rel, note }) and `nodes` are changed in place when a link is added or removed, so the view's own
// lists (the details card) read the same arrays.
export function createCanvas(o) {
    const { nodes, edges } = o;
    const dense = Boolean(o.dense);
    const by = new Map(nodes.map((n) => [n.key, n]));
    const adj = new Map(nodes.map((n) => [n.key, new Set()]));
    const inc = new Map(nodes.map((n) => [n.key, []]));
    const drawn = new Map();
    const edgeEls = [];
    const view = { cx: BASE_W / 2, cy: BASE_H / 2, k: 1 };
    const settings = loadSettings();
    let maxDeg = Math.max(1, ...nodes.map((n) => n.degree || 0));
    const small = nodes.length <= 40;
    let hidden = new Set(o.hidden || []);
    let hiddenRel = new Set(o.hiddenRel || []);
    let selEdge = null;     // the selected link (an item of edgeEls)
    let hoverEdge = null;
    let forced = new Set(); // links whose relation word always shows: those of the hovered/selected record and the hovered/selected link
    let editing = false;
    let linking = null;     // { from }: a link started from one record (keyboard or tap), waiting for the other end
    let draft = null;       // { a, b }: the two ends while the create popover is open
    let ringKey = null;     // the record the edge ring is drawn around
    let pop = null;
    let selected = o.selected || null;
    let hovered = null;
    let tween = 0;
    let raf = 0;
    let autoFit = true;
    let ready = false;
    let scale = 1;
    let lastScale = 0;
    let query = '';
    let last = { key: null, t: 0 };
    let stepMs = 0;
    let spentMs = 0;
    let kRef = 1;           // the zoom that fits the graph: text fades in as you zoom past it, whatever the size of the graph

    const root = svg('svg', { class: `graph-svg${dense ? ' is-dense' : ''}`, viewBox: `0 0 ${BASE_W} ${BASE_H}`, role: 'group', 'aria-label': o.label, 'data-sim': 'asleep', 'data-ticks': '0' });
    const defs = svg('defs', {}, svg('marker', { id: 'graph-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', markerUnits: 'userSpaceOnUse', orient: 'auto' }, svg('path', { d: 'M0 0.5 L8 4 L0 7.5 z' })));
    const gEdges = svg('g', { class: 'graph-edges' });
    const gNodes = svg('g', { class: 'graph-nodes' });
    const tip = h('div', { class: 'graph-tip', role: 'presentation' });
    tip.hidden = true;

    const addItem = (e) => {
        const a = by.get(e.from);
        const b = by.get(e.to);
        if (!a || !b) return null;
        const item = { id: e.id, a: a.key, b: b.key, na: a, nb: b, rel: e.rel, e, off: false, line: null, lab: null };
        edgeEls.push(item);
        inc.get(a.key).push(item); inc.get(b.key).push(item);
        adj.get(a.key).add(b.key); adj.get(b.key).add(a.key);
        return item;
    };
    for (const e of edges) addItem(e);
    // All the links are one path (one attribute to update per frame, however many links there are); the links of the hovered and
    // selected records are drawn again on top as lines, which is what lights them up. With arrows on, every link is its own line.
    const pathAll = svg('path', { class: 'graph-edge graph-edge-all' });
    const gLines = svg('g', { class: 'graph-lines' });
    const gHot = svg('g', { class: 'graph-hot' });
    gEdges.append(pathAll, gLines);
    const ariaFor = (n) => `${o.oneLabel(n.domain)}: ${n.title}. ${plural(n.degree || 0, 'link')}. Press Enter to select, Shift and Enter to focus on it.`;
    const topKeys = new Set([...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, dense ? 40 : nodes.length).map((n) => n.key));
    const baseR = (n) => (n.key === o.centerKey ? 8 : dense ? 2.4 + Math.sqrt(n.degree || 0) * 1.2 : 4.5 + Math.sqrt(n.degree || 0) * 1.4);
    // Drawn from the least to the most connected, so the busy records sit on top of their neighbours.
    for (const n of [...nodes].sort((a, b) => (a.degree || 0) - (b.degree || 0))) {
        const hit = svg('circle', { class: 'hit' });
        const dot = svg('circle', { class: 'dot' });
        const text = svg('text', { 'text-anchor': 'middle', dy: '1.2em' }, clipText(n.title, 28));
        const g = svg('g', { class: `graph-node hue-${domainHue(n.domain)}${n.key === o.centerKey ? ' is-center' : ''}`,
            tabindex: topKeys.has(n.key) ? '0' : '-1', role: 'button', 'data-key': `node:${n.key}`,
            'aria-label': ariaFor(n) }, hit, dot, text);
        drawn.set(n.key, { n, g, hit, dot, text, r: 0, lo: -1 });
        gNodes.append(g);
    }
    // Relation words (one text per link, made when first needed), the ring you drag a new link from, and the line it draws.
    const gRel = svg('g', { class: 'graph-rels' });
    const ringVis = svg('circle', { class: 'ring-vis' });
    const ringHit = svg('circle', { class: 'ring-hit' });
    const gRing = svg('g', { class: 'graph-ring', hidden: '' }, ringVis, ringHit);
    const rubber = svg('line', { class: 'graph-rubber', hidden: '' });
    root.append(defs, gEdges, gHot, gRel, gNodes, rubber, gRing);

    // -- the floating controls --
    const button = (text, label, key, fn) => h('button', { type: 'button', class: 'graph-btn', 'aria-label': label, title: label, 'data-key': key, onclick: fn }, text);
    const gear = h('button', { type: 'button', class: 'graph-btn', 'aria-label': 'Graph settings', title: 'Graph settings', 'aria-expanded': 'false', 'aria-controls': 'graph-panel', 'data-key': 'graph-settings', onclick: () => togglePanel() }, icon('settings'));
    const editBtn = h('button', { type: 'button', class: 'graph-btn', 'aria-label': 'Edit links', title: 'Edit links (E)', 'aria-pressed': 'false', 'data-key': 'graph-edit', onclick: () => setEditing(!editing) }, icon('edit'));
    const tlBtn = h('button', { type: 'button', class: 'graph-btn', 'aria-label': 'Timeline', title: 'Timeline (T)', 'aria-pressed': 'false', 'data-key': 'graph-timeline-btn', onclick: () => tl.toggle() }, icon('timeline'));
    const tools = h('div', { class: 'graph-hud graph-hud-right' }, gear, editBtn, tlBtn,
        h('div', { class: 'graph-zoom', role: 'group', 'aria-label': 'Zoom' },
            button('+', 'Zoom in', 'graph-zoom-in', () => zoomBy(1.4)), button('−', 'Zoom out', 'graph-zoom-out', () => zoomBy(1 / 1.4)),
            button(icon('expand'), 'Reset the view to fit everything', 'graph-fit', () => fit(true))));
    const hint = h('p', { class: 'graph-hint', text: 'Scroll to zoom · drag to pan · double-click a point to see just its neighbours' });
    // While editing: a badge says so (with a way out) and, while a link is being picked, what to do next.
    const badgeSub = h('span', { class: 'graph-badge-sub', 'aria-live': 'polite' });
    const badgeCancel = h('button', { type: 'button', class: 'graph-badge-btn', 'data-key': 'graph-link-cancel', onclick: () => cancelLink(true), text: 'Cancel' });
    const badge = h('div', { class: 'graph-badge', role: 'status', 'data-key': 'graph-badge' }, icon('edit'),
        h('span', { class: 'graph-badge-body' }, h('strong', { text: 'Editing links' }), badgeSub), badgeCancel,
        h('button', { type: 'button', class: 'graph-badge-btn', 'data-key': 'graph-edit-done', onclick: () => setEditing(false), text: 'Done' }));
    badge.hidden = true; badgeCancel.hidden = true;
    const el = h('div', { class: `graph-stage${dense ? ' is-dense' : ''}`, 'data-key': 'graph-stage' }, root, tip, h('div', { class: 'graph-hud graph-hud-left' }, [...(o.hudLeft || []), badge]), tools, hint);
    let tl;
    let timeOn = null;      // while the timeline limits the links: edge => is it recorded yet
    let newTimer = 0;

    // -- the settings panel: filters, groups, display, forces --
    const sliders = new Map();
    const slider = (key, text, fmt = (v) => v.toFixed(2)) => {
        const [lo, hi, step] = RANGE[key];
        const out = h('output', { class: 'graph-val' });
        const input = h('input', { type: 'range', min: lo, max: hi, step, 'data-key': `set:${key}` });
        const show = () => { input.value = settings[key]; out.textContent = fmt(settings[key]); };
        input.addEventListener('input', () => { settings[key] = Number(input.value); out.textContent = fmt(settings[key]); changed(key); });
        sliders.set(key, show);
        show();
        return h('label', { class: 'graph-row' }, h('span', { class: 'graph-row-label', text }), input, out);
    };
    const arrows = h('input', { type: 'checkbox', 'data-key': 'set:arrows' });
    arrows.addEventListener('change', () => { settings.arrows = arrows.checked; changed('arrows'); });
    const searchBox = h('input', { type: 'search', class: 'graph-search', placeholder: 'Search records in the graph', 'aria-label': 'Search records in the graph', autocomplete: 'off', 'data-key': 'graph-search' });
    const found = h('p', { class: 'graph-found muted', 'aria-live': 'polite' });
    let searchTimer = 0;
    searchBox.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(searchBox.value, true), 250); });
    searchBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); search(searchBox.value, true); } });
    const labelsBox = h('input', { type: 'checkbox', 'data-key': 'set:linkLabels' });
    labelsBox.addEventListener('change', () => { settings.linkLabels = labelsBox.checked; changed('linkLabels'); });
    const relBox = h('div', { class: 'graph-groups', role: 'group', 'aria-label': 'Show these link types' });
    const relOptions = h('datalist', { id: 'graph-pop-rels' });
    const toggles = new Map();
    const paintGroups = () => {
        for (const [d, b] of toggles) {
            const on = !hidden.has(d);
            b.setAttribute('aria-pressed', String(on));
        }
    };
    const groups = h('div', { class: 'graph-groups', role: 'group', 'aria-label': 'Show these domains' }, (o.groups || []).map(({ d, text }) => {
        const b = h('button', { type: 'button', class: `graph-group hue-${domainHue(d)}`, 'data-key': `hide:${d}`, onclick: () => {
            const set = new Set(hidden);
            if (set.has(d)) set.delete(d); else set.add(d);
            setHidden(set);
            if (o.onHidden) o.onHidden(set);
        } }, h('span', { class: 'graph-swatch', 'aria-hidden': 'true' }), h('span', { class: 'graph-group-text', text }));
        toggles.set(d, b);
        return b;
    }));
    const section = (title, open, ...kids) => h('details', { class: 'graph-sec', open: open ? '' : null }, h('summary', { text: title }), h('div', { class: 'graph-sec-body' }, kids));
    const panel = h('div', { id: 'graph-panel', class: 'graph-panel', role: 'region', 'aria-label': 'Graph settings', hidden: '' },
        h('div', { class: 'graph-panel-head' }, h('strong', { text: 'Graph settings' }), button(icon('close'), 'Close the settings', 'graph-settings-close', () => togglePanel(false))),
        section('Filters', true, searchBox, found),
        section('Groups', true, groups),
        section('Link types', true, relBox),
        section('Display', false, slider('nodeSize', 'Node size'), slider('linkThick', 'Link thickness'), slider('textFade', 'Text fade threshold'), h('label', { class: 'graph-row graph-check' }, arrows, h('span', { text: 'Arrows' })),
            h('label', { class: 'graph-row graph-check' }, labelsBox, h('span', { text: 'Link labels' })), h('p', { class: 'graph-help muted', text: 'Writes the relation on each link. Zoom in to read them; a record\u2019s own links always show.' })),
        section('Forces', false, slider('center', 'Center force'), slider('repel', 'Repel force'), slider('link', 'Link force'), slider('linkDist', 'Link distance', (v) => String(Math.round(v)))),
        h('div', { class: 'graph-panel-foot' },
            h('button', { type: 'button', class: 'btn small', 'data-key': 'graph-animate', onclick: () => replay(), text: 'Animate' }),
            h('button', { type: 'button', class: 'btn quiet small', 'data-key': 'graph-defaults', onclick: () => resetSettings(), text: 'Reset to defaults' })));
    el.append(panel, relOptions);
    if (o.card) el.append(o.card);
    arrows.checked = settings.arrows;
    labelsBox.checked = settings.linkLabels;

    const togglePanel = (open = panel.hidden) => {
        panel.hidden = !open;
        gear.setAttribute('aria-expanded', String(open));
        el.classList.toggle('panel-open', open);
        if (!open && panel.contains(document.activeElement)) gear.focus();
    };
    const changed = (key) => {
        saveSettings(settings);
        if (PART[key] === 'forces') { sim.forces[key] = settings[key]; wake(0.6); } else paintSizes();
    };
    const resetSettings = () => {
        Object.assign(settings, DEFAULTS);
        try { localStorage.removeItem(STORE); } catch (e) { /* nothing saved anyway */ }
        for (const show of sliders.values()) show();
        arrows.checked = settings.arrows;
        labelsBox.checked = settings.linkLabels;
        Object.assign(sim.forces, { center: settings.center, repel: settings.repel, link: settings.link, linkDist: settings.linkDist });
        paintSizes();
        wake(0.6);
    };

    // -- drawing: sizes, positions, zoom-dependent text --
    const rad = (n) => baseR(n) * settings.nodeSize;
    const paintSizes = () => {
        root.style.setProperty('--lt', settings.linkThick.toFixed(2));
        root.classList.toggle('show-arrows', settings.arrows);
        for (const d of drawn.values()) d.base = rad(d.n);
        lastScale = 0;
        setArrows();
        paintZoom();
        place(true);
    };
    const r1 = (v) => Math.round(v * 10) / 10;
    const tail = (it) => {
        // where a link ends: at the node's edge when it has an arrow head
        const { x, y } = it.na;
        const dx = it.nb.x - x; const dy = it.nb.y - y;
        const len = Math.hypot(dx, dy) || 1;
        const t = Math.max(len - drawn.get(it.b).r - 2, 0) / len;
        return [x + dx * t, y + dy * t];
    };
    const setLine = (l, it) => {
        const [x2, y2] = settings.arrows ? tail(it) : [it.nb.x, it.nb.y];
        l.setAttribute('x1', r1(it.na.x)); l.setAttribute('y1', r1(it.na.y)); l.setAttribute('x2', r1(x2)); l.setAttribute('y2', r1(y2));
    };
    const place = (all) => {
        for (const d of drawn.values()) {
            const n = d.n;
            if (!all && Math.abs(n.x - d.px) + Math.abs(n.y - d.py) < 0.05) continue;
            d.px = n.x; d.py = n.y;
            d.g.setAttribute('transform', `translate(${r1(n.x)} ${r1(n.y)})`);
        }
        if (settings.arrows) { for (const it of edgeEls) if (it.line) setLine(it.line, it); } else {
            let dstr = '';
            for (const it of edgeEls) if (!it.off) dstr += `M${r1(it.na.x)} ${r1(it.na.y)}L${r1(it.nb.x)} ${r1(it.nb.y)}`;
            pathAll.setAttribute('d', dstr);
        }
        for (const l of gHot.children) setLine(l, l.__item);
        if (ringKey) placeRing();
        if (draft) drawDraft();
        paintRels();
    };
    // The links of the hovered and the selected record, as lines drawn over the grey ones.
    const paintHot = () => {
        const out = [];
        const add = (key, cls) => { if (!key || !inc.get(key)) return; for (const it of inc.get(key)) if (!it.off) out.push([it, cls]); };
        add(selected, 'is-on');
        add(hovered, 'is-near');
        if (selEdge && !selEdge.off) out.push([selEdge, 'is-on']);
        if (hoverEdge && hoverEdge !== selEdge && !hoverEdge.off) out.push([hoverEdge, 'is-near']);
        const seen = new Map();
        for (const [it, cls] of out) seen.set(it, seen.get(it) === 'is-near' ? 'is-near' : cls);
        forced = new Set(seen.keys());
        const kids = [];
        for (const [it, cls] of seen) {
            const l = svg('line', { class: `graph-edge ${cls}` }, dense ? null : svg('title', {}, edgeText(it)));
            l.__item = it;
            setLine(l, it);
            kids.push(l);
        }
        gHot.replaceChildren(...kids);
        paintRels();
    };
    const edgeText = (it) => `${it.na.title} \u2014${it.rel}\u2192 ${it.nb.title}`;

    // Relation words on the lines: one small text per link, upright, at the middle of the line. They fade in with the zoom like the
    // record names (never on a graph that is zoomed out), only for links on screen and long enough to hold the word, and only the
    // links of the hovered or selected record (and a hovered or selected link) show whatever the zoom. The texts are made the
    // first time a link needs one and only touched while labels are on.
    let relShown = 0;
    const relFade = () => clamp((view.k / kRef - (1.1 + settings.textFade * 0.8) * (small ? 0.45 : 1)) / 0.5, 0, 1);
    const hideRels = () => { for (const it of edgeEls) if (it.lab && !it.lab.hasAttribute('hidden')) it.lab.setAttribute('hidden', ''); relShown = 0; };
    const paintRels = () => {
        if (!settings.linkLabels) { if (relShown) hideRels(); return; }
        const f = relFade();
        if (f === 0 && !forced.size) { if (relShown) hideRels(); return; }
        const dm = dims();
        const x0 = view.cx - dm.vw / 2 - 10; const x1 = view.cx + dm.vw / 2 + 10;
        const y0 = view.cy - dm.vh / 2 - 10; const y1 = view.cy + dm.vh / 2 + 10;
        let shown = 0;
        for (const it of edgeEls) {
            const a = it.na; const b = it.nb;
            const hot = forced.has(it);
            const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
            const on = !it.off && shown < 220 && mx >= x0 && mx <= x1 && my >= y0 && my <= y1
                && (hot || (f > 0 && Math.hypot(b.x - a.x, b.y - a.y) * scale >= it.rel.length * 5.5 + 14));
            if (!on) { if (it.lab && !it.lab.hasAttribute('hidden')) it.lab.setAttribute('hidden', ''); continue; }
            shown += 1;
            if (!it.lab) { it.lab = svg('text', { class: 'graph-rel', 'text-anchor': 'middle', dy: '-0.4em' }, it.rel); gRel.append(it.lab); }
            let deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
            if (deg > 90) deg -= 180; else if (deg < -90) deg += 180;
            it.lab.setAttribute('transform', `translate(${r1(mx)} ${r1(my)}) rotate(${deg.toFixed(1)})`);
            it.lab.removeAttribute('hidden');
            it.lab.classList.toggle('is-hot', hot);
            it.lab.classList.toggle('is-plain', it.rel === 'related');
            it.lab.style.opacity = (hot ? 1 : f).toFixed(2);
        }
        relShown = shown;
    };
    const setArrows = () => {
        if (settings.arrows && !gLines.firstChild) for (const it of edgeEls) { it.line = svg('line', { class: 'graph-edge' }); gLines.append(it.line); }
        for (const it of edgeEls) if (it.line) it.line.toggleAttribute('hidden', it.off);
        gLines.toggleAttribute('hidden', !settings.arrows);
        pathAll.toggleAttribute('hidden', settings.arrows);
    };
    // Label opacity by zoom and degree: busy records first, the rest fading in as you zoom (Obsidian's text fade threshold).
    const paintLabels = () => {
        const t = (0.15 + settings.textFade * 0.9) * (small ? 0.3 : 1);
        const rel = view.k / kRef;
        for (const d of drawn.values()) {
            const score = rel * (0.4 + 0.6 * Math.sqrt((d.n.degree || 0) / maxDeg));
            const lo = clamp((score - t) / 0.3, 0, 1);
            if (Math.abs(lo - d.lo) > 0.03 || (lo !== d.lo && (lo === 0 || lo === 1))) { d.lo = lo; d.text.style.opacity = lo.toFixed(2); }
        }
    };
    // Dots grow a little when you zoom in, not as fast as the picture does (like Obsidian), so a close-up stays readable.
    const paintZoom = () => {
        if (Math.abs(scale - lastScale) > lastScale * 0.04) {
            lastScale = scale;
            root.style.setProperty('--fs', `${(11 / scale).toFixed(3)}px`);
            const comp = clamp((view.k / kRef) ** -0.45, 0.3, 2.2);
            for (const d of drawn.values()) {
                d.r = d.base * comp;
                d.dot.setAttribute('r', d.r.toFixed(2));
                d.text.setAttribute('y', d.r.toFixed(2));
                d.hit.setAttribute('r', Math.max(d.r + 2, 8 / scale).toFixed(2));
            }
        }
        paintLabels();
        paintRels();
        if (ringKey) placeRing();
    };

    // -- view state --
    // The size is cached (reading it every frame would force a layout while nodes are moving); `rect()` is the live box, used
    // where the pointer position has to be turned into a world position.
    let box = { w: 0, h: 0 };
    const measure = () => { const r = root.getBoundingClientRect(); box = { w: r.width, h: r.height }; return r.width > 0; };
    const rect = () => root.getBoundingClientRect();
    const dims = () => {
        if (!box.w) measure();
        const w = box.w || BASE_W;
        const hh = box.h || (w * BASE_H) / BASE_W;
        const vw = BASE_W / view.k;
        return { w, hh, vw, vh: (vw * hh) / w };
    };
    const apply = () => {
        const d = dims();
        scale = d.w / d.vw;
        root.setAttribute('viewBox', `${(view.cx - d.vw / 2).toFixed(2)} ${(view.cy - d.vh / 2).toFixed(2)} ${d.vw.toFixed(2)} ${d.vh.toFixed(2)}`);
        root.dataset.zoom = view.k.toFixed(3);
        paintZoom();
        if (hovered) placeTip(hovered);
    };
    const toWorld = (px, py) => {
        const d = dims();
        const r = rect();
        return { x: view.cx - d.vw / 2 + ((px - r.left) / d.w) * d.vw, y: view.cy - d.vh / 2 + ((py - r.top) / d.hh) * d.vh };
    };
    const used = () => { autoFit = false; el.classList.add('is-used'); };
    const zoomAt = (px, py, factor) => {
        const k = clamp(view.k * factor, K_MIN, K_MAX);
        if (k === view.k) return;
        used();
        const before = toWorld(px, py);
        view.k = k;
        const after = toWorld(px, py);
        view.cx += before.x - after.x;
        view.cy += before.y - after.y;
        apply();
    };
    const panBy = (dxPx, dyPx) => {
        used();
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
    const zoomBy = (factor) => { used(); goTo({ cx: view.cx, cy: view.cy, k: clamp(view.k * factor, K_MIN, K_MAX) }, true); };
    const isHidden = (n) => hidden.has(n.domain) && n.key !== o.centerKey;
    // The view that shows these nodes (all shown ones by default).
    const viewFor = (list, minW, minH, maxK) => {
        const xs = list.map((n) => n.x);
        const ys = list.map((n) => n.y);
        const x0 = Math.min(...xs); const x1 = Math.max(...xs);
        const y0 = Math.min(...ys); const y1 = Math.max(...ys);
        const bw = Math.max(x1 - x0 + 140, minW);
        const bh = Math.max(y1 - y0 + 120, minH);
        const d = dims();
        return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k: clamp(Math.min(BASE_W / bw, (BASE_W * d.hh) / (d.w * bh)), K_MIN, maxK) };
    };
    const fitView = () => {
        const shown = nodes.filter((n) => !isHidden(n) && !n.gone);
        const v = shown.length ? viewFor(shown, dense ? 400 : 560, dense ? 280 : 340, K_MAX) : { cx: BASE_W / 2, cy: BASE_H / 2, k: 1 };
        kRef = v.k;
        return v;
    };
    const fit = (animate) => { autoFit = false; goTo(fitView(), animate); };

    // -- highlight --
    let lit = [];
    const placeTip = (key) => {
        const d = drawn.get(key);
        const dm = dims();
        const sx = ((d.n.x - (view.cx - dm.vw / 2)) / dm.vw) * dm.w;
        const sy = ((d.n.y - (view.cy - dm.vh / 2)) / dm.vh) * dm.hh;
        tip.style.left = `${clamp(sx, 8, dm.w - 8).toFixed(0)}px`;
        tip.style.top = `${Math.max(sy - d.r * scale - 8, 22).toFixed(0)}px`;
    };
    const hover = (key) => {
        if (key === hovered) return;
        if (key && hoverEdge) clearEdgeHover();
        for (const x of lit) x.classList.remove('is-near', 'is-hover');
        lit = [];
        hovered = key;
        root.classList.toggle('has-hover', Boolean(key) || Boolean(hoverEdge));
        paintHot();
        paintRing();
        if (!key) { if (!hoverEdge) tip.hidden = true; return; }
        const add = (x) => { x.classList.add('is-near'); lit.push(x); };
        drawn.get(key).g.classList.add('is-hover'); lit.push(drawn.get(key).g);
        for (const k of adj.get(key)) add(drawn.get(k).g);
        const n = by.get(key);
        tip.textContent = `${o.oneLabel(n.domain)}: ${n.title}`;
        tip.hidden = false;
        placeTip(key);
    };
    // A record or a link is selected, never both (null clears either).
    let endLit = [];
    const applySel = (key, it) => {
        if (selected && drawn.get(selected)) drawn.get(selected).g.classList.remove('is-selected');
        for (const g of endLit) g.classList.remove('is-end');
        endLit = [];
        selected = key;
        selEdge = it;
        if (key && drawn.get(key)) drawn.get(key).g.classList.add('is-selected');
        if (it) for (const n of [it.na, it.nb]) { const g = drawn.get(n.key).g; g.classList.add('is-end'); endLit.push(g); }
        paintHot();
    };
    const setSelected = (key) => applySel(key, null);
    const setSelectedEdge = (id) => { const it = edgeEls.find((x) => x.id === id) || null; applySel(null, it); return it; };
    const selectEdgeItem = (it, opts) => { clearEdgeHover(); applySel(null, it); if (o.onSelectEdge) o.onSelectEdge(it.e, opts || {}); };
    const refreshOff = (it) => { it.off = isHidden(it.na) || isHidden(it.nb) || hiddenRel.has(it.rel) || Boolean(it.na.gone) || Boolean(it.nb.gone) || Boolean(timeOn && !timeOn(it.e)); if (it.line) it.line.toggleAttribute('hidden', it.off); };
    const refreshEdges = () => {
        for (const item of edgeEls) refreshOff(item);
        root.dataset.edges = String(edgeEls.filter((i) => !i.off).length);
        paintHot();
        place();
    };
    const setHidden = (set) => {
        hidden = new Set(set);
        for (const d of drawn.values()) d.g.toggleAttribute('hidden', isHidden(d.n));
        refreshEdges();
        paintGroups();
        if (query) search(query, false);
    };
    const setHiddenRel = (set) => { hiddenRel = new Set(set); refreshEdges(); paintRelTypes(); };

    // -- the timeline: records come and go with the playhead --
    // `shown` is a Set of keys (null: all), `edgeOn(edge)` limits the links (null: by their ends). New records start beside the
    // neighbours that are already there and fade in; leaving ones fade out. Zoom, pan, dragged positions and the positions of
    // everything that stays are untouched, and the simulation only gets a nudge (it goes back to sleep on its own).
    const setTime = (shown, edgeOn, opts = {}) => {
        const quiet = Boolean(opts.quiet) || reduced();
        timeOn = edgeOn || null;
        const entering = [];
        let left = 0;
        for (const n of nodes) {
            const on = !shown || shown.has(n.key) || n.key === o.centerKey;
            if (on && n.gone) entering.push(n);
            else if (!on && !n.gone) { n.gone = true; left += 1; drawn.get(n.key).g.classList.add('is-gone'); }
        }
        let j = 0;
        let pending = entering;
        for (let pass = 0; pass < 4 && pending.length; pass += 1) {
            const rest = [];
            for (const n of pending) {
                const near = [...adj.get(n.key)].map((k) => by.get(k)).filter((m) => m && !m.gone);
                if (!near.length && pass < 3) { rest.push(n); continue; }
                if (near.length && !n.fixed) {
                    const a = j * 2.399963;
                    const r = 7 + 3 * Math.sqrt(j);
                    j += 1;
                    // beside the busiest neighbour that is already there (one place, so it never lands in empty space between two groups)
                    const host = near.reduce((b, m) => ((m.degree || 0) > (b.degree || 0) || ((m.degree || 0) === (b.degree || 0) && m.key < b.key) ? m : b));
                    n.x = host.x + Math.cos(a) * r;
                    n.y = host.y + Math.sin(a) * r;
                }
                n.vx = 0; n.vy = 0;
                n.gone = false;
            }
            pending = rest;
        }
        // A record the user dragged stays where it was put while the timeline changes what is around it.
        for (const n of nodes) if (n.dragged && !n.gone) { n.fixed = true; n.fx = n.x; n.fy = n.y; }
        clearTimeout(newTimer);
        for (const n of entering) {
            const g = drawn.get(n.key).g;
            g.classList.remove('is-gone');
            if (!quiet) g.classList.add('is-new');
        }
        if (entering.length && !quiet) newTimer = setTimeout(() => { for (const d of drawn.values()) d.g.classList.remove('is-new'); }, 1000);
        for (const n of nodes) {
            if (!n.gone) continue;
            if (n.key === selected && o.onClear) o.onClear();
            if (n.key === hovered) hover(null);
            if (n.key === linking?.from) cancelLink(false);
        }
        if (ringKey && by.get(ringKey) && by.get(ringKey).gone) { ringKey = null; gRing.setAttribute('hidden', ''); }
        sim.rebuild();
        if (opts.first) { root.dataset.time = shown ? String(shown.size) : 'all'; refreshEdges(); return; }
        autoFit = false;
        refreshEdges();
        root.dataset.time = shown ? String(shown.size) : 'all';
        if (entering.length || left) wake(entering.length ? 0.45 : 0.2);
    };

    // -- link types in the panel: every relation word in use, with how many links carry it; a click hides or shows that type --
    const relCounts = () => {
        const m = new Map();
        for (const it of edgeEls) m.set(it.rel, (m.get(it.rel) || 0) + 1);
        return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    };
    const relButtons = new Map();
    const paintRelTypes = () => { for (const [rel, b] of relButtons) b.setAttribute('aria-pressed', String(!hiddenRel.has(rel))); };
    const buildRelTypes = () => {
        const list = relCounts();
        relButtons.clear();
        relBox.replaceChildren(...(list.length ? list.map(([rel, n]) => {
            const b = h('button', { type: 'button', class: 'graph-group graph-reltype', 'data-key': `hiderel:${rel}`, onclick: () => {
                const set = new Set(hiddenRel);
                if (set.has(rel)) set.delete(rel); else set.add(rel);
                setHiddenRel(set);
                if (o.onHiddenRel) o.onHiddenRel(set);
            } }, h('span', { class: 'graph-group-text', text: rel }), h('span', { class: 'graph-count', text: String(n) }));
            relButtons.set(rel, b);
            return b;
        }) : [h('p', { class: 'muted graph-help', text: 'No links yet.' })]));
        relOptions.replaceChildren(...[...new Set(['related', 'for', 'about', 'during', ...list.map(([rel]) => rel)])].map((rel) => h('option', { value: rel })));
        paintRelTypes();
    };

    // -- a link under the pointer: the lines are thin, so the nearest line within a few pixels counts (nodes win over lines) --
    const segDist = (px, py, a, b) => {
        const dx = b.x - a.x; const dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        const t = l2 ? clamp(((px - a.x) * dx + (py - a.y) * dy) / l2, 0, 1) : 0;
        return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    };
    const edgeAt = (cx, cy, tolPx) => {
        const w = toWorld(cx, cy);
        let best = null; let bd = tolPx / scale;
        for (const it of edgeEls) {
            if (it.off) continue;
            const dd = segDist(w.x, w.y, it.na, it.nb);
            if (dd < bd) { bd = dd; best = it; }
        }
        return best;
    };
    let litEdge = [];
    const clearEdgeHover = () => {
        if (!hoverEdge) return;
        hoverEdge = null;
        for (const g of litEdge) g.classList.remove('is-near');
        litEdge = [];
        root.classList.remove('over-edge');
        root.classList.toggle('has-hover', Boolean(hovered));
        if (!hovered) tip.hidden = true;
        paintHot();
    };
    const setEdgeHover = (it, at) => {
        if (it !== hoverEdge) {
            clearEdgeHover();
            hoverEdge = it;
            for (const n of [it.na, it.nb]) { const g = drawn.get(n.key).g; g.classList.add('is-near'); litEdge.push(g); }
            root.classList.add('over-edge', 'has-hover');
            tip.textContent = edgeText(it);
            tip.hidden = false;
            paintHot();
        }
        const r = el.getBoundingClientRect();
        tip.style.left = `${clamp(at.x - r.left, 8, r.width - 8).toFixed(0)}px`;
        tip.style.top = `${Math.max(at.y - r.top - 14, 22).toFixed(0)}px`;
    };
    let moveTimer = 0;
    let lastMove = null;
    const idleMove = (e) => {
        if (nodeAt(e.target)) { if (hoverEdge) clearEdgeHover(); return; }
        lastMove = { x: e.clientX, y: e.clientY };
        if (moveTimer) return;
        moveTimer = setTimeout(() => {
            moveTimer = 0;
            const it = edgeAt(lastMove.x, lastMove.y, 6);
            if (it) setEdgeHover(it, lastMove); else clearEdgeHover();
        }, 40);
    };
    const focusOn = (key) => {
        const n = by.get(key);
        if (!n) return;
        used();
        goTo({ cx: n.x, cy: n.y, k: Math.max(view.k, 1.3) }, true);
    };
    // Search: matching titles stay bright (and show their text), the rest dims; `zoom` also moves the view to them.
    const search = (text, zoom) => {
        query = String(text || '').trim().toLowerCase();
        const hits = [];
        for (const d of drawn.values()) {
            const on = Boolean(query) && !isHidden(d.n) && !d.n.gone && d.n.title.toLowerCase().includes(query);
            d.g.classList.toggle('is-match', on);
            if (on) hits.push(d.n);
        }
        root.classList.toggle('has-search', Boolean(query));
        found.textContent = query ? plural(hits.length, 'match', 'matches') : '';
        if (zoom && hits.length) { used(); goTo(viewFor(hits, 300, 200, 2.4), true); }
    };
    const tap = (key, at) => {
        if (linking) { pickTarget(key, at); return; }
        const now = Date.now();
        if (last.key === key && now - last.t < DOUBLE_MS) { last = { key: null, t: 0 }; o.onFocus(key); return; }
        last = { key, t: now };
        o.onSelect(key);
    };

    // -- editing links: nothing below runs unless Edit links is on, and the two writes (create, remove) happen only from a button,
    // Enter in the popover or the confirm: never from hover, drag of a node, zoom or select --
    const screenOf = (n) => {
        const r = rect(); const dm = dims();
        return { x: r.left + ((n.x - (view.cx - dm.vw / 2)) / dm.vw) * dm.w, y: r.top + ((n.y - (view.cy - dm.vh / 2)) / dm.vh) * dm.hh };
    };
    const placeRing = () => {
        const d = drawn.get(ringKey);
        gRing.setAttribute('transform', `translate(${r1(d.n.x)} ${r1(d.n.y)})`);
        const rr = (d.r + 5 / scale).toFixed(2);
        ringVis.setAttribute('r', rr); ringHit.setAttribute('r', rr);
    };
    // The ring shows around the hovered or focused record, the one a link is being drawn from, or the one picked to start from.
    const paintRing = () => {
        const k = !editing ? null : gesture && gesture.type === 'link' ? gesture.key : linking ? linking.from : hovered;
        ringKey = k && by.get(k) && !isHidden(by.get(k)) ? k : null;
        gRing.toggleAttribute('hidden', !ringKey);
        if (ringKey) placeRing();
    };
    const drawDraft = () => {
        const a = by.get(draft.a); const b = by.get(draft.b);
        rubber.setAttribute('x1', r1(a.x)); rubber.setAttribute('y1', r1(a.y)); rubber.setAttribute('x2', r1(b.x)); rubber.setAttribute('y2', r1(b.y));
    };
    let target = null;
    const markTarget = (elm, from) => {
        const k = nodeAt(elm);
        const nk = k && k !== from && !isHidden(by.get(k)) ? k : null;
        if (nk === target) return;
        if (target && drawn.get(target)) drawn.get(target).g.classList.remove('is-target');
        target = nk;
        if (target) drawn.get(target).g.classList.add('is-target');
    };
    const startRubber = (key) => {
        const n = by.get(key);
        rubber.setAttribute('x1', r1(n.x)); rubber.setAttribute('y1', r1(n.y)); rubber.setAttribute('x2', r1(n.x)); rubber.setAttribute('y2', r1(n.y));
        rubber.removeAttribute('hidden');
        el.classList.add('is-linking-drag');
    };
    const endRubber = () => {
        markTarget(null, null);
        if (!draft) rubber.setAttribute('hidden', '');
        el.classList.remove('is-linking-drag');
    };
    const closePop = (refocus) => {
        if (!pop) return;
        const from = pop.from;
        pop.form.remove();
        pop = null;
        draft = null;
        rubber.setAttribute('hidden', '');
        if (refocus && drawn.get(from)) drawn.get(from).g.focus({ preventScroll: true });
    };
    const openPop = (fromKey, toKey, at) => {
        if (!editing) return;
        closePop();
        const a = by.get(fromKey); const b = by.get(toKey);
        const rel = h('input', { type: 'text', name: 'rel', id: 'graph-pop-rel', class: 'graph-search', value: 'related', maxlength: '30', autocomplete: 'off', spellcheck: 'false', list: 'graph-pop-rels', 'aria-describedby': 'graph-pop-err', 'data-key': 'graph-pop-rel' });
        const note = h('input', { type: 'text', name: 'note', id: 'graph-pop-note', class: 'graph-search', maxlength: '200', placeholder: 'Optional', autocomplete: 'off', 'data-key': 'graph-pop-note' });
        const err = h('p', { id: 'graph-pop-err', class: 'graph-pop-err', role: 'alert', 'data-key': 'graph-pop-err' });
        const go = h('button', { type: 'submit', class: 'btn small', 'data-key': 'graph-pop-create', text: 'Create' });
        const form = h('form', { class: 'graph-pop', role: 'dialog', 'aria-label': 'Create a link', 'data-key': 'graph-pop', novalidate: '' },
            h('div', { class: 'graph-pop-ends' },
                h('span', { class: 'muted', text: 'From' }), h('strong', { text: clipText(a.title, 44) }),
                h('span', { class: 'muted', text: 'To' }), h('strong', { text: clipText(b.title, 44) })),
            h('div', { class: 'graph-pop-field' }, h('label', { for: 'graph-pop-rel', text: 'Relation' }), rel),
            h('div', { class: 'graph-pop-field' }, h('label', { for: 'graph-pop-note', text: 'Note' }), note),
            err,
            h('div', { class: 'graph-actions' }, go, h('button', { type: 'button', class: 'btn quiet small', 'data-key': 'graph-pop-cancel', onclick: () => closePop(true), text: 'Cancel' })));
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const word = rel.value.trim().toLowerCase() || 'related';
            if (!REL_RE.test(word)) {
                err.textContent = 'Use one short lowercase word (letters, numbers, - or _), such as for, about or during.';
                rel.setAttribute('aria-invalid', 'true');
                rel.focus();
                return;
            }
            rel.removeAttribute('aria-invalid');
            err.textContent = '';
            go.disabled = true;
            try {
                const text = note.value.trim() || undefined;
                const r = await o.api.create({ from: { domain: a.domain, id: a.id }, to: { domain: b.domain, id: b.id }, rel: word, note: text });
                closePop(true);
                if (r.status === 'created') {
                    const it = addEdge({ id: r.id, from: r.from, to: r.to, rel: r.rel, ...(text ? { note: text } : {}) });
                    toast('Link created');
                    if (it) selectEdgeItem(it);
                } else {
                    toast('Already linked');
                    const it = edgeEls.find((x) => x.id === r.id);
                    if (it) selectEdgeItem(it);
                }
            } catch (e2) {
                err.textContent = e2.message || 'Could not create the link.';
                go.disabled = false;
            }
        });
        el.append(form);
        const r = el.getBoundingClientRect();
        const at2 = at || screenOf(b);
        form.style.left = `${clamp(at2.x - r.left + 10, 8, Math.max(r.width - form.offsetWidth - 8, 8)).toFixed(0)}px`;
        form.style.top = `${clamp(at2.y - r.top + 10, 8, Math.max(r.height - form.offsetHeight - 8, 8)).toFixed(0)}px`;
        pop = { form, from: fromKey };
        draft = { a: fromKey, b: toKey };
        drawDraft();
        rubber.removeAttribute('hidden');
        rel.focus();
        rel.select();
    };
    // Picking the other end without dragging (keyboard: L, tap: "Link from here"): the next record chosen opens the same popover.
    const sourceLit = () => { for (const d of drawn.values()) d.g.classList.toggle('is-source', Boolean(linking) && d.n.key === linking.from); };
    const startLink = (key) => {
        if (!editing || !by.get(key)) return;
        closePop();
        linking = { from: key };
        el.classList.add('is-linking');
        badgeSub.textContent = `Linking from “${clipText(by.get(key).title, 30)}”. Pick the other record. Esc cancels.`;
        badgeCancel.hidden = false;
        sourceLit();
        paintRing();
    };
    const endPick = () => {
        linking = null;
        el.classList.remove('is-linking');
        badgeSub.textContent = '';
        badgeCancel.hidden = true;
        sourceLit();
        paintRing();
    };
    const cancelLink = (refocus) => {
        const from = linking && linking.from;
        endPick();
        endRubber();
        closePop();
        if (refocus && from && drawn.get(from)) drawn.get(from).g.focus({ preventScroll: true });
    };
    const pickTarget = (key, at) => {
        if (!linking) return;
        const from = linking.from;
        if (key === from) { cancelLink(true); return; }
        endPick();
        openPop(from, key, at || screenOf(by.get(key)));
    };
    const setEditing = (on) => {
        if (on === editing) return;
        if (!on) { cancelLink(false); closePop(); }
        editing = on;
        editBtn.setAttribute('aria-pressed', String(on));
        editBtn.title = on ? 'Stop editing links (E)' : 'Edit links (E)';
        el.classList.toggle('is-editing', on);
        badge.hidden = !on;
        if (tl) tl.setEditing(on);
        paintRing();
        if (o.onEdit) o.onEdit(on);
    };

    // The only places the picture changes after a write: the arrays, the drawn parts and the simulation are patched, the view and
    // every position stay as they are, and the simulation is woken so the two ends settle closer (or apart).
    const afterEdgeChange = () => {
        maxDeg = Math.max(1, ...nodes.map((n) => n.degree || 0));
        for (const n of nodes) drawn.get(n.key).g.setAttribute('aria-label', ariaFor(n));
        sim.rebuild();
        autoFit = false;
        if (tl) tl.recompute();
        buildRelTypes();
        refreshEdges();
        paintSizes();
        if (o.onEdges) o.onEdges();
        wake(0.8);
    };
    const addEdge = (e) => {
        if (edgeEls.some((x) => x.id === e.id)) return edgeEls.find((x) => x.id === e.id);
        e.created_at = e.created_at || new Date().toISOString();
        e.fresh = true;   // a link made now stays on the picture whatever the playhead says
        const it = addItem(e);
        if (!it) return null;
        edges.push(e);
        it.na.degree = (it.na.degree || 0) + 1;
        it.nb.degree = (it.nb.degree || 0) + 1;
        if (gLines.firstChild || settings.arrows) { it.line = svg('line', { class: 'graph-edge' }); gLines.append(it.line); }
        afterEdgeChange();
        return it;
    };
    const removeEdge = (id) => {
        const it = edgeEls.find((x) => x.id === id);
        if (!it) return;
        if (it === selEdge) { applySel(null, null); if (o.onClear) o.onClear(); }
        if (it === hoverEdge) clearEdgeHover();
        edgeEls.splice(edgeEls.indexOf(it), 1);
        edges.splice(edges.indexOf(it.e), 1);
        for (const k of [it.a, it.b]) inc.set(k, inc.get(k).filter((x) => x !== it));
        if (!edgeEls.some((x) => (x.a === it.a && x.b === it.b) || (x.a === it.b && x.b === it.a))) { adj.get(it.a).delete(it.b); adj.get(it.b).delete(it.a); }
        it.na.degree = Math.max((it.na.degree || 1) - 1, 0);
        it.nb.degree = Math.max((it.nb.degree || 1) - 1, 0);
        if (it.line) it.line.remove();
        if (it.lab) it.lab.remove();
        afterEdgeChange();
    };
    const removeLink = async (id) => {
        if (!editing) throw new Error('Turn on Edit links first.');
        await o.api.remove(id);
        removeEdge(id);
        toast('Link removed');
    };

    // -- the live part: one animation frame per step while awake, none at all while asleep --
    const sim = createSim(nodes, edges, o.anchors || new Map(), { center: settings.center, repel: settings.repel, link: settings.link, linkDist: settings.linkDist });
    const frame = () => {
        raf = 0;
        const t0 = performance.now();
        sim.step();
        place();
        if (autoFit && ready) {
            const to = fitView();
            view.cx += (to.cx - view.cx) * 0.12;
            view.cy += (to.cy - view.cy) * 0.12;
            view.k = Math.exp(Math.log(view.k) + (Math.log(to.k) - Math.log(view.k)) * 0.12);
            apply();
        }
        const spent = performance.now() - t0;
        stepMs = Math.max(stepMs, spent);
        spentMs += spent;
        root.dataset.avgMs = (spentMs / sim.ticks).toFixed(1);
        root.dataset.ticks = String(sim.ticks);
        root.dataset.stepMs = stepMs.toFixed(1);
        if (sim.asleep()) { root.dataset.sim = 'asleep'; if (autoFit && ready) { autoFit = false; goTo(fitView(), true); } } else raf = requestAnimationFrame(frame);
    };
    const wake = (heat) => {
        if (heat) sim.alpha = Math.max(sim.alpha, heat);
        if (reduced() && !sim.target) { sim.settle(); place(); return; }
        if (!raf && !sim.asleep()) { root.dataset.sim = 'awake'; raf = requestAnimationFrame(frame); }
    };
    // Starts the settle again from the seeds.
    const replay = () => {
        for (const n of nodes) { n.x = n.sx; n.y = n.sy; n.vx = 0; n.vy = 0; }
        sim.alpha = 1; sim.target = 0;
        autoFit = true; ready = true;
        stepMs = 0;
        goTo(fitView(), false);
        place();
        wake(1);
    };

    // -- pointers: one pointer pans or drags a node, two pinch --
    const ptrs = new Map();
    let gesture = null;
    let pinch = null;
    const nodeAt = (target) => {
        if (!target || !target.closest) return null;
        const g = target.closest('.graph-node');
        if (g) return g.getAttribute('data-key').slice(5);
        return ringKey && target.closest('.graph-ring') ? ringKey : null;   // the ring belongs to its record
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
        // Pressing the ring of a record (edit mode only) starts a new link from it; the body of the node still moves it.
        if (editing && ringKey && e.target.closest && e.target.closest('.graph-ring')) { gesture = { type: 'link', key: ringKey, sx: e.clientX, sy: e.clientY, moved: false }; clearEdgeHover(); return; }
        const key = nodeAt(e.target);
        gesture = { type: key ? 'node' : 'pan', key, sx: e.clientX, sy: e.clientY, moved: false };
        clearEdgeHover();
        hover(null);
    });
    root.addEventListener('pointermove', (e) => {
        const p = ptrs.get(e.pointerId);
        if (!p || !gesture) { if (!gesture && !ptrs.size && e.pointerType !== 'touch') idleMove(e); return; }
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
        if (gesture.type === 'link') {
            if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < DRAG_PX) return;
            if (!gesture.moved) { gesture.moved = true; used(); startRubber(gesture.key); }
            const w = toWorld(e.clientX, e.clientY);
            rubber.setAttribute('x2', r1(w.x)); rubber.setAttribute('y2', r1(w.y));
            markTarget(document.elementFromPoint(e.clientX, e.clientY), gesture.key);
            return;
        }
        if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < DRAG_PX) return;
        if (!gesture.moved) {
            gesture.moved = true;
            used();
            if (gesture.type === 'node') { const n = by.get(gesture.key); n.fixed = true; n.fx = n.x; n.fy = n.y; sim.target = 0.45; wake(0.45); }
        }
        if (gesture.type === 'pan') { panBy(dx, dy); return; }
        const n = by.get(gesture.key);
        const d = dims();
        n.fx += (dx / d.w) * d.vw;
        n.fy += (dy / d.hh) * d.vh;
        if (!raf) { n.x = n.fx; n.y = n.fy; place(); }
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
        if (g && g.type === 'link') {
            const to = g.moved && !cancelled ? nodeAt(document.elementFromPoint(e.clientX, e.clientY)) : null;
            endRubber();
            if (to && to !== g.key && !isHidden(by.get(to))) openPop(g.key, to, { x: e.clientX, y: e.clientY });
            paintRing();
            return;
        }
        if (g && g.type === 'pan' && !g.moved && !cancelled) {
            const it = edgeAt(e.clientX, e.clientY, e.pointerType === 'touch' ? 12 : 6);
            if (it) selectEdgeItem(it); else if (linking) cancelLink(true);
        }
        if (g && g.type === 'node' && g.moved) {
            const n = by.get(g.key);
            n.fixed = Boolean(n.pinned);
            n.fx = n.x; n.fy = n.y;
            n.dragged = true;   // the timeline holds it where it was put
            sim.target = 0;
            wake(0.3);
        }
        if (g && g.type === 'node' && !g.moved && !cancelled) tap(g.key, { x: e.clientX, y: e.clientY });
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
    root.addEventListener('pointerleave', () => { if (!gesture) { hover(null); clearEdgeHover(); } });
    root.addEventListener('focusin', (e) => {
        const key = nodeAt(e.target);
        if (!key) return;
        const n = by.get(key);
        const d = dims();
        const inside = Math.abs(n.x - view.cx) < d.vw / 2 - 30 && Math.abs(n.y - view.cy) < d.vh / 2 - 30;
        // While the picture is still fitting itself (e.g. the page gives focus back to a node after a redraw) the view is left alone.
        if (!inside && !autoFit) { view.cx = n.x; view.cy = n.y; apply(); }
        hover(key);
    });
    root.addEventListener('focusout', () => hover(null));

    // -- keyboard: Enter selects a node, arrows pan, + and - zoom, 0 resets, Escape closes the panel, then the card --
    el.addEventListener('keydown', (e) => {
        if (e.target.closest && e.target.closest('button, input, summary')) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const key = nodeAt(e.target);
        if (editing && key && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); startLink(key); return; }
        if (e.key === ' ' && !key && tl.isOpen() && e.target === root) { e.preventDefault(); tl.playToggle(); return; }
        if ((e.key === 'Enter' || e.key === ' ') && key) {
            e.preventDefault();
            if (linking) pickTarget(key, screenOf(by.get(key))); else if (e.shiftKey) o.onFocus(key); else o.onSelect(key);
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && editing && selEdge) { e.preventDefault(); if (o.onSelectEdge) o.onSelectEdge(selEdge.e, { confirm: true }); return; }
        const d = dims();
        const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        // While picking the other end, the arrows move to the nearest record that way instead of panning.
        if (move && linking && key) {
            e.preventDefault();
            const from = by.get(key);
            let best = null; let bs = Infinity;
            for (const dd of drawn.values()) {
                const n = dd.n;
                if (n === from || isHidden(n)) continue;
                const vx = n.x - from.x; const vy = n.y - from.y;
                const along = vx * move[0] + vy * move[1];
                if (along <= 1) continue;
                const sc = along + 2 * Math.abs(vx * move[1] - vy * move[0]);
                if (sc < bs) { bs = sc; best = n; }
            }
            if (best) drawn.get(best.key).g.focus();
            return;
        }
        if (move) { e.preventDefault(); used(); goTo({ cx: view.cx + move[0] * d.vw * 0.15, cy: view.cy + move[1] * d.vh * 0.15, k: view.k }, false); return; }
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.4); } else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.4); } else if (e.key === '0') { e.preventDefault(); fit(true); }
    });
    const onEsc = (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
        if (pop || linking || (gesture && gesture.type === 'link')) { e.preventDefault(); cancelLink(true); return; }
        if (!panel.hidden) { e.preventDefault(); togglePanel(false); return; }
        if (editing) { e.preventDefault(); setEditing(false); return; }
        if ((selected || selEdge) && o.onClear) { e.preventDefault(); o.onClear(); }
    };
    document.addEventListener('keydown', onEsc);
    // E turns Edit links on and off (not while typing in a field).
    const onEdit = (e) => {
        if ((e.key !== 'e' && e.key !== 'E') || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
        if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        setEditing(!editing);
    };
    document.addEventListener('keydown', onEdit);
    // T opens and closes the timeline (not while typing in a field).
    const onTime = (e) => {
        if ((e.key !== 't' && e.key !== 'T') || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
        if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        tl.toggle();
    };
    document.addEventListener('keydown', onTime);

    // The size is only known once the canvas is on the page: fit then, and keep the view in step with later resizes.
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        if (!measure()) return;
        if (!ready) {
            ready = true;
            goTo(fitView(), false);
            root.setAttribute('data-ready', '1');
            if (reduced()) { sim.settle(); place(); fit(false); } else wake();
        } else apply();
    }) : null;
    if (watch) watch.observe(root);
    buildRelTypes();
    // The timeline bar (docked at the bottom of the canvas); the details card and the hint make room for it.
    tl = createTimeline({ nodes, edges, centerKey: o.centerKey, at: o.at, countable: (n) => !isHidden(n), reduced, apply: (shown, edgeOn, opts) => setTime(shown, edgeOn, { ...opts, first: !ready }), onAt: (v) => { if (o.onAt) o.onAt(v); },
        onOpen: (on) => { el.classList.toggle('has-timeline', on); tlBtn.setAttribute('aria-pressed', String(on)); tlBtn.title = on ? 'Close the timeline (T)' : 'Timeline (T)'; barHeight(); } });
    el.append(tl.el);
    const barHeight = () => el.style.setProperty('--tl-h', `${tl.el.hidden ? 0 : Math.ceil(tl.el.getBoundingClientRect().height)}px`);
    const barWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(barHeight) : null;
    if (barWatch) barWatch.observe(tl.el);
    setHidden(hidden);
    setSelected(selected);
    paintSizes();
    if (o.at) tl.open();
    return { el, timeline: tl, setTime, setSelected, setSelectedEdge, setHidden, setHiddenRel, setEditing, isEditing: () => editing, startLink, removeLink, fit, zoomBy, focusOn, search, replay, sim, togglePanel,
        destroy: () => { cancelAnimationFrame(tween); cancelAnimationFrame(raf); clearTimeout(searchTimer); clearTimeout(moveTimer); document.removeEventListener('keydown', onEsc); document.removeEventListener('keydown', onEdit); document.removeEventListener('keydown', onTime); clearTimeout(newTimer); if (tl) tl.destroy(); if (barWatch) barWatch.disconnect(); if (watch) watch.disconnect(); } };
}
