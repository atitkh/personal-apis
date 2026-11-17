// Stats: Atit's data as charts. One request (/stats?range=), one card per section. A section whose domain is off
// shows a short notice; one that failed says so; the rest still draw. The range chips reload the page.
import { h, pageHeader, chipNav, plural, dayLabel, emptyState } from '../ui.js';
import { href } from '../router.js';
import { stackedBars, hBars, donut, heatmap, lineChart, legend, hueAt, parseDay, addDays } from '../charts.js';
import { recordHref } from './recordHref.js';

const RANGES = [['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['all', 'All time']];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const num = (n) => Number(n || 0).toLocaleString();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const hours = (min) => (min >= 90 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`);
// Whole units unless the amount has cents (an average is always whole).
const money = (cents, cur, { whole = false } = {}) => {
    const digits = whole || Math.round(cents) % 100 === 0 ? 0 : 2;
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100); } catch (e) { return `${(cents / 100).toFixed(digits)} ${cur}`; }
};
const monthText = (m) => parseDay(`${m}-01`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const monthShort = (m) => parseDay(`${m}-01`).toLocaleDateString(undefined, { month: 'short' });
// Words for a bucket label: a day, the Monday of a week, or a month.
const bucketText = (bucket) => (l) => (bucket === 'month' ? monthText(l) : bucket === 'week' ? `Week of ${dayLabel(l, { month: 'short', day: 'numeric' })}` : dayLabel(l));
const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);

/* ---------- a card ---------- */

// title, takeaway (one line), body (a node or nodes), wide (spans two columns on desktop).
function card({ title, takeaway, body, wide = false, key }) {
    return h('section', { class: `panel stat-card${wide ? ' wide' : ''}`, 'aria-labelledby': `st-${key}` },
        h('header', { class: 'stat-card-head' },
            h('h2', { id: `st-${key}`, text: title }),
            takeaway ? h('p', { class: 'stat-takeaway', text: takeaway }) : null),
        body);
}

const empty = (text) => h('p', { class: 'stat-empty', text });

// The section's state when it has nothing to draw: off, failed, or missing.
function unavailable(sec, title) {
    if (!sec) return empty('No data.');
    if (sec.skipped) return h('p', { class: 'stat-empty' }, `${title} ${title.includes(',') ? 'are' : 'is'} turned off. `, h('a', { href: href('overview'), text: 'Turn it on in the Overview' }), '.');
    if (sec.error) return h('p', { class: 'stat-empty stat-error', text: `Could not work this out: ${sec.error}` });
    return null;
}

// A section card: off/failed sections get their notice instead of `make()`.
const DOMAIN_WORDS = { lifelog: 'Lifelog', flights: 'Flights', trips: 'Trips', deadlines: 'Deadlines', digests: 'Digests', graph: 'Entities, links and notes' };
function section(sections, name, title, opts, make) {
    const sec = sections[name];
    const bad = unavailable(sec, DOMAIN_WORDS[name] || title);
    if (bad) return card({ title, key: opts.key || name, body: bad, wide: opts.wide });
    return make(sec);
}

/* ---------- headline tiles ---------- */

function tile(label, value, sub) {
    return h('li', { class: 'stat-tile' },
        h('span', { class: 'stat-label', text: label }),
        h('span', { class: 'stat-value', text: value }),
        h('span', { class: 'stat-sub', text: sub || '' }));
}

function tiles(s, rangeWords) {
    const ok = (x) => x && !x.skipped && !x.error;
    const l = s.lifelog;
    const f = s.flights;
    const d = s.deadlines;
    const g = s.digests;
    const gr = s.graph;
    const a = s.agents;
    const totalOf = (name) => { const t = ok(s.totals) && s.totals.domains.find((x) => x.name === name); return t ? t.records || 0 : 0; };
    return h('ul', { class: 'stat-grid stats-tiles', 'aria-label': 'Headline numbers' },
        tile('Lifelog episodes', ok(l) ? num(l.episodes) : '—', ok(l) ? `${num(l.observations)} observations, ${rangeWords}` : 'Lifelog off'),
        tile('Flights', ok(f) ? num(f.flights) : '—', ok(f) ? `${num(f.distance_km)} km, ${num(f.hours)} h in the air` : 'Flights off'),
        tile('Deadlines', ok(d) ? num(d.active) : '—', ok(d) ? `${d.by_window.urgent} urgent, ${d.by_window.attention} soon` : 'Deadlines off'),
        tile('Digest coverage', ok(g) && g.total ? `${Math.round((g.present / g.total) * 100)}%` : '—', ok(g) ? `${g.present} of ${g.total} days` : 'Digests off'),
        tile('Knowledge graph', num(totalOf('links')), `links between ${num(totalOf('entities'))} entities and ${num(totalOf('notes'))} notes`),
        tile('Agent calls', ok(a) ? num(a.calls) : '—', ok(a) ? `${a.failed ? `${a.failed} failed, ` : ''}${rangeWords}` : '')
    );
}

/* ---------- sections ---------- */

function lifelogCards(s, bt, rangeWords) {
    const out = [];
    out.push(section(s, 'lifelog', 'Lifelog episodes', { wide: true }, (l) => {
        const st = l.episodes_by_kind;
        const series = st.series.map((x, i) => ({ ...x, hue: hueAt(i) }));
        const top = l.kinds[0];
        return card({
            key: 'lifelog', title: 'Lifelog episodes', wide: true,
            takeaway: l.episodes ? `${plural(l.episodes, 'episode')} ${rangeWords}; mostly ${top.kind} (${Math.round((top.episodes / l.episodes) * 100)}%).` : null,
            body: l.episodes
                ? [stackedBars({ labels: st.labels, series, unit: 'episode', labelText: bt, height: 140,
                    ariaLabel: `Episodes ${rangeWords}: ${l.episodes} in all. ${l.kinds.slice(0, 5).map((k) => `${k.kind} ${k.episodes}`).join(', ')}.` }),
                legend(series.map((x) => ({ hue: x.hue, label: x.name })))]
                : empty(`No episodes ${rangeWords}.`),
        });
    }));
    out.push(section(s, 'lifelog', 'When things happen', { key: 'lifelog-heat' }, (l) => {
        const v = l.heatmap.values;
        let best = [0, 0, 0];
        v.forEach((row, r) => row.forEach((n, c) => { if (n > best[2]) best = [r, c, n]; }));
        const hr = (c) => `${String(c).padStart(2, '0')}:00`;
        return card({
            key: 'lifelog-heat', title: 'When things happen',
            takeaway: best[2] ? `Busiest: ${WEEKDAYS[best[0]]} around ${hr(best[1])}.` : null,
            body: l.episodes
                ? heatmap({ values: v, rowLabels: WEEKDAYS, colLabels: { 0: '0', 6: '6', 12: '12', 18: '18', 23: '23' }, hue: 'teal', cls: 'hm-hours',
                    title: (r, c, n) => `${WEEKDAYS[r]} ${hr(c)}: ${plural(n, 'episode')}`,
                    ariaLabel: `Episodes by weekday and hour. Busiest ${WEEKDAYS[best[0]]} ${hr(best[1])} with ${best[2]}.` })
                : empty('Nothing logged in this range.'),
        });
    }));
    out.push(section(s, 'lifelog', 'Where time goes', { key: 'lifelog-places' }, (l) => {
        const kinds = l.kinds.slice(0, 8);
        return card({
            key: 'lifelog-places', title: 'Where time goes',
            takeaway: l.top_places.length ? `Most time at ${l.top_places[0].place}.` : null,
            body: l.top_places.length
                ? [hBars({ hue: 'moss', ariaLabel: `Top places: ${l.top_places.map((p) => `${p.place} ${hours(p.minutes)}`).join(', ')}`,
                    items: l.top_places.map((p) => ({ label: p.place, value: p.minutes || p.episodes, sub: plural(p.episodes, 'episode') })),
                    format: (m) => hours(m) }),
                kinds.length ? h('p', { class: 'stat-foot', text: `By kind: ${kinds.map((k) => `${k.kind} ${k.episodes}`).join(' · ')}` }) : null]
                : empty('No places on episodes in this range.'),
        });
    }));
    return out;
}

function flightCards(s) {
    return [
        section(s, 'flights', 'Flights per year', {}, (f) => {
            const years = f.per_year;
            const best = years.reduce((b, y) => (!b || y.flights > b.flights ? y : b), null);
            return card({
                key: 'flights', title: 'Flights per year',
                takeaway: years.length ? `${num(f.flights)} flown, ${num(f.distance_km)} km; busiest year ${best.year} (${best.flights}).${f.cancelled ? ` ${f.cancelled} cancelled.` : ''}` : null,
                body: years.length
                    ? hBars({ hue: 'sky', ariaLabel: `Flights per year: ${years.map((y) => `${y.year} ${y.flights}`).join(', ')}`,
                        items: years.map((y) => ({ label: y.year, value: y.flights, sub: `${num(y.distance_km)} km` })) })
                    : empty('No flights flown yet.'),
            });
        }),
        section(s, 'flights', 'Top airports and airlines', { key: 'flights-top' }, (f) => card({
            key: 'flights-top', title: 'Top airports and airlines',
            takeaway: f.top_airports.length ? `${f.airports} airports in ${plural(f.countries, 'country', 'countries')}, ${plural(f.airlines, 'airline')}.` : null,
            body: f.top_airports.length
                ? h('div', { class: 'stat-split' },
                    hBars({ hue: 'cobalt', ariaLabel: `Top airports: ${f.top_airports.map((a) => `${a.iata} ${a.visits}`).join(', ')}`,
                        items: f.top_airports.map((a) => ({ label: a.iata, sub: a.city || '', value: a.visits })) }),
                    hBars({ hue: 'plum', ariaLabel: `Top airlines: ${f.top_airlines.map((a) => `${a.name || a.iata} ${a.flights}`).join(', ')}`,
                        items: f.top_airlines.map((a) => ({ label: a.name || a.iata, value: a.flights })) }))
                : empty('No flights flown yet.'),
        })),
    ];
}

function tripCard(s) {
    return section(s, 'trips', 'Trips per year', {}, (t) => {
        const kinds = t.by_kind.map((k, i) => ({ label: cap(k.kind), value: k.trips, hue: hueAt(i) }));
        return card({
            key: 'trips', title: 'Trips per year',
            takeaway: t.trips ? `${plural(t.trips, 'trip')}, ${num(sum(t.per_year.map((y) => y.nights)))} nights away.` : null,
            body: t.trips
                ? h('div', { class: 'stat-split' },
                    hBars({ hue: 'amber', ariaLabel: `Trips per year: ${t.per_year.map((y) => `${y.year} ${y.trips} trips ${y.nights} nights`).join(', ')}`,
                        items: t.per_year.map((y) => ({ label: y.year, value: y.trips, sub: plural(y.nights, 'night') })) }),
                    donut({ items: kinds, center: t.trips, size: 112, ariaLabel: `Trips by kind: ${kinds.map((k) => `${k.label} ${k.value}`).join(', ')}` }))
                : empty('No trips yet.'),
        });
    });
}

function deadlineCards(s) {
    return [
        section(s, 'deadlines', 'Recurring costs, next 12 months', { key: 'deadlines-cost' }, (d) => {
            const c = d.cost;
            const curs = c.currencies;
            const series = curs.map((cur, i) => ({ name: cur, hue: hueAt(i + 2), values: c.months.map((m) => m.cents[cur] || 0) }));
            const totals = curs.map((cur) => money(c.total_cents[cur], cur)).join(' + ');
            const perMonth = c.months.map((m) => `${monthText(m.month)} ${curs.map((cur) => money(m.cents[cur] || 0, cur)).join(' + ')}`);
            return card({
                key: 'deadlines-cost', title: 'Recurring costs, next 12 months',
                takeaway: curs.length ? `${totals} over 12 months (about ${curs.map((cur) => money(c.total_cents[cur] / 12, cur, { whole: true })).join(' + ')} a month) from ${plural(c.items, 'item')}.` : null,
                body: curs.length
                    ? [stackedBars({ labels: c.months.map((m) => m.month), series, height: 130, unit: 'cent',
                        labelText: (l) => perMonth[c.months.findIndex((m) => m.month === l)],
                        ariaLabel: `Costs per month: ${perMonth.join('; ')}` }),
                    curs.length > 1 ? legend(series.map((x) => ({ hue: x.hue, label: x.name }))) : null]
                    : empty('No subscriptions, memberships or bills with an amount.'),
            });
        }),
        section(s, 'deadlines', 'Deadlines', { key: 'deadlines-kind' }, (d) => {
            const items = d.by_kind.map((k, i) => ({ label: cap(k.kind), value: k.active, hue: hueAt(i) }));
            const w = d.by_window;
            return card({
                key: 'deadlines-kind', title: 'Deadlines',
                takeaway: d.active ? `${w.urgent} urgent, ${w.attention} need attention, ${w.later} later; ${w.done} done.` : null,
                body: d.active
                    ? donut({ items, center: d.active, ariaLabel: `Active deadlines by kind: ${items.map((k) => `${k.label} ${k.value}`).join(', ')}` })
                    : empty('No active deadlines.'),
            });
        }),
    ];
}

// A GitHub-style calendar: one column per week (Monday on top), one cell per day; shade = digest length.
function digestCard(s) {
    return section(s, 'digests', 'Daily digests', { wide: true }, (g) => {
        const days = g.days;
        if (!days.length) return card({ key: 'digests', title: 'Daily digests', wide: true, body: empty('No days in range.') });
        const first = days[0].day;
        const lead = (parseDay(first).getDay() + 6) % 7;
        const cols = Math.ceil((lead + days.length) / 7);
        const values = Array.from({ length: 7 }, () => Array(cols).fill(null));
        const colLabels = {};
        days.forEach((d, i) => {
            const k = lead + i;
            const c = Math.floor(k / 7);
            values[k % 7][c] = d.chars == null ? 0 : d.chars;
            if (d.day.endsWith('-01') || i === 0) colLabels[c] = monthShort(d.day.slice(0, 7));
        });
        const dayAt = (r, c) => addDays(first, c * 7 + r - lead);
        const longest = days.reduce((b, d) => (d.chars && (!b || d.chars > b.chars) ? d : b), null);
        return card({
            key: 'digests', title: 'Daily digests', wide: true,
            takeaway: `${g.present} of ${g.total} days have a digest (${Math.round((g.present / g.total) * 100)}%), ${num(g.avg_chars)} characters on average.`,
            body: [
                h('div', { class: 'hm-scroll' }, heatmap({ values, rowLabels: ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'], colLabels, hue: 'indigo', cls: 'hm-cal',
                    title: (r, c, v) => `${dayLabel(dayAt(r, c), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}: ${v ? `${num(v)} characters` : 'no digest'}`,
                    ariaLabel: `Digest coverage: ${g.present} of ${g.total} days.${longest ? ` Longest ${dayLabel(longest.day)} with ${longest.chars} characters.` : ''}` })),
                h('p', { class: 'stat-foot' }, 'Darker means a longer digest. ', h('a', { href: href('digests'), text: 'Open digests' })),
            ],
        });
    });
}

function graphCards(s, rangeWords) {
    const out = [];
    out.push(section(s, 'graph', 'Entities and links', { key: 'graph' }, (gr) => {
        const kinds = (gr.entities_by_kind || []).map((k, i) => ({ label: cap(k.kind), value: k.entities, hue: hueAt(i) }));
        const rels = gr.links_by_rel || [];
        const n = sum(kinds.map((k) => k.value));
        return card({
            key: 'graph', title: 'Entities and links',
            takeaway: rels.length ? `Most links say "${rels[0].rel}" (${rels[0].links}).` : null,
            body: n || rels.length
                ? h('div', { class: 'stat-split' },
                    n ? donut({ items: kinds, center: n, size: 112, ariaLabel: `Entities by kind: ${kinds.map((k) => `${k.label} ${k.value}`).join(', ')}` }) : empty('No entities yet.'),
                    rels.length ? hBars({ hue: 'rose', ariaLabel: `Links by relation: ${rels.map((r) => `${r.rel} ${r.links}`).join(', ')}`,
                        items: rels.map((r) => ({ label: r.rel, value: r.links })) }) : empty(gr.links_by_rel ? 'No links yet.' : 'Links are turned off.'))
                : empty('No entities or links yet.'),
        });
    }));
    out.push(section(s, 'graph', 'Growth', { key: 'growth' }, (gr) => {
        const g = gr.growth;
        const series = g.series.map((x, i) => ({ name: x.name, hue: hueAt(i + 4), values: x.cumulative }));
        const added = g.series.map((x) => `${sum(x.values)} ${x.name}`);
        return card({
            key: 'growth', title: 'Growth',
            takeaway: series.length ? `Added ${added.join(' and ')} ${rangeWords}.` : null,
            body: series.length && series.some((x) => x.values.some(Boolean))
                ? [lineChart({ labels: g.labels, series, labelText: bucketText(g.bucket), ariaLabel: `Running totals: ${g.series.map((x) => `${x.name} ${x.cumulative[x.cumulative.length - 1]}`).join(', ')}. Added ${added.join(', ')}.` }),
                    legend(series.map((x) => ({ hue: x.hue, label: `${cap(x.name)} (total)` })))]
                : empty('No notes or links yet.'),
        });
    }));
    out.push(section(s, 'graph', 'Most connected', { key: 'hubs' }, (gr) => {
        const top = gr.top_connected || [];
        return card({
            key: 'hubs', title: 'Most connected',
            takeaway: top.length ? `${top[0].title} has ${plural(top[0].degree, 'link')}.` : null,
            body: top.length
                ? hBars({ hue: 'teal', ariaLabel: `Most connected records: ${top.map((t) => `${t.title} ${t.degree}`).join(', ')}`,
                    items: top.map((t) => ({ label: t.title, sub: t.domain, value: t.degree, href: recordHref(t.domain, t.id, { date: t.date, title: t.title }) })) })
                : empty(gr.top_connected ? 'Nothing is linked yet.' : 'Links are turned off.'),
        });
    }));
    return out;
}

function searchCard(s) {
    return section(s, 'search', 'Search index', {}, (x) => {
        const pct = x.total ? Math.round((x.indexed / x.total) * 100) : 0;
        return card({
            key: 'search', title: 'Search index',
            takeaway: x.enabled ? `${num(x.indexed)} of ${num(x.total)} records indexed (${pct}%)${x.model ? ` with ${x.model}` : ''}.` : 'Semantic search is off; keyword search still works.',
            body: [
                x.domains.length
                    ? hBars({ hue: 'lime', ariaLabel: `Indexed per domain: ${x.domains.map((d) => `${d.title} ${d.indexed} of ${d.total}`).join(', ')}`,
                        items: x.domains.map((d) => ({ label: d.title, value: d.total ? Math.round((d.indexed / d.total) * 100) : 0, sub: `${num(d.indexed)}/${num(d.total)}` })),
                        format: (v) => `${v}%` })
                    : empty('Nothing to index.'),
                x.last_error ? h('p', { class: 'stat-foot stat-error', text: `Last error: ${typeof x.last_error === 'string' ? x.last_error : JSON.stringify(x.last_error)}` }) : null,
            ],
        });
    });
}

function agentsCard(s, bt, rangeWords) {
    return section(s, 'agents', 'Agent calls', { wide: true }, (a) => {
        const st = a.by_key;
        const series = st.series.map((x, i) => ({ ...x, hue: hueAt(i) }));
        const top = series.map((x) => [x.name, sum(x.values)]).sort((p, q) => q[1] - p[1])[0];
        return card({
            key: 'agents', title: 'Agent calls (MCP)', wide: true,
            takeaway: a.calls ? `${plural(a.calls, 'call')} ${rangeWords}; most from ${top[0]} (${top[1]}).` : null,
            body: a.calls
                ? [lineChart({ labels: st.labels, series, labelText: bt, unit: 'calls',
                    ariaLabel: `MCP calls per key: ${series.map((x) => `${x.name} ${sum(x.values)}`).join(', ')}` }),
                legend(series.map((x) => ({ hue: x.hue, label: x.name }))),
                h('p', { class: 'stat-foot', text: 'REST calls on /hub are not logged per call, so only MCP calls are counted.' })]
                : empty(`No agent calls ${rangeWords}.`),
        });
    });
}

/* ---------- the page ---------- */

export async function render(ctx) {
    const asked = ctx.route.query.get('range') || '90';
    const range = RANGES.some(([id]) => id === asked) ? asked : '90';
    const data = await ctx.api(`/stats?range=${range}`);
    const s = data.sections || {};
    const bt = bucketText(data.bucket);
    const rangeWords = range === 'all' ? 'in all' : `in the last ${RANGES.find(([id]) => id === range)[1]}`;
    const nothing = Object.values(s).every((x) => !x || x.skipped || x.error);
    return h('div', { class: 'view stats' },
        pageHeader({ lede: `Your data as pictures. ${data.from && data.to ? `${dayLabel(data.from, { month: 'short', day: 'numeric', year: 'numeric' })} to ${dayLabel(data.to, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}; flights and trips count all years.` }),
        h('div', { class: 'toolbar' }, chipNav({ label: 'Range', current: range, items: RANGES.map(([id, label]) => ({ id, label, href: href('stats', [], { range: id === '90' ? null : id }) })) })),
        nothing
            ? emptyState({ title: 'Nothing to chart yet.', text: 'Turn on a domain in the Overview, or add some data.', iconName: 'stats' })
            : [
                tiles(s, rangeWords),
                h('div', { class: 'stats-grid' },
                    ...lifelogCards(s, bt, rangeWords),
                    ...flightCards(s),
                    tripCard(s),
                    ...deadlineCards(s),
                    digestCard(s),
                    ...graphCards(s, rangeWords),
                    searchCard(s),
                    agentsCard(s, bt, rangeWords)),
            ]);
}
