// The Graph's timeline: a slim bar at the bottom of the canvas with a playhead, "show everything up to this date". Records (a node
// shows when its date is on or before the playhead) or Links (a node shows once one of its links has been recorded, by the link's
// created_at). Records with no date (entities, places, preferences...) show with their first visible neighbour, or always when
// asked. The bar only decides WHAT is shown (`apply(shown, edgeOn)`); the canvas fades the records in and out and keeps every
// position, the zoom and the pan. The playhead is `at` ('YYYY-MM-DD'), or null for everything (live). No libraries.
import { h, icon } from '../ui.js';

const DAY = 86400000;
const PLAY_MS = 12000;   // the whole span takes this long at 1x
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY);
export const dayStr = (n) => new Date(n * DAY).toISOString().slice(0, 10);
export const validDay = (s) => typeof s === 'string' && DAY_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && dayStr(dayNum(s)) === s;
export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmt = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const linkDay = (e) => (e.created_at ? String(e.created_at).slice(0, 10) : null);

// The days on which something happens, sorted and unique: record dates (Records) or link dates (Links).
export function eventDays(nodes, edges, mode) {
    const days = new Set();
    if (mode === 'links') { for (const e of edges) { const d = linkDay(e); if (d && DAY_RE.test(d)) days.add(d); } } else { for (const n of nodes) if (n.t && DAY_RE.test(n.t)) days.add(n.t); }
    return [...days].sort();
}

// What the playhead shows. `shown` is a Set of node keys (null = everything), `edgeOn(edge)` says whether a link exists yet
// (null = by its two ends). The focused record (`centerKey`) is always shown.
export function computeShown({ nodes, edges, at, mode, undated, centerKey }) {
    if (at == null) return { shown: null, edgeOn: null };
    const shown = new Set();
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    if (centerKey) shown.add(centerKey);
    if (mode === 'links') {
        const edgeOn = (e) => Boolean(e.fresh) || !linkDay(e) || linkDay(e) <= at;
        for (const e of edges) if (edgeOn(e)) { shown.add(e.from); shown.add(e.to); }
        return { shown, edgeOn };
    }
    for (const n of nodes) { if (n.t) { if (n.t <= at) shown.add(n.key); } else if (undated) shown.add(n.key); }
    // Undated records come in next to a dated record that is already shown (they have no moment of their own).
    if (!undated) {
        const dated = new Set(shown);
        for (const e of edges) {
            const a = byKey.get(e.from); const b = byKey.get(e.to);
            if (a && b && !a.t && b.t && dated.has(e.to)) shown.add(e.from);
            if (a && b && !b.t && a.t && dated.has(e.from)) shown.add(e.to);
        }
    }
    return { shown, edgeOn: null };
}

// o: { nodes, edges, centerKey, at (initial playhead or null), apply(shown, edgeOn, { quiet }), countable(node), reduced(), onAt(at) (the URL),
//      onOpen(open) }
//   -> { el, open, close, toggle, isOpen, setEditing, recompute, at, destroy }
export function createTimeline(o) {
    const { nodes, edges } = o;
    const today = localToday();
    let at = validDay(o.at) ? o.at : null;
    let mode = 'records';
    let undated = false;
    let speed = 1;
    let playing = false;
    let opened = false;
    let editing = false;
    let pos = 0;           // playing: days since the start of the span (fractional)
    let raf = 0;
    let lastTs = 0;
    let urlTimer = 0;
    let range = { min: null, end: today };

    const spanOf = () => {
        const days = eventDays(nodes, edges, mode);
        const min = days[0] || null;
        const end = [days[days.length - 1] || today, today].sort().pop();
        return { min, end, days };
    };

    const key = (k) => ({ 'data-key': k });
    const btn = (k, label, kids, fn, cls = 'graph-btn') => h('button', { type: 'button', class: cls, 'aria-label': label, title: label, ...key(k), onclick: fn }, kids);
    const playBtn = btn('graph-tl-play', 'Play', icon('play'), () => (playing ? pause() : play()));
    const prevBtn = btn('graph-tl-prev', 'Previous dated record', icon('skipBack'), () => step(-1));
    const nextBtn = btn('graph-tl-next', 'Next dated record', icon('skipForward'), () => step(1));
    const slider = h('input', { type: 'range', class: 'graph-tl-range', min: '0', max: '0', step: '1', value: '0', ...key('graph-tl-range'), 'aria-label': 'Show records up to this date' });
    const resetBtn = h('button', { type: 'button', class: 'graph-tl-btn', ...key('graph-tl-reset'), title: 'Show everything again', onclick: () => reset(), text: 'Reset' });
    const closeBtn = btn('graph-tl-close', 'Close the timeline (T)', icon('close'), () => close());
    const readout = h('p', { class: 'graph-tl-readout', role: 'status', 'aria-live': 'polite', ...key('graph-tl-readout') });
    const seg = (m, text) => h('button', { type: 'button', class: 'graph-seg-btn', ...key(`graph-tl-mode-${m}`), 'aria-pressed': String(mode === m), onclick: () => setMode(m), text });
    const segRecords = seg('records', 'Records');
    const segLinks = seg('links', 'Links');
    const modeSeg = h('div', { class: 'graph-seg', role: 'group', 'aria-label': 'What the playhead follows' }, segRecords, segLinks);
    const undatedBox = h('input', { type: 'checkbox', ...key('graph-tl-undated'), onchange: () => { undated = undatedBox.checked; if (at != null) apply(true); } });
    const undatedLabel = h('label', { class: 'graph-tl-check' }, undatedBox, h('span', { text: 'Undated records' }));
    const speedSel = h('select', { class: 'graph-tl-speed', 'aria-label': 'Play speed', ...key('graph-tl-speed'), onchange: () => { speed = Number(speedSel.value) || 1; } },
        [1, 2, 4].map((v) => h('option', { value: String(v), text: `${v}×` })));
    const hint = h('p', { class: 'graph-tl-hint', ...key('graph-tl-hint') });
    const note = h('p', { class: 'graph-tl-note', role: 'status', ...key('graph-tl-note'), text: 'New links are dated today.' });
    note.hidden = true;
    const optBtn = h('button', { type: 'button', class: 'graph-tl-btn graph-tl-optbtn', ...key('graph-tl-options'), 'aria-expanded': 'false', onclick: () => {
        const on = !bar.classList.contains('opts-open');
        bar.classList.toggle('opts-open', on);
        optBtn.setAttribute('aria-expanded', String(on));
    }, text: 'Options' });
    const opts = h('div', { class: 'graph-tl-opts' }, modeSeg, undatedLabel, speedSel, resetBtn);
    const bar = h('div', { class: 'graph-tl', role: 'group', 'aria-label': 'Timeline', ...key('graph-timeline') },
        h('div', { class: 'graph-tl-row' },
            h('div', { class: 'graph-tl-transport' }, playBtn, prevBtn, nextBtn), slider,
            h('div', { class: 'graph-tl-end' }, closeBtn)),
        h('div', { class: 'graph-tl-row graph-tl-row2' }, readout, optBtn, opts),
        h('div', { class: 'graph-tl-row graph-tl-row3' }, hint, note));
    bar.hidden = true;

    const paintHint = () => {
        const r = range;
        const span = r.min ? `Dated ${mode === 'links' ? 'links' : 'records'} run from ${fmt(r.min)} to ${fmt(r.end)}. ` : `No ${mode === 'links' ? 'link' : 'record'} here has a date. `;
        hint.textContent = mode === 'links'
            ? `${span}A record shows once one of its links was recorded.`
            : `${span}Undated records (entities, places, preferences) show next to a dated record that is already visible${undated ? ' — or always, as asked' : ''}.`;
        undatedBox.disabled = mode === 'links';
        undatedLabel.classList.toggle('is-off', mode === 'links');
    };
    const paintNote = () => { note.hidden = !(opened && editing && at != null && at < today); };
    const dateText = () => (at == null ? 'Everything' : fmt(at));
    const paintReadout = (n, m) => {
        readout.textContent = `${dateText()} · ${n} of ${m} records shown`;
        slider.setAttribute('aria-valuetext', at == null ? 'Everything (live)' : fmt(at));
    };
    const paintSlider = () => {
        const { min, end } = range;
        const total = min ? Math.max(dayNum(end) - dayNum(min), 0) : 0;
        slider.max = String(total);
        slider.disabled = !min;
        slider.value = String(at == null || !min ? total : Math.min(Math.max(dayNum(at) - dayNum(min), 0), total));
        const pct = total ? (Number(slider.value) / total) * 100 : 100;
        slider.style.setProperty('--tl-pct', `${pct.toFixed(2)}%`);
        const eventless = !min;
        playBtn.disabled = eventless; prevBtn.disabled = eventless; nextBtn.disabled = eventless;
        resetBtn.disabled = at == null;
    };
    const countNow = (r) => {
        const list = nodes.filter((n) => o.countable(n));
        return [r.shown ? list.filter((n) => r.shown.has(n.key)).length : list.length, list.length];
    };
    // Works out what is shown now, tells the canvas and repaints the bar.
    const apply = (animate = true) => {
        const r = computeShown({ nodes, edges, at, mode, undated, centerKey: o.centerKey });
        o.apply(r.shown, r.edgeOn, { quiet: !animate || o.reduced() });
        const [n, m] = countNow(r);
        paintReadout(n, m);
        paintSlider();
        paintNote();
        bar.dataset.at = at || '';
        bar.dataset.shown = String(n);
    };
    const pushUrl = (now) => {
        clearTimeout(urlTimer);
        const go = () => { if (o.onAt) o.onAt(at); };
        if (now) go(); else urlTimer = setTimeout(go, 300);
    };
    const setAt = (next, { url = true, animate = true } = {}) => {
        const v = next != null && validDay(next) && range.min && next < range.end ? next : null;
        if (v === at) { paintSlider(); return; }
        at = v;
        apply(animate);
        if (url) pushUrl(false);
    };
    const reflow = () => { range = spanOf(); };

    const pause = () => {
        if (!playing) return;
        playing = false;
        cancelAnimationFrame(raf); raf = 0;
        playBtn.replaceChildren(icon('play'));
        playBtn.setAttribute('aria-label', 'Play'); playBtn.title = 'Play';
        bar.classList.remove('is-playing');
        readout.setAttribute('aria-live', 'polite');
        pushUrl(true);
    };
    const tick = (ts) => {
        raf = 0;
        if (!playing) return;
        const total = dayNum(range.end) - dayNum(range.min);
        pos += (Math.min(ts - lastTs, 100) / (PLAY_MS / speed)) * total;
        lastTs = ts;
        if (pos >= total) { pause(); setAt(null, { url: false }); pushUrl(true); return; }
        const next = dayStr(dayNum(range.min) + Math.floor(pos));
        if (next !== at) setAt(next, { url: false });
        raf = requestAnimationFrame(tick);
    };
    const play = () => {
        if (!range.min) return;
        playing = true;
        const total = dayNum(range.end) - dayNum(range.min);
        pos = at == null || at >= range.end ? 0 : Math.max(dayNum(at) - dayNum(range.min), 0);
        if (at == null) setAt(range.min, { url: false });
        playBtn.replaceChildren(icon('pause'));
        playBtn.setAttribute('aria-label', 'Pause'); playBtn.title = 'Pause (Space)';
        bar.classList.add('is-playing');
        readout.setAttribute('aria-live', 'off');
        lastTs = performance.now();
        if (total > 0) raf = requestAnimationFrame(tick); else pause();
    };
    const step = (dir) => {
        pause();
        const days = range.days || [];
        let next = null;
        if (dir > 0) { if (at == null) return; next = days.find((d) => d > at) || null; } else {
            const before = days.filter((d) => (at == null ? d < range.end : d < at));
            next = before[before.length - 1];
            if (!next) return;
        }
        setAt(next);
        pushUrl(true);
    };
    const reset = () => { pause(); setAt(null); pushUrl(true); };
    const setMode = (m) => {
        if (m === mode) return;
        pause();
        mode = m;
        segRecords.setAttribute('aria-pressed', String(mode === 'records'));
        segLinks.setAttribute('aria-pressed', String(mode === 'links'));
        reflow();
        paintHint();
        if (at != null && range.min && at < range.min) at = range.min;
        if (at != null && at >= range.end) at = null;
        apply(true);
        pushUrl(true);
    };

    slider.addEventListener('input', () => {
        pause();
        const total = Number(slider.max);
        const v = Number(slider.value);
        setAt(v >= total ? null : dayStr(dayNum(range.min) + v));
    });
    slider.addEventListener('change', () => pushUrl(true));
    // Space plays and pauses while the slider has focus (a button keeps its own Space).
    slider.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggle2(); } });
    const toggle2 = () => (playing ? pause() : play());

    const open = () => {
        if (opened) return;
        opened = true;
        bar.hidden = false;
        reflow();
        paintHint();
        apply(false);
        if (o.onOpen) o.onOpen(true);
    };
    const close = () => {
        if (!opened) return;
        pause();
        opened = false;
        bar.hidden = true;
        at = null;
        apply(true);
        paintNote();
        pushUrl(true);
        if (o.onOpen) o.onOpen(false);
    };
    const toggle = () => (opened ? close() : open());
    // The links changed (one was added or removed): the span and what is shown are worked out again.
    const recompute = () => { if (!opened) return; reflow(); paintHint(); apply(false); };
    const setEditing = (on) => { editing = on; paintNote(); };
    if (at != null) { reflow(); if (!range.min || at >= range.end) at = null; }

    return { el: bar, open, close, toggle, isOpen: () => opened, setEditing, recompute, at: () => at, playToggle: toggle2, isPlaying: () => playing,
        destroy: () => { clearTimeout(urlTimer); cancelAnimationFrame(raf); playing = false; } };
}
