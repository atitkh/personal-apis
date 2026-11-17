// Tiny inline SVG charts. No library: a chart is a few rects. Colours come from CSS (hue-* classes),
// so light and dark themes just work.
import { h, svg, dayLabel, plural, roving } from './ui.js';

// Stacked bars, one per day. data: [{ day, total, parts: [{ hue, value, label }] }].
export function dayBars({ data, ariaLabel, height = 72, unit = 'call' }) {
    const slot = 12;
    const bar = 8;
    const max = Math.max(1, ...data.map((d) => d.total));
    const width = data.length * slot;
    const bars = data.map((d, i) => {
        const x = i * slot + (slot - bar) / 2;
        let y = height;
        const rects = [];
        for (const p of d.parts) {
            if (!p.value) continue;
            const hgt = Math.max(2, (p.value / max) * (height - 4));
            y -= hgt;
            rects.push(svg('rect', { class: `bar hue-${p.hue}`, x, y, width: bar, height: hgt, rx: 1.5 }));
        }
        if (!rects.length) rects.push(svg('rect', { class: 'bar empty', x, y: height - 2, width: bar, height: 2, rx: 1 }));
        const detail = d.parts.filter((p) => p.value).map((p) => `${p.label} ${p.value}`).join(', ');
        return svg('g', {}, svg('title', { text: `${dayLabel(d.day)}: ${plural(d.total, unit)}${detail ? ` (${detail})` : ''}` }), rects);
    });
    return h('figure', { class: 'chart' },
        svg('svg', { class: 'bars', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': ariaLabel }, bars),
        h('figcaption', { class: 'chart-axis' },
            h('span', { text: data.length ? dayLabel(data[0].day) : '' }),
            h('span', { text: 'Today' })));
}

// One cell per day, present or missing; one tab stop, arrow keys move between days (it starts on the newest).
// Present days are links; missing days can be focused so they are heard, but go nowhere.
export function coverageStrip({ days, ariaLabel, href }) {
    const cells = days.map((d) => {
        const text = `${dayLabel(d.day, { weekday: 'long', month: 'long', day: 'numeric' })}: ${d.present ? 'digest' : 'missing'}`;
        return d.present && href
            ? h('a', { class: 'cell have', href: href(d.day), title: text, 'aria-label': text })
            : h('span', { class: `cell ${d.present ? 'have' : 'gap'}`, title: text, 'aria-label': text, role: 'img' });
    });
    const el = h('div', { class: 'strip', role: 'group', 'aria-label': `${ariaLabel}. Use the arrow keys to move between days.` },
        cells.map((c) => h('span', { class: 'strip-slot' }, c)));
    roving(el, cells, { start: cells.length - 1 });
    return el;
}

/* ---------- month calendar ---------- */

const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (s) => new Date(`${s}T12:00:00`);
export function addDays(day, n) {
    const d = parseDay(day);
    d.setDate(d.getDate() + n);
    return isoDay(d);
}
export function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1, 12);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export const monthLabel = (month) => parseDay(`${month}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

// A month as a grid (weeks start on Monday, like ISO weeks). One tab stop; arrows move a day or a week,
// Home/End go to the start/end of the week, PageUp/PageDown change month. Moving past the month calls
// onLeave(day) so the owner can show that month and focus the day.
// status(day) -> 'have' | 'gap' (missing) | 'before' (before digests began) | 'future' | 'today'
// `selected`: days to mark as the one being read (the reader's day, or the days of its week).
export function monthCalendar({ month, status, href, focusDay, onLeave, label, selected = [] }) {
    const [y, m] = month.split('-').map(Number);
    const daysIn = new Date(y, m, 0).getDate();
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday = 0
    const today = isoDay(new Date());
    const WORDS = { have: 'digest', gap: 'missing', before: 'before digests began', future: 'not yet', today: 'today, written tonight' };

    const days = Array.from({ length: daysIn }, (_, i) => `${month}-${pad(i + 1)}`);
    const cells = days.map((day) => {
        const st = status(day);
        const text = `${dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })}: ${WORDS[st] || st}`;
        const sel = selected.includes(day);
        const props = { class: `cal-day ${st}${day === today ? ' is-today' : ''}${sel ? ' is-selected' : ''}`, 'aria-label': sel ? `${text}, open now` : text, title: text, 'data-day': day };
        if (sel) props['aria-current'] = 'date';
        const kids = [h('span', { class: 'cal-num', text: String(Number(day.slice(8))), 'aria-hidden': 'true' }),
            st === 'gap' ? h('span', { class: 'cal-mark', 'aria-hidden': 'true', text: 'missing' }) : null];
        return st === 'have' && href ? h('a', { ...props, href: href(day) }, kids) : h('span', { ...props, role: 'img' }, kids);
    });

    const weekdays = Array.from({ length: 7 }, (_, i) => parseDay(addDays('2026-11-02', i)) // a Monday
        .toLocaleDateString(undefined, { weekday: 'short' }));
    const rows = [];
    const slots = [...Array(lead).fill(null), ...cells];
    while (slots.length % 7) slots.push(null);
    for (let i = 0; i < slots.length; i += 7) {
        rows.push(h('div', { class: 'cal-row', role: 'row' }, slots.slice(i, i + 7).map((c) => (c
            ? h('div', { class: 'cal-cell', role: 'gridcell' }, c)
            : h('div', { class: 'cal-cell blank', role: 'gridcell', 'aria-hidden': 'true' })))));
    }
    const grid = h('div', { class: 'cal', role: 'grid', 'aria-label': `${label || monthLabel(month)}. Use the arrow keys to move between days, Page Up and Page Down to change month.` },
        h('div', { class: 'cal-row cal-head', role: 'row' }, weekdays.map((w) => h('div', { class: 'cal-wd', role: 'columnheader', text: w }))),
        rows);

    const pick = selected.find((d) => d.startsWith(month));
    const startIndex = focusDay && focusDay.startsWith(month) ? Number(focusDay.slice(8)) - 1
        : pick ? Number(pick.slice(8)) - 1
        : today.startsWith(month) ? Number(today.slice(8)) - 1 : daysIn - 1;
    roving(grid, cells, {
        start: startIndex,
        next(i, key) {
            const day = days[i];
            const wd = (lead + i) % 7;
            const target = {
                ArrowRight: addDays(day, 1),
                ArrowLeft: addDays(day, -1),
                ArrowDown: addDays(day, 7),
                ArrowUp: addDays(day, -7),
                Home: addDays(day, -wd),
                End: addDays(day, 6 - wd),
                PageUp: `${addMonths(month, -1)}-${day.slice(8)}`,
                PageDown: `${addMonths(month, 1)}-${day.slice(8)}`,
            }[key];
            if (!target) return undefined;
            const j = days.indexOf(target);
            if (j >= 0) return j;
            if (onLeave) onLeave(clampDay(target));
            return false;
        },
    });
    return { el: grid, focus: (day) => { const c = cells[days.indexOf(day)]; if (c) c.focus(); } };
}

// 2026-02-31 -> 2026-02-28
function clampDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return `${y}-${pad(m)}-${pad(Math.min(d, last))}`;
}

// A small legend so colour is never the only key.
export function legend(items) {
    return h('ul', { class: 'legend' }, items.map((i) => h('li', {}, h('span', { class: `swatch hue-${i.hue}`, 'aria-hidden': 'true' }), i.label)));
}

/* ---------- Stats page charts (reusable; colours from hue-* classes, tooltips from <title>) ---------- */

export const SERIES_HUES = ['cobalt', 'teal', 'amber', 'plum', 'rose', 'moss', 'sky', 'brick', 'lime', 'indigo'];
export const hueAt = (i) => SERIES_HUES[i % SERIES_HUES.length];
const fmtNum = (n) => Number(n || 0).toLocaleString();

// Vertical stacked bars, one per label. series: [{ name, hue, values }] (values line up with labels).
// labelText(label) words a label for tooltips and the axis; unit names the counted thing.
export function stackedBars({ labels, series, ariaLabel, height = 120, unit = 'item', labelText = (l) => l }) {
    const slot = 12;
    const bar = labels.length > 60 ? 10 : 8;
    const totals = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] || 0), 0));
    const max = Math.max(1, ...totals);
    const width = Math.max(1, labels.length) * slot;
    const cols = labels.map((label, i) => {
        const x = i * slot + (slot - bar) / 2;
        let y = height;
        const rects = [];
        for (const s of series) {
            const v = s.values[i] || 0;
            if (!v) continue;
            const hgt = Math.max(2, (v / max) * (height - 4));
            y -= hgt;
            rects.push(svg('rect', { class: `bar hue-${s.hue}`, x, y, width: bar, height: hgt, rx: 1.5 }));
        }
        if (!rects.length) rects.push(svg('rect', { class: 'bar empty', x, y: height - 2, width: bar, height: 2, rx: 1 }));
        const detail = series.filter((s) => s.values[i]).map((s) => `${s.name} ${fmtNum(s.values[i])}`).join(', ');
        // A full-height transparent rect so the whole column answers hover, not just the bar.
        rects.unshift(svg('rect', { class: 'hit', x: i * slot, y: 0, width: slot, height }));
        return svg('g', { class: 'col' }, svg('title', { text: `${labelText(label)}: ${plural(totals[i], unit)}${detail ? ` (${detail})` : ''}` }), rects);
    });
    return h('figure', { class: 'chart' },
        svg('svg', { class: 'bars grow', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': ariaLabel, style: `height:${height}px` }, cols),
        h('figcaption', { class: 'chart-axis', 'aria-hidden': 'true' },
            h('span', { text: labels.length ? labelText(labels[0]) : '' }),
            h('span', { text: labels.length ? labelText(labels[labels.length - 1]) : '' })));
}

// Horizontal bars as HTML rows (they wrap their labels and fit any width).
// items: [{ label, value, hue?, href?, sub? }]; format(value) words the number.
export function hBars({ items, ariaLabel, format = fmtNum, hue = 'cobalt' }) {
    const max = Math.max(1, ...items.map((i) => i.value || 0));
    return h('ol', { class: 'hbars', 'aria-label': ariaLabel }, items.map((i) => {
        const text = `${i.label}: ${format(i.value)}${i.sub ? `, ${i.sub}` : ''}`;
        const name = i.href ? h('a', { href: i.href, text: i.label }) : h('span', { text: i.label });
        return h('li', { class: 'hbar', title: text },
            h('span', { class: 'hbar-label' }, name, i.sub ? h('span', { class: 'hbar-sub', text: ` ${i.sub}` }) : null),
            h('span', { class: 'hbar-track', 'aria-hidden': 'true' },
                h('span', { class: `hbar-fill hue-${i.hue || hue}`, style: `width:${Math.max(1.5, ((i.value || 0) / max) * 100)}%` })),
            h('span', { class: 'hbar-value', text: format(i.value) }));
    }));
}

// A donut with a legend. items: [{ label, value, hue }]; center: the big word in the middle.
export function donut({ items, ariaLabel, center = '', size = 132 }) {
    const total = items.reduce((s, i) => s + (i.value || 0), 0);
    const r = 15.9155; // circumference 100
    let offset = 25; // start at 12 o'clock
    const arcs = items.filter((i) => i.value > 0).map((i) => {
        const pct = (i.value / total) * 100;
        const el = svg('circle', { class: `arc hue-${i.hue}`, cx: 21, cy: 21, r, 'stroke-dasharray': `${pct} ${100 - pct}`, 'stroke-dashoffset': offset },
            svg('title', { text: `${i.label}: ${fmtNum(i.value)} (${Math.round(pct)}%)` }));
        offset -= pct;
        return el;
    });
    return h('figure', { class: 'chart donut-wrap' },
        svg('svg', { class: 'donut', viewBox: '0 0 42 42', width: size, height: size, role: 'img', 'aria-label': ariaLabel },
            svg('circle', { class: 'arc-bg', cx: 21, cy: 21, r }), arcs,
            svg('text', { class: 'donut-center', x: 21, y: 21, 'text-anchor': 'middle', 'dominant-baseline': 'central', text: String(center) })),
        h('ul', { class: 'legend legend-col' }, items.map((i) => h('li', {},
            h('span', { class: `swatch hue-${i.hue}`, 'aria-hidden': 'true' }), `${i.label} `, h('b', { text: fmtNum(i.value) })))));
}

// A grid of shaded cells. values[r][c] is a number, or null for a blank slot. title(r, c, v) words a cell.
// colLabels: sparse labels under the grid ({ index: text }). One colour (hue), stronger for bigger numbers.
export function heatmap({ values, rowLabels, colLabels = {}, ariaLabel, title, hue = 'cobalt', cls = '' }) {
    const flat = values.flat().filter((v) => v != null);
    const max = Math.max(1, ...flat);
    const cols = Math.max(0, ...values.map((r) => r.length));
    const grid = h('div', { class: `heatmap ${cls}`.trim(), role: 'img', 'aria-label': ariaLabel, style: `--cols:${cols}` },
        values.map((row, r) => [
            h('span', { class: 'hm-row', 'aria-hidden': 'true', text: rowLabels[r] || '' }),
            ...row.map((v, c) => (v == null
                ? h('span', { class: 'hm-cell blank', 'aria-hidden': 'true' })
                : h('span', { class: `hm-cell hue-${hue}${v ? '' : ' zero'}`, style: `--a:${v ? (0.18 + 0.82 * (v / max)).toFixed(2) : 0}`, title: title(r, c, v), 'aria-hidden': 'true' }))),
        ]),
        h('span', { class: 'hm-row', 'aria-hidden': 'true' }),
        Array.from({ length: cols }, (_, c) => h('span', { class: 'hm-col', 'aria-hidden': 'true', text: colLabels[c] || '' })));
    return h('figure', { class: 'chart heatmap-wrap' }, grid);
}

// Lines over shared labels. series: [{ name, hue, values }]. Hovering a column shows every series' value there.
export function lineChart({ labels, series, ariaLabel, height = 120, labelText = (l) => l, unit = '' }) {
    const W = 600;
    const n = labels.length;
    const max = Math.max(1, ...series.flatMap((s) => s.values));
    const x = (i) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
    const y = (v) => height - 3 - (v / max) * (height - 8);
    const lines = series.map((s) => svg('polyline', {
        class: `line hue-${s.hue}`, fill: 'none', 'vector-effect': 'non-scaling-stroke',
        points: s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    }));
    const step = n > 1 ? W / (n - 1) : W;
    const hits = labels.map((l, i) => svg('rect', { class: 'hit', x: Math.max(0, x(i) - step / 2), y: 0, width: step, height },
        svg('title', { text: `${labelText(l)}: ${series.map((s) => `${s.name} ${fmtNum(s.values[i])}${unit ? ` ${unit}` : ''}`).join(', ')}` })));
    return h('figure', { class: 'chart' },
        svg('svg', { class: 'lines', viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': ariaLabel, style: `height:${height}px` },
            svg('line', { class: 'baseline', x1: 0, x2: W, y1: height - 1, y2: height - 1, 'vector-effect': 'non-scaling-stroke' }), lines, hits),
        h('figcaption', { class: 'chart-axis', 'aria-hidden': 'true' },
            h('span', { text: n ? labelText(labels[0]) : '' }),
            h('span', { text: n ? labelText(labels[n - 1]) : '' })));
}
