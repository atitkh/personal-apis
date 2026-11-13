// Suggested trips: flights that have no trip, grouped into proposed trips (plan decision 5). Computed on demand,
// nothing stored except the keys Atit dismissed (trip_suggestion_dismissed). Accept and dismiss are for a person at
// the dashboard only (admin API): never over /hub or MCP. Agents may read the proposals (MCP `suggest`).
//
// RULES (flights with no trip and not cancelled, in departure order):
//   - with no home airport (flights setting home_airport) nothing is suggested: needs_home_airport says why.
//   - a chain that starts with a flight leaving home runs until the flight that lands at home, however long the
//     stay; a new departure from home before that closes it (the return was never filed).
//   - a chain that starts away from home takes the next flight when the gap (arrival date to departure date) is at
//     most 2 days, and ends at the flight that lands at home.
//   - only chains of 2 flights or more are proposed (one loose flight is not a trip yet).
//   - title: "<turnaround city> <Mon YYYY>"; the turnaround is the airport with the longest stay between landing
//     and the next departure from it, else the destination farthest from home. City from the airports table.
//   - key: the sorted flight ids, comma separated. A dismissed key is skipped.
// Every answer carries dates, airport codes, flight ids and city names only: no booking reference.
const MAX_GAP_DAYS = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KEY_RE = /^\d{1,12}(,\d{1,12}){0,199}$/;

const trips = () => require('./trips');
const flightsSvc = () => require('./flights');
const bad = (code, message, status = 400) => new (trips().TripError)(status, code, message);

// The arrival date as the destination clock reads it; the departure date when the arrival is not known.
function arrivalDate(f) {
    if (!f.sched_arr) return f.dep_local_date;
    const d = f.arr_tz ? flightsSvc().localIso(f.sched_arr, f.arr_tz).slice(0, 10) : f.sched_arr.slice(0, 10);
    return d < f.dep_local_date ? f.dep_local_date : d;
}

const keyOf = (flights) => flights.map((f) => f.id).sort((a, b) => a - b).join(',');

// Splits the loose flights into chains by the rules above.
function chainsOf(rows, home) {
    const chains = [];
    let cur = null;
    const close = () => { if (cur) chains.push(cur.flights); cur = null; };
    for (const f of rows) {
        if (f.origin_iata === home) {
            close();
            cur = { fromHome: true, flights: [f] };
        } else if (cur && (cur.fromHome || trips().dayDiff(arrivalDate(cur.flights[cur.flights.length - 1]), f.dep_local_date) <= MAX_GAP_DAYS)) {
            cur.flights.push(f);
        } else {
            close();
            cur = { fromHome: false, flights: [f] };
        }
        if (f.dest_iata === home) close();
    }
    close();
    return chains.filter((c) => c.length >= 2);
}

// The airport where the chain turns around (see RULES).
function turnaround(db, chain, home) {
    let best = null;
    for (let i = 0; i < chain.length - 1; i += 1) {
        const a = chain[i];
        const b = chain[i + 1];
        if (a.dest_iata !== b.origin_iata || a.dest_iata === home) continue;
        const stay = Date.parse(b.sched_dep) - Date.parse(a.sched_arr || a.sched_dep);
        if (!best || stay > best.stay) best = { iata: a.dest_iata, stay };
    }
    if (best) return best.iata;
    const at = (code) => db.prepare('SELECT lat, lon FROM airports WHERE iata = ?').get(code);
    const h = at(home);
    let far = { iata: chain[chain.length - 1].dest_iata === home ? chain[0].dest_iata : chain[chain.length - 1].dest_iata, km: -1 };
    if (!h) return far.iata;
    for (const f of chain) {
        const p = f.dest_iata !== home && at(f.dest_iata);
        if (!p) continue;
        const km = flightsSvc().haversineKm(h.lat, h.lon, p.lat, p.lon);
        if (km > far.km) far = { iata: f.dest_iata, km };
    }
    return far.iata;
}

function cityOf(db, iata) {
    const a = db.prepare('SELECT city, name FROM airports WHERE iata = ?').get(iata);
    return (a && (a.city || a.name)) || iata;
}

function proposal(db, chain, home) {
    const start = chain[0].dep_local_date;
    const end = chain.map(arrivalDate).sort().pop();
    const route = [];
    for (const f of chain) {
        if (route[route.length - 1] !== f.origin_iata) route.push(f.origin_iata);
        route.push(f.dest_iata);
    }
    const city = cityOf(db, turnaround(db, chain, home));
    const title = `${city} ${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`.slice(0, 120);
    return { key: keyOf(chain), title, start_date: start, end_date: end, flight_ids: chain.map((f) => f.id), flight_count: chain.length, route };
}

// { needs_home_airport, home_airport, dismissed (how many keys are hidden), suggestions: [...] }, oldest first.
// `now` is accepted like every read here; the proposals do not depend on it.
function suggest(db, { now: _now } = {}) {
    const home = flightsSvc().getSettings(db).home_airport;
    const dismissedKeys = new Set(db.prepare('SELECT key FROM trip_suggestion_dismissed').all().map((r) => r.key));
    if (!home) return { needs_home_airport: true, home_airport: null, dismissed: dismissedKeys.size, suggestions: [] };
    const rows = db.prepare(`SELECT id, origin_iata, dest_iata, sched_dep, sched_arr, arr_tz, dep_local_date FROM flights
        WHERE trip_id IS NULL AND status != 'cancelled' ORDER BY sched_dep, id`).all();
    const suggestions = chainsOf(rows, home).map((c) => proposal(db, c, home)).filter((s) => !dismissedKeys.has(s.key));
    return { needs_home_airport: false, home_airport: home, dismissed: dismissedKeys.size, suggestions };
}

// The current suggestion with this key, or an error: a key that is no longer proposed (a flight was linked,
// cancelled or added since the list was drawn) is a 409, so a stale screen cannot file the wrong group.
function current(db, key) {
    const k = typeof key === 'string' ? key.trim() : '';
    if (!KEY_RE.test(k)) throw bad('bad_key', 'key must be the suggestion key, flight ids separated by commas.');
    const s = suggest(db).suggestions.find((x) => x.key === k);
    if (!s) throw bad('stale_suggestion', 'That suggestion is no longer proposed. Load the suggestions again.', 409);
    return s;
}

// Creates the trip (kind other; the title sent, else the proposed one) and links the flights. Admin only.
function accept(db, input, actor) {
    const given = input || {};
    return db.transaction(() => {
        const s = current(db, given.key);
        const t = trips().create(db, { title: given.title == null || given.title === '' ? s.title : given.title, kind: 'other', start_date: s.start_date, end_date: s.end_date, note: 'Accepted from a suggestion' }, actor);
        for (const id of s.flight_ids) trips().linkFlight(db, t.id, id, actor);
        return { status: 'accepted', id: t.id, title: t.title, rev: t.rev, key: s.key, flight_ids: s.flight_ids };
    })();
}

// Hides a suggestion for good (until restoreDismissed). Admin only.
function dismiss(db, input) {
    const s = current(db, (input || {}).key);
    db.prepare('INSERT OR IGNORE INTO trip_suggestion_dismissed (key, at) VALUES (?, ?)').run(s.key, new Date().toISOString());
    return { status: 'dismissed', key: s.key, title: s.title };
}

// Brings every dismissed suggestion back. Admin only.
function restoreDismissed(db) {
    const n = db.prepare('DELETE FROM trip_suggestion_dismissed').run().changes;
    return { status: n ? 'restored' : 'unchanged', restored: n };
}

// Audit rows: the key (flight ids), the trip id and the proposed title. Nothing else.
const auditDetail = (r) => {
    const out = { key: r.key };
    if (r.id) out.id = r.id;
    if (r.title) out.title = r.title;
    if (r.restored != null) out.restored = r.restored;
    return out;
};

module.exports = { MAX_GAP_DAYS, suggest, accept, dismiss, restoreDismissed, auditDetail, chainsOf };
