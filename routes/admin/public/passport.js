// The Flights Passport: year switcher, stat tiles, a world map of route arcs, records and top lists.
// Plain DOM and inline SVG, no libraries and no network. The land outline is worldmap.js (Natural Earth 110m,
// public domain); the map is equirectangular (x = longitude + 180, y = 90 - latitude) and cropped to 84 N..58 S.
// Everything from the server goes in as text. The map carries no flight numbers, dates or booking references.
import { h, svg, plural, chipNav, segmented, emptyState, dayLabel } from './ui.js';
import { LAND } from './worldmap.js';

const KM_PER_MILE = 1.609344;
const EARTH_KM = 40075;
const VIEW = { x: 0, y: 6, w: 360, h: 142 };

export const UNIT_KEY = 'hub-flights-unit';
export const getUnit = () => {
    try { return localStorage.getItem(UNIT_KEY) === 'mi' ? 'mi' : 'km'; } catch (e) { return 'km'; }
};
export const setUnit = (u) => {
    try { localStorage.setItem(UNIT_KEY, u); } catch (e) { /* keep the default */ }
};
export const distanceText = (km, unit) => {
    if (km == null) return 'unknown';
    const v = unit === 'mi' ? km / KM_PER_MILE : km;
    return `${Math.round(v).toLocaleString()} ${unit === 'mi' ? 'mi' : 'km'}`;
};

const num = (n) => Number(n).toLocaleString();
const routeText = (r) => r.replace('-', ' – ');

/* ---------- map ---------- */

// A route as a quadratic curve that bows north (as flat maps draw great circles). Shorter way round the
// globe: a route that crosses the date line is drawn off the edge and repeated on the other side.
function arcPaths(a, b) {
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

export function routeMap(map, { home } = {}) {
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
        class: `pt${a.iata === home ? ' pt-home' : ''}`,
        d: `M${(a.lon + 180).toFixed(1)} ${(90 - a.lat).toFixed(1)}h0`,
    }, svg('title', { text: `${a.iata}${a.city ? `, ${a.city}` : ''}: ${plural(a.visits, 'visit')}` })));

    const frame = svg('svg', {
        class: 'route-map',
        viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`,
        role: 'img',
        'aria-label': `Map of ${plural(map.routes.length, 'route')} between ${plural(map.airports.length, 'airport')}. The lists below carry the same numbers.`,
        preserveAspectRatio: 'xMidYMid meet',
    }, svg('path', { class: 'graticule', d: graticule() }), svg('path', { class: 'land', d: LAND }), arcs, dots);

    // Labels for the busiest airports: HTML over the SVG so the text keeps its size on a phone.
    const wrap = h('div', { class: 'map-wrap' }, frame);
    const busiest = map.airports.slice().sort((p, q) => q.visits - p.visits || (p.iata < q.iata ? -1 : 1)).slice(0, 12);
    for (const a of busiest) {
        const label = h('span', { class: `map-label${a.iata === home ? ' is-home' : ''}`, 'aria-hidden': 'true', text: a.iata });
        label.style.left = `${(((a.lon + 180) - VIEW.x) / VIEW.w) * 100}%`;
        label.style.top = `${(((90 - a.lat) - VIEW.y) / VIEW.h) * 100}%`;
        wrap.append(label);
    }
    return wrap;
}

/* ---------- tiles, records, lists ---------- */

function tile(label, value, sub) {
    return h('li', { class: 'stat-tile' },
        h('p', { class: 'stat-value', text: value }),
        h('p', { class: 'stat-label', text: label }),
        sub ? h('p', { class: 'stat-sub', text: sub }) : null);
}

function tiles(s, unit) {
    const days = s.hours / 24;
    return h('ul', { class: 'stat-grid', 'aria-label': 'Passport totals' },
        tile('Flights', num(s.flights), s.upcoming ? `${num(s.upcoming)} coming up` : null),
        tile(unit === 'mi' ? 'Miles' : 'Kilometres', num(Math.round(unit === 'mi' ? s.distance_km / KM_PER_MILE : s.distance_km)),
            s.distance_km ? `${(s.distance_km / EARTH_KM).toFixed(2)} times around the Earth` : null),
        tile('Hours in the air', num(Math.round(s.hours)), s.hours >= 48 ? `${days.toFixed(1)} days` : null),
        tile('Airports', num(s.airports)),
        tile('Countries', num(s.countries), s.country_list.length ? s.country_list.join(', ') : null),
        tile('Airlines', num(s.airlines), s.aircraft_types ? plural(s.aircraft_types, 'aircraft type') : null));
}

function record(title, r, unit) {
    if (!r) return h('li', { class: 'record' }, h('p', { class: 'record-title', text: title }), h('p', { class: 'muted', text: 'None yet' }));
    return h('li', { class: 'record' },
        h('p', { class: 'record-title', text: title }),
        h('p', { class: 'record-main' }, h('a', { class: 'link', href: `#/flights/${r.id}`, text: routeText(r.route) }), ` ${distanceText(r.distance_km, unit)}`),
        h('p', { class: 'muted', text: `${r.airline_iata} ${r.flight_number}, ${dayLabel(r.date, { month: 'short', day: 'numeric', year: 'numeric' })}` }));
}

function topList(title, items, text) {
    return h('section', { class: 'top-list', 'aria-label': title },
        h('h3', { text: title }),
        items.length
            ? h('ol', {}, items.map((it) => h('li', {}, h('span', { class: 'top-name', text: text(it) }), h('span', { class: 'top-count', text: num(it.flights != null ? it.flights : it.visits) }))))
            : h('p', { class: 'muted', text: 'Nothing yet' }));
}

/* ---------- the tab ---------- */

// ctx: the view context; s: GET /flights/stats; year: the chosen year or null;
// links: { year(y) -> href, add, found } (add and found are buttons for the empty state).
export function passportTab(ctx, s, { year, unit, links, pending }) {
    const empty = !s.per_year.length && !s.upcoming && !year;
    if (empty) {
        return h('div', { class: 'tab-panel', id: 'panel-passport', role: 'tabpanel', 'aria-labelledby': 'tab-passport' },
            emptyState({
                title: 'No flights yet.',
                text: 'Add one or review found flights. Your Passport fills in as flights are added.',
                iconName: 'flights',
                action: [links.add, pending ? links.found : null],
            }));
    }

    const years = s.per_year.map((p) => p.year).sort().reverse();
    const nav = chipNav({
        label: 'Year',
        current: year || 'all',
        items: [{ id: 'all', label: 'All time', href: links.year(null) }, ...years.map((y) => ({ id: y, label: y, href: links.year(y) }))],
    });
    const units = segmented({
        label: 'Distance unit',
        value: unit,
        key: 'unit',
        options: [{ value: 'km', label: 'km' }, { value: 'mi', label: 'miles' }],
        onChange: (v) => { setUnit(v); ctx.rerender(); },
    });

    const map = s.map;
    const mapNote = [];
    if (s.unmatched.flights || s.unmatched.airports.length) {
        mapNote.push(`${plural(s.unmatched.flights, 'flight')} not on the map or in the distance: the hub does not know ${s.unmatched.airports.join(', ') || 'an airport'}.`);
    }

    const records = h('ul', { class: 'records' },
        record('Longest flight', s.longest, unit),
        record('Shortest flight', s.shortest, unit));

    return h('div', { class: 'tab-panel', id: 'panel-passport', role: 'tabpanel', 'aria-labelledby': 'tab-passport' },
        h('div', { class: 'toolbar' }, nav, units),
        tiles(s, unit),
        h('section', { 'aria-labelledby': 'pp-map', class: 'panel map-panel' },
            h('div', { class: 'section-head' },
                h('h2', { id: 'pp-map', class: 'section-title', text: year ? `Where you flew in ${year}` : 'Where you have flown' }),
                h('p', { class: 'muted', text: `${plural(map.routes.length, 'route')}, ${plural(map.airports.length, 'airport')}` })),
            map.routes.length
                ? routeMap(map, { home: s.settings && s.settings.home_airport })
                : emptyState({ title: year ? `No flights in ${year}.` : 'Nothing to draw yet.', text: 'Routes appear once a flight has departed.', iconName: 'info' }),
            map.routes.length ? h('p', { class: 'help', text: 'Each line is a route, drawn as a curve on a flat map; darker lines are flown more often. The dots are airports.' }) : null,
            mapNote.map((t) => h('p', { class: 'help warn-text', text: t }))),
        h('section', { 'aria-labelledby': 'pp-rec', class: 'records-section' },
            h('h2', { id: 'pp-rec', class: 'section-title', text: 'Records' }),
            records,
            h('div', { class: 'top-lists' },
                topList('Most-flown routes', s.top_routes.slice(0, 5), (r) => routeText(r.route)),
                topList('Aircraft types', s.top_aircraft.slice(0, 5), (a) => a.type),
                topList('Airports', s.top_airports.slice(0, 5), (a) => `${a.iata}${a.city ? `, ${a.city}` : ''}`),
                topList('Airlines', s.top_airlines.slice(0, 5), (a) => a.name || a.iata))));
}
