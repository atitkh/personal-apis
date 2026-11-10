// Tiny inline SVG charts. No library: a chart is a few rects. Colours come from CSS (hue-* classes),
// so light and dark themes just work.
import { h, svg, dayLabel, plural } from './ui.js';

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

// One cell per day, present or missing. Cells with a target are links.
export function coverageStrip({ days, ariaLabel, href }) {
    return h('div', { class: 'strip', role: 'list', 'aria-label': ariaLabel },
        days.map((d) => {
            const text = `${dayLabel(d.day)}: ${d.present ? 'digest present' : 'missing'}`;
            return d.present && href
                ? h('a', { class: 'cell have', role: 'listitem', href: href(d.day), title: text, 'aria-label': text })
                : h('span', { class: `cell ${d.present ? 'have' : 'gap'}`, role: 'listitem', title: text, 'aria-label': text });
        }));
}

// A small legend so colour is never the only key.
export function legend(items) {
    return h('ul', { class: 'legend' }, items.map((i) => h('li', {}, h('span', { class: `swatch hue-${i.hue}`, 'aria-hidden': 'true' }), i.label)));
}
