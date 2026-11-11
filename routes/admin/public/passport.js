// The Flights Passport: year switcher, stat tiles, a world map of route arcs, records and top lists.
// Plain DOM and inline SVG, no libraries and no network. The map views (flat, globe, heat) live in mapviews.js;
// the land outline is worldmap.js (Natural Earth 110m, public domain).
// Everything from the server goes in as text. The map carries no flight numbers, dates or booking references.
import { h, svg, plural, chipNav, segmented, emptyState, dayLabel } from './ui.js';
import { MAP_VIEWS, getMapView, setMapView, mountMapView } from './mapviews.js';

const KM_PER_MILE = 1.609344;
const EARTH_KM = 40075;

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

/* ---------- punctuality ---------- */

const minutesText = (m) => {
    const n = Math.round(Math.abs(m));
    return n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`;
};
const signedMin = (m) => `${m > 0 ? '+' : m < 0 ? '\u2212' : ''}${Math.abs(Math.round(m))} min`;
const pct = (r) => `${Math.round(r * 100)}%`;

// The Punctuality section (s.delays). Late = more than 15 minutes after the scheduled arrival (the US DOT rule).
function punctuality(d, year) {
    const head = h('div', { class: 'section-head' },
        h('h2', { id: 'pp-punct', class: 'section-title', text: 'Punctuality' }),
        h('p', { class: 'muted', text: year ? `Flights in ${year}` : 'All flights' }));
    if (!d || !d.measured) {
        return h('section', { 'aria-labelledby': 'pp-punct', class: 'panel punct-panel', 'data-testid': 'punctuality' }, head,
            h('p', { class: 'muted punct-empty', text: d && d.of
                ? `No actual times for ${plural(d.of, 'flight')} yet, so there is nothing to measure. Punctuality appears once flights carry actual times.`
                : 'No flights to measure yet.' }),
            d && d.cancelled ? h('p', { class: 'help', text: `${plural(d.cancelled, 'flight')} cancelled.` }) : null);
    }
    const w = d.worst;
    const worstTile = h('li', { class: 'stat-tile' },
        h('p', { class: 'stat-value', text: w ? signedMin(w.delay_min) : 'None' }),
        h('p', { class: 'stat-label', text: 'Worst delay' }),
        w
            ? h('p', { class: 'stat-sub' }, h('a', { class: 'link', href: `#/flights/${w.id}`, text: routeText(w.route) }),
                ` ${w.airline_iata} ${w.flight_number}, ${dayLabel(w.date, { month: 'short', day: 'numeric', year: 'numeric' })}`)
            : h('p', { class: 'stat-sub', text: 'Nothing arrived late' }));
    const grid = h('ul', { class: 'stat-grid stat-grid-4', 'aria-label': 'Punctuality' },
        tile('On-time rate', pct(d.on_time_rate), `${d.measured} of ${plural(d.of, 'flight')} measured`),
        tile('Average delay', signedMin(d.avg_delay_min), d.avg_delay_min < 0 ? 'early on average' : d.avg_delay_min > 0 ? 'late on average' : 'on the dot on average'),
        tile('Total time lost', minutesText(d.total_delay_min), d.late_count ? `${plural(d.late_count, 'flight')} more than 15 min late` : 'no flight more than 15 min late'),
        worstTile);
    const bars = d.by_airline.length
        ? h('ul', { class: 'punct-bars', 'aria-label': 'On-time rate by airline' }, d.by_airline.map((a) => h('li', { class: 'punct-row' },
            h('span', { class: 'punct-name', text: a.name || a.airline }),
            h('span', { class: 'punct-bar', 'aria-hidden': 'true' }, h('span', { class: 'punct-fill', style: `width:${Math.max(2, Math.round(a.on_time_rate * 100))}%` })),
            h('span', { class: 'punct-num', text: `${pct(a.on_time_rate)} on time` }),
            h('span', { class: 'punct-sub muted', text: `${plural(a.measured, 'flight')}, ${signedMin(a.avg_delay_min)} avg` }))))
        : null;
    const notes = [];
    if (d.measured < d.of) notes.push(`Actual times known for ${d.measured} of ${d.of} flights; older flights have none.`);
    if (d.cancelled) notes.push(`${plural(d.cancelled, 'flight')} cancelled (${pct(d.cancelled_rate)} of flights flown or cancelled).`);
    if (d.early_count) notes.push(`${plural(d.early_count, 'flight')} arrived early.`);
    return h('section', { 'aria-labelledby': 'pp-punct', class: 'panel punct-panel', 'data-testid': 'punctuality' }, head, grid,
        bars ? h('div', { class: 'punct-airlines' }, h('h3', { text: 'By airline' }), bars) : null,
        notes.map((t) => h('p', { class: 'help', text: t })));
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
    const mapHost = h('div', { class: 'map-host' });
    let mounted = null;
    const showMap = (id) => {
        if (mounted) mounted.destroy();
        mounted = mountMapView(mapHost, id, map, { home: s.settings && s.settings.home_airport, unit, year });
    };
    let viewSwitch = null;
    if (map.routes.length) {
        viewSwitch = segmented({
            label: 'Map view',
            value: getMapView(),
            key: 'mapview',
            pressed: true,
            options: Object.entries(MAP_VIEWS).map(([value, v]) => ({ value, label: v.label })),
            onChange: (v) => { setMapView(v); viewSwitch.setValue(v); showMap(v); },
        });
        for (const [id, v] of Object.entries(MAP_VIEWS)) {
            if (v.soon) {
                const b = viewSwitch.querySelector(`[data-value="${id}"]`);
                if (b) { b.classList.add('seg-soon'); b.title = 'Arrives with the next update'; }
            }
        }
        showMap(getMapView());
        if (ctx.onCleanup) ctx.onCleanup(() => { if (mounted) mounted.destroy(); mounted = null; });
    }
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
        punctuality(s.delays, year),
        h('section', { 'aria-labelledby': 'pp-map', class: 'panel map-panel' },
            h('div', { class: 'section-head' },
                h('h2', { id: 'pp-map', class: 'section-title', text: year ? `Where you flew in ${year}` : 'Where you have flown' }),
                h('p', { class: 'muted', text: `${plural(map.routes.length, 'route')}, ${plural(map.airports.length, 'airport')}` }),
                viewSwitch),
            map.routes.length
                ? mapHost
                : emptyState({ title: year ? `No flights in ${year}.` : 'Nothing to draw yet.', text: 'Routes appear once a flight has departed.', iconName: 'info' }),
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
