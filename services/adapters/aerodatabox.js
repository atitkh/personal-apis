// AeroDataBox: flight status by flight number and local departure date (GetFlight_FlightOnSpecificDate,
// GET /flights/number/{AA1234}/{YYYY-MM-DD}?dateLocalRole=Departure). Read from the official OpenAPI specs
// (doc.aerodatabox.com/docs/openapi-apimarket-v1.json and openapi-rapidapi-v1.json, 2026-11-10).
//
// Checked against live answers on 2026-11-11 (RapidAPI, two flights: a past F9 and a future CX): times, terminals,
// aircraft type and registration, actual times and delay came back sane (see FLIGHTS_PROGRESS.md, Stage D).
// Not yet seen live: gates, baggage belt, multi-leg answers, a cancelled flight.
//
// Env: AERODATABOX_API_KEY (the key), AERODATABOX_PROVIDER = apimarket (default) | rapidapi.
const PROVIDERS = {
    apimarket: {
        base: 'https://prod.api.market/api/v1/aedbx/aerodatabox',
        headers: (key) => ({ 'x-api-market-key': key }),
    },
    rapidapi: {
        base: 'https://aerodatabox.p.rapidapi.com',
        headers: (key) => ({ 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' }),
    },
};
const TIMEOUT_MS = 10000;

// "2026-03-01 10:05Z", "2026-03-01T10:05:00Z" or with an offset, as UTC ISO; null if unreadable.
function utc(t) {
    const s = t && typeof t === 'object' ? t.utc : null;
    if (!s || typeof s !== 'string') return null;
    const ms = Date.parse(s.trim().replace(' ', 'T'));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const iataOf = (m) => (m && m.airport && typeof m.airport.iata === 'string' ? m.airport.iata.toUpperCase() : null);

// The leg flown from origin to dest: both ends match, else one end (a leg starting or ending there), else none.
function pickLeg(list, flight) {
    const both = list.find((f) => iataOf(f.departure) === flight.origin_iata && iataOf(f.arrival) === flight.dest_iata);
    if (both) return both;
    return list.find((f) => iataOf(f.departure) === flight.origin_iata) || list.find((f) => iataOf(f.arrival) === flight.dest_iata) || null;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Normalised fields from one FlightContract. Only fields with a value are returned.
function mapFlight(f) {
    const dep = f.departure || {};
    const arr = f.arrival || {};
    const out = {
        dep_terminal: str(dep.terminal),
        dep_gate: str(dep.gate),
        arr_terminal: str(arr.terminal),
        arr_gate: str(arr.gate),
        baggage_belt: str(arr.baggageBelt),
        est_dep: utc(dep.revisedTime) || utc(dep.predictedTime),
        est_arr: utc(arr.revisedTime) || utc(arr.predictedTime),
        actual_dep: utc(dep.runwayTime),
        actual_arr: utc(arr.runwayTime),
        aircraft_type: str(f.aircraft && f.aircraft.model),
        aircraft_reg: str(f.aircraft && f.aircraft.reg),
    };
    // Delay: departure first (actual, else revised), else arrival, against the scheduled time.
    const delay = (m, actual, est) => {
        const sched = utc(m.scheduledTime);
        const real = actual || est;
        return sched && real ? Math.round((Date.parse(real) - Date.parse(sched)) / 60000) : null;
    };
    const d = delay(dep, out.actual_dep, out.est_dep);
    out.delay_min = d != null ? d : delay(arr, out.actual_arr, out.est_arr);
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
}

async function lookup(flight, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, env = process.env } = {}) {
    const key = env.AERODATABOX_API_KEY;
    if (!key) return { ok: false, fields: {}, source_status: null, error: 'not_configured' };
    const provider = PROVIDERS[(env.AERODATABOX_PROVIDER || 'apimarket').toLowerCase()];
    if (!provider) return { ok: false, fields: {}, source_status: null, error: 'bad_provider' };
    const number = encodeURIComponent(`${flight.airline_iata}${flight.flight_number}`);
    const url = `${provider.base}/flights/number/${number}/${flight.dep_local_date}?dateLocalRole=Departure&withAircraftImage=false&withLocation=false`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json', ...provider.headers(key) }, signal: controller.signal });
        if (res.status === 204 || res.status === 404) return { ok: false, fields: {}, source_status: null, error: 'not_found' };
        if (res.status === 401 || res.status === 403) return { ok: false, fields: {}, source_status: null, error: 'unauthorized' };
        if (res.status === 429) return { ok: false, fields: {}, source_status: null, error: 'rate_limited' };
        if (!res.ok) return { ok: false, fields: {}, source_status: null, error: `http_${res.status}` };
        const body = await res.json();
        const list = Array.isArray(body) ? body : [];
        if (!list.length) return { ok: false, fields: {}, source_status: null, error: 'not_found' };
        const leg = pickLeg(list, flight);
        if (!leg) return { ok: false, fields: {}, source_status: null, error: 'no_matching_leg' };
        return { ok: true, fields: mapFlight(leg), source_status: str(leg.status), error: null };
    } catch (err) {
        return { ok: false, fields: {}, source_status: null, error: err && err.name === 'AbortError' ? 'timeout' : err instanceof SyntaxError ? 'bad_response' : 'network' };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    id: 'aerodatabox',
    label: 'AeroDataBox',
    fields: ['actual_dep', 'actual_arr', 'est_dep', 'est_arr', 'delay_min', 'dep_terminal', 'dep_gate', 'arr_terminal', 'arr_gate',
        'baggage_belt', 'aircraft_type', 'aircraft_reg'],
    keyEnv: 'AERODATABOX_API_KEY',
    verified: true,
    lookup,
    // For tests.
    mapFlight, pickLeg, PROVIDERS,
};
