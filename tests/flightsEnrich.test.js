// Flight data enrichment: the AeroDataBox adapter (against hand-made fixtures shaped like the OpenAPI spec's
// FlightContract; UNVERIFIED against a live answer), observations, the merge, locks, refresh and the API.
// Every flight, gate and registration in this file is invented. No real network call is made.
const KEY = 'e'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';
delete process.env.AERODATABOX_API_KEY;

const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const flights = require('../services/flights');
const enrich = require('../services/enrich');
const adb = require('../services/adapters/aerodatabox');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const ENV = { AERODATABOX_API_KEY: 'test-key-not-real' };
const DAY = 24 * 3600 * 1000;
const keys = {};
let agent;

beforeAll(async () => {
    const conn = db.get();
    const make = (name, scopes) => { keys[name] = apiKeys.create(conn, { name, scopes }).key; };
    make('reader', 'flights:read');
    make('writer', 'flights:read, flights:write');
    make('observer', 'flights:read, flights:observe');
    make('observe-only', 'flights:observe');
    make('editor', 'flights:read, flights:edit');
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
afterEach(() => {
    delete process.env.AERODATABOX_API_KEY;
    jest.restoreAllMocks();
});

let seq = 100;
// A flight departing `inDays` from now (UTC), LIT-DFW unless told otherwise.
const mk = (inDays = 2, extra = {}) => {
    const dep = new Date(Date.now() + inDays * DAY);
    dep.setUTCHours(15, 0, 0, 0);
    const arr = new Date(dep.getTime() + 70 * 60000);
    return flights.create(db.get(), {
        airline_iata: 'AA', flight_number: String(seq++), origin_iata: 'LIT', dest_iata: 'DFW',
        sched_dep: dep.toISOString(), sched_arr: arr.toISOString(), booking_ref: 'ZX9QW1', ...extra,
    }, 'seed').id;
};
const row = (id) => flights.get(db.get(), id);

// One FlightContract, as the spec describes it (times as "YYYY-MM-DD HH:MMZ").
const t = (iso) => ({ utc: iso.replace('T', ' ').replace(':00.000Z', 'Z'), local: iso.replace('T', ' ').slice(0, 16) + '-06:00' });
const leg = (from, to, depIso, extra = {}) => {
    const dep = Date.parse(depIso);
    const at = (min) => new Date(dep + min * 60000).toISOString();
    return {
        number: 'AA 100', status: 'Departed', codeshareStatus: 'IsOperator', isCargo: false, lastUpdatedUtc: at(30).replace('T', ' '),
        departure: {
            airport: { iata: from, icao: `K${from}`, name: `${from} airport` },
            scheduledTime: t(at(0)), revisedTime: t(at(25)), runwayTime: t(at(31)), terminal: '1', gate: 'b7', quality: ['Basic', 'Live'],
        },
        arrival: {
            airport: { iata: to, icao: `K${to}`, name: `${to} airport` },
            scheduledTime: t(at(70)), predictedTime: t(at(88)), terminal: 'C', gate: 'C12', baggageBelt: '4', quality: ['Basic'],
        },
        aircraft: { reg: 'N123QA', modeS: 'A0B1C2', model: 'Airbus A321' },
        airline: { name: 'Test Air', iata: 'AA', icao: 'AAL' },
        ...extra,
    };
};
const answer = (status, body) => jest.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }));
const flightFor = (id) => {
    const r = db.get().prepare('SELECT * FROM flights WHERE id = ?').get(id);
    return { airline_iata: r.airline_iata, flight_number: r.flight_number, dep_local_date: r.dep_local_date, origin_iata: r.origin_iata, dest_iata: r.dest_iata, sched_dep: r.sched_dep };
};

describe('AeroDataBox adapter (fixtures; UNVERIFIED against a live key)', () => {
    test('maps one flight to normalised fields and asks the right URL with the API.Market header', async () => {
        const f = { airline_iata: 'AA', flight_number: '100', dep_local_date: '2030-01-05', origin_iata: 'LIT', dest_iata: 'DFW' };
        const fetch = answer(200, [leg('LIT', 'DFW', '2030-01-05T15:00:00.000Z')]);
        const r = await adb.lookup(f, { fetch, env: ENV });
        expect(r).toEqual({
            ok: true, source_status: 'Departed', error: null,
            fields: {
                dep_terminal: '1', dep_gate: 'b7', arr_terminal: 'C', arr_gate: 'C12', baggage_belt: '4',
                est_dep: '2030-01-05T15:25:00.000Z', est_arr: '2030-01-05T16:28:00.000Z', actual_dep: '2030-01-05T15:31:00.000Z',
                aircraft_type: 'Airbus A321', aircraft_reg: 'N123QA', delay_min: 31,
            },
        });
        const [url, opts] = fetch.mock.calls[0];
        expect(url).toBe('https://prod.api.market/api/v1/aedbx/aerodatabox/flights/number/AA100/2030-01-05?dateLocalRole=Departure&withAircraftImage=false&withLocation=false');
        expect(opts.headers['x-api-market-key']).toBe(ENV.AERODATABOX_API_KEY);
    });

    test('RapidAPI uses its host and headers', async () => {
        const fetch = answer(200, [leg('LIT', 'DFW', '2030-01-05T15:00:00.000Z')]);
        const f = { airline_iata: 'AA', flight_number: '100', dep_local_date: '2030-01-05', origin_iata: 'LIT', dest_iata: 'DFW' };
        await adb.lookup(f, { fetch, env: { ...ENV, AERODATABOX_PROVIDER: 'rapidapi' } });
        const [url, opts] = fetch.mock.calls[0];
        expect(url.startsWith('https://aerodatabox.p.rapidapi.com/flights/number/AA100/2030-01-05?')).toBe(true);
        expect(opts.headers).toMatchObject({ 'X-RapidAPI-Key': ENV.AERODATABOX_API_KEY, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' });
    });

    test('a multi-leg answer gives the leg that matches the route; none matching is an error', async () => {
        const legs = [
            leg('MEM', 'LIT', '2030-01-05T12:00:00.000Z', { aircraft: { reg: 'N1FIRST', model: 'A320' } }),
            leg('LIT', 'DFW', '2030-01-05T15:00:00.000Z', { aircraft: { reg: 'N2SECOND', model: 'A320' } }),
        ];
        const f = { airline_iata: 'AA', flight_number: '100', dep_local_date: '2030-01-05', origin_iata: 'LIT', dest_iata: 'DFW' };
        expect((await adb.lookup(f, { fetch: answer(200, legs), env: ENV })).fields.aircraft_reg).toBe('N2SECOND');
        expect((await adb.lookup({ ...f, origin_iata: 'MEM', dest_iata: 'LIT' }, { fetch: answer(200, legs), env: ENV })).fields.aircraft_reg).toBe('N1FIRST');
        const r = await adb.lookup({ ...f, origin_iata: 'ORD', dest_iata: 'ATL' }, { fetch: answer(200, legs), env: ENV });
        expect(r).toMatchObject({ ok: false, error: 'no_matching_leg' });
    });

    test('without a key it is not configured and calls nothing', async () => {
        const fetch = jest.fn();
        expect(await adb.lookup({ airline_iata: 'AA', flight_number: '1', dep_local_date: '2030-01-05' }, { fetch, env: {} }))
            .toMatchObject({ ok: false, error: 'not_configured' });
        expect(fetch).not.toHaveBeenCalled();
    });

    test('timeouts, HTTP errors, empty answers and network failures are errors, never throws', async () => {
        const f = { airline_iata: 'AA', flight_number: '1', dep_local_date: '2030-01-05', origin_iata: 'LIT', dest_iata: 'DFW' };
        const hang = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        expect((await adb.lookup(f, { fetch: hang, env: ENV, timeoutMs: 20 })).error).toBe('timeout');
        expect((await adb.lookup(f, { fetch: answer(429, {}), env: ENV })).error).toBe('rate_limited');
        expect((await adb.lookup(f, { fetch: answer(500, {}), env: ENV })).error).toBe('http_500');
        expect((await adb.lookup(f, { fetch: answer(401, {}), env: ENV })).error).toBe('unauthorized');
        expect((await adb.lookup(f, { fetch: answer(204, null), env: ENV })).error).toBe('not_found');
        expect((await adb.lookup(f, { fetch: answer(200, []), env: ENV })).error).toBe('not_found');
        expect((await adb.lookup(f, { fetch: jest.fn(async () => { throw new TypeError('fetch failed'); }), env: ENV })).error).toBe('network');
        const badJson = jest.fn(async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('bad'); } }));
        expect((await adb.lookup(f, { fetch: badJson, env: ENV })).error).toBe('bad_response');
    });

    test('delay falls back to the arrival when the departure has no times', () => {
        const l = leg('LIT', 'DFW', '2030-01-05T15:00:00.000Z');
        delete l.departure.revisedTime;
        delete l.departure.runwayTime;
        expect(adb.mapFlight(l).delay_min).toBe(18);
    });
});

describe('observations and the merge', () => {
    test('the best source by priority wins, one enrich revision, nothing written when nothing changed', () => {
        const conn = db.get();
        const id = mk();
        enrich.observe(conn, id, 'gmail', { dep_gate: 'C3', baggage_belt: '9' }, { actor: 't' });
        enrich.observe(conn, id, 'aerodatabox', { dep_gate: 'b7', aircraft_reg: 'n123qa' }, { actor: 't' });
        const r = enrich.applyObservations(conn, id, 'tester');
        expect(r).toMatchObject({ status: 'updated', rev: 2, sources: ['aerodatabox', 'gmail'] });
        expect(r.fields.sort()).toEqual(['aircraft_reg', 'baggage_belt', 'dep_gate']);
        expect(row(id)).toMatchObject({ dep_gate: 'B7', baggage_belt: '9', aircraft_reg: 'N123QA', rev: 2 });
        const h = flights.history(conn, id)[0];
        expect(h).toMatchObject({ source: 'enrich', actor: 'tester', note: 'From aerodatabox, gmail' });
        expect(enrich.applyObservations(conn, id, 'tester').status).toBe('unchanged');
        expect(flights.history(conn, id)).toHaveLength(2);
        // gmail first now
        enrich.putSources(conn, { name: 'gmail', priority: 5 });
        expect(enrich.applyObservations(conn, id, 'tester').fields).toEqual(['dep_gate']);
        expect(row(id).dep_gate).toBe('C3');
        enrich.putSources(conn, { name: 'gmail', priority: 20 });
    });

    test('a source without a settings row comes last', () => {
        const conn = db.get();
        const id = mk();
        conn.prepare("DELETE FROM flight_sources WHERE name = 'gmail'").run();
        enrich.putSources(conn, { name: 'aerodatabox', priority: 500 });
        enrich.observe(conn, id, 'gmail', { arr_gate: 'D1' }, {});
        enrich.observe(conn, id, 'aerodatabox', { arr_gate: 'E2' }, {});
        enrich.applyObservations(conn, id, 't');
        expect(row(id).arr_gate).toBe('E2');
        enrich.putSources(conn, { sources: [{ name: 'aerodatabox', priority: 10 }, { name: 'gmail', priority: 20, monthly_cap: null }] });
    });

    test('only the latest ok observation of a source counts; failed lookups are ignored', () => {
        const conn = db.get();
        const id = mk();
        enrich.observe(conn, id, 'aerodatabox', { dep_gate: 'A1' }, {});
        enrich.observe(conn, id, 'aerodatabox', { dep_gate: 'A2' }, {});
        enrich.observe(conn, id, 'aerodatabox', {}, { ok: false, error: 'timeout' });
        enrich.applyObservations(conn, id, 't');
        expect(row(id).dep_gate).toBe('A2');
    });

    test('a hand edit locks the field against sources; unlock hands it back', () => {
        const conn = db.get();
        const id = mk();
        const edit = flights.update(conn, id, { dep_gate: 'H1', seat: '3c' }, 'person');
        expect(edit.locked_fields).toEqual(['dep_gate']);
        expect(row(id).locked_fields).toEqual(['dep_gate']);
        // the same value again changes nothing and locks nothing more
        expect(flights.update(conn, id, { dep_gate: 'H1', arr_gate: null }, 'person').status).toBe('unchanged');
        enrich.observe(conn, id, 'aerodatabox', { dep_gate: 'Z9', arr_gate: 'Z8' }, {});
        const r = enrich.applyObservations(conn, id, 't');
        expect(r.fields).toEqual(['arr_gate']);
        expect(row(id)).toMatchObject({ dep_gate: 'H1', arr_gate: 'Z8' });
        const rev = row(id).rev;
        const un = flights.update(conn, id, { unlock: ['dep_gate'] }, 'person');
        expect(un).toMatchObject({ status: 'updated', rev, locked_fields: [] });
        enrich.applyObservations(conn, id, 't');
        expect(row(id).dep_gate).toBe('Z9');
        expect(() => flights.update(conn, id, { unlock: ['seat'] }, 'person')).toThrow(/unlock takes/);
        expect(flights.update(conn, id, { unlock: ['dep_gate'] }, 'person').status).toBe('unchanged');
    });

    test('a source saying cancelled is a chip, never the status', () => {
        const conn = db.get();
        const id = mk();
        enrich.observe(conn, id, 'aerodatabox', {}, { source_status: 'Canceled' });
        expect(row(id)).toMatchObject({ status: 'scheduled', status_override: null, source_says_cancelled: true });
        expect(flights.list(conn, { limit: 500 }).flights.find((f) => f.id === id).source_says_cancelled).toBe(true);
        expect(flights.upcoming(conn, { limit: 50 }).find((f) => f.id === id).source_says_cancelled).toBe(true);
        enrich.observe(conn, id, 'aerodatabox', {}, { source_status: 'Expected' });
        expect(row(id).source_says_cancelled).toBe(false);
    });

    test('observe refuses unknown sources and, when strict, unknown or bad fields', () => {
        const conn = db.get();
        const id = mk();
        expect(() => enrich.observe(conn, id, 'flightradar', {}, {})).toThrow(/source must be/);
        expect(() => enrich.observe(conn, id, 'gmail', { seat: '1A' }, { strict: true })).toThrow(/A source can only send/);
        expect(() => enrich.observe(conn, id, 'gmail', { delay_min: 'late' }, { strict: true })).toThrow(/delay_min/);
        expect(() => enrich.observe(conn, id, 'gmail', { est_dep: 'soon' }, { strict: true })).toThrow(/est_dep/);
        expect(enrich.observe(conn, id, 'aerodatabox', { seat: '1A', delay_min: 'late', dep_gate: 'G1' }, {}).fields).toEqual(['dep_gate']);
    });
});

describe('refresh', () => {
    const fx = (id) => answer(200, [leg('LIT', 'DFW', flightFor(id).sched_dep)]);

    test('looks up, merges, then skips a recent lookup unless forced; counts every call', async () => {
        const conn = db.get();
        const id = mk();
        const month = enrich.monthOf();
        const before = enrich.listSources(conn).sources.find((s) => s.name === 'aerodatabox').calls_this_month;
        let fetch = fx(id);
        const r = await enrich.refresh(conn, id, { fetch, env: ENV, actor: 'job' });
        expect(r.status).toBe('updated');
        expect(r.results).toEqual([{ source: 'aerodatabox', result: 'updated', detail: expect.stringContaining('dep_gate') }]);
        expect(row(id)).toMatchObject({ dep_gate: 'B7', delay_min: 31, aircraft_type: 'Airbus A321', aircraft_reg: 'N123QA', booking_ref: 'ZX9QW1' });
        fetch = fx(id);
        const again = await enrich.refresh(conn, id, { fetch, env: ENV });
        expect(again.results[0].result).toBe('skipped_recent');
        expect(fetch).not.toHaveBeenCalled();
        const forced = await enrich.refresh(conn, id, { fetch, env: ENV, force: true });
        expect(forced.results[0]).toMatchObject({ result: 'unchanged', detail: 'status Departed' });
        expect(fetch).toHaveBeenCalledTimes(1);
        const calls = conn.prepare('SELECT calls FROM flight_source_usage WHERE source = ? AND month = ?').get('aerodatabox', month).calls;
        expect(calls - before).toBe(2);
    });

    test('a flight that left over 30 days ago is skipped unless forced', async () => {
        const id = mk(-40);
        const fetch = fx(id);
        expect((await enrich.refresh(db.get(), id, { fetch, env: ENV })).results[0].result).toBe('skipped_old');
        expect(fetch).not.toHaveBeenCalled();
        expect((await enrich.refresh(db.get(), id, { fetch, env: ENV, force: true })).results[0].result).toBe('updated');
    });

    test('the monthly cap stops lookups, also when forced; errors count as calls', async () => {
        const conn = db.get();
        const month = enrich.monthOf();
        const used = enrich.listSources(conn).sources.find((s) => s.name === 'aerodatabox').calls_this_month;
        enrich.putSources(conn, { name: 'aerodatabox', monthly_cap: used + 1 });
        const id = mk();
        const r = await enrich.refresh(conn, id, { fetch: answer(500, {}), env: ENV });
        expect(r.results).toEqual([{ source: 'aerodatabox', result: 'error', detail: 'http_500' }]);
        expect(r.looked_up).toBe(1);
        const fetch = fx(id);
        const capped = await enrich.refresh(conn, id, { fetch, env: ENV, force: true });
        expect(capped.results[0]).toMatchObject({ result: 'cap_reached', detail: `${used + 1} of ${used + 1} calls this month` });
        expect(fetch).not.toHaveBeenCalled();
        expect(conn.prepare('SELECT calls FROM flight_source_usage WHERE source = ? AND month = ?').get('aerodatabox', month).calls).toBe(used + 1);
        // no settings row: the default cap of 80
        conn.prepare("DELETE FROM flight_sources WHERE name = 'aerodatabox'").run();
        conn.prepare('UPDATE flight_source_usage SET calls = 80 WHERE source = ? AND month = ?').run('aerodatabox', month);
        expect((await enrich.refresh(conn, mk(), { fetch, env: ENV })).results[0].result).toBe('cap_reached');
        conn.prepare('UPDATE flight_source_usage SET calls = ? WHERE source = ? AND month = ?').run(used + 1, 'aerodatabox', month);
        enrich.putSources(conn, { name: 'aerodatabox', priority: 10, monthly_cap: 1000 });
    });

    test('not configured without the key; a disabled source is left out; locked fields stay', async () => {
        const conn = db.get();
        const id = mk();
        expect((await enrich.refresh(conn, id, { env: {} })).results).toEqual([{ source: 'aerodatabox', result: 'not_configured', detail: 'AERODATABOX_API_KEY is not set' }]);
        flights.update(conn, id, { aircraft_type: 'B738' }, 'person');
        const r = await enrich.refresh(conn, id, { fetch: fx(id), env: ENV });
        expect(r.fields).not.toContain('aircraft_type');
        expect(row(id).aircraft_type).toBe('B738');
        enrich.putSources(conn, { name: 'aerodatabox', enabled: false });
        expect((await enrich.refresh(conn, id, { env: ENV, force: true })).results).toEqual([]);
        enrich.putSources(conn, { name: 'aerodatabox', enabled: true });
    });

    test('source settings are validated', () => {
        const conn = db.get();
        expect(() => enrich.putSources(conn, { name: 'nope' })).toThrow(/source must be/);
        expect(() => enrich.putSources(conn, { name: 'gmail', priority: -1 })).toThrow(/priority/);
        expect(() => enrich.putSources(conn, { name: 'gmail', enabled: 'yes' })).toThrow(/enabled/);
        expect(() => enrich.putSources(conn, { name: 'gmail', key: 'x' })).toThrow(/Unknown field/);
    });
});

const auth = (k) => ({ Authorization: `Bearer ${keys[k]}` });
const auditText = () => db.get().prepare('SELECT action, detail FROM audit_log').all().map((r) => `${r.action} ${r.detail || ''}`).join('\n');

describe('REST /hub/flights', () => {
    test('observations need flights:observe plus flights:read; merged and audited by field name only', async () => {
        const id = mk();
        const body = { source: 'gmail', fields: { dep_gate: 'Q77', delay_min: 45 }, source_status: 'Delayed' };
        await request(app).post(`/hub/flights/${id}/observations`).set(auth('observe-only')).send(body).expect(403);
        await request(app).post(`/hub/flights/${id}/observations`).set(auth('reader')).send(body).expect(403);
        await request(app).post(`/hub/flights/${id}/observations`).set(auth('writer')).send(body).expect(403);
        const res = await request(app).post(`/hub/flights/${id}/observations`).set(auth('observer')).send(body).expect(201);
        expect(res.body.observation).toMatchObject({ source: 'gmail', ok: true, source_status: 'Delayed' });
        expect(res.body.result).toMatchObject({ status: 'updated', sources: ['gmail'] });
        expect(row(id)).toMatchObject({ dep_gate: 'Q77', delay_min: 45 });
        const bad = await request(app).post(`/hub/flights/${id}/observations`).set(auth('observer')).send({ source: 'gmail', fields: { seat: '1A' } }).expect(400);
        expect(bad.body.error).toBe('bad_field');
        expect((await request(app).post(`/hub/flights/${id}/observations`).set(auth('observer')).send({ source: 'x', fields: {} }).expect(400)).body.error).toBe('bad_source');
        await request(app).post('/hub/flights/999999/observations').set(auth('observer')).send(body).expect(404);
        const a = auditText();
        expect(a).toMatch(/flight_observed/);
        expect(a).not.toMatch(/Q77/);
        expect(a).not.toMatch(/ZX9QW1/);
    });

    test('sources: read for flights:read, change with flights:write; never a key value', async () => {
        process.env.AERODATABOX_API_KEY = 'secret-value-canary';
        const res = await request(app).get('/hub/flights/sources').set(auth('reader')).expect(200);
        const a = res.body.sources.find((s) => s.name === 'aerodatabox');
        expect(a).toMatchObject({ kind: 'pull', configured: true, enabled: true, priority: 10, verified: true });
        expect(JSON.stringify(res.body)).not.toMatch(/secret-value-canary/);
        await request(app).put('/hub/flights/sources').set(auth('reader')).send({ name: 'gmail', priority: 30 }).expect(403);
        const put = await request(app).put('/hub/flights/sources').set(auth('writer')).send({ name: 'gmail', priority: 30 }).expect(200);
        expect(put.body.sources.find((s) => s.name === 'gmail').priority).toBe(30);
        await request(app).put('/hub/flights/sources').set(auth('writer')).send({ name: 'gmail', priority: 'high' }).expect(400);
        await request(app).put('/hub/flights/sources').set(auth('writer')).send({ name: 'gmail', priority: 20 }).expect(200);
        delete process.env.AERODATABOX_API_KEY;
        expect((await request(app).get('/hub/flights/sources').set(auth('reader'))).body.sources.find((s) => s.name === 'aerodatabox').configured).toBe(false);
        expect(auditText()).toMatch(/flight_sources_changed/);
    });

    test('refresh needs read and write; looks up with the key from the environment', async () => {
        const id = mk();
        await request(app).post(`/hub/flights/${id}/refresh`).set(auth('reader')).send({}).expect(403);
        await request(app).post(`/hub/flights/${id}/refresh`).set(auth('observer')).send({}).expect(403);
        const none = await request(app).post(`/hub/flights/${id}/refresh`).set(auth('writer')).send({}).expect(200);
        expect(none.body.results).toEqual([expect.objectContaining({ source: 'aerodatabox', result: 'not_configured' })]);
        process.env.AERODATABOX_API_KEY = 'secret-value-canary';
        const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(answer(200, [leg('LIT', 'DFW', flightFor(id).sched_dep)]));
        const res = await request(app).post(`/hub/flights/${id}/refresh`).set(auth('writer')).send({}).expect(200);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(res.body).toMatchObject({ status: 'updated', results: [expect.objectContaining({ result: 'updated' })] });
        expect(row(id).arr_gate).toBe('C12');
        await request(app).post('/hub/flights/999999/refresh').set(auth('writer')).send({}).expect(404);
        const a = auditText();
        expect(a).toMatch(/flight_refreshed.*aerodatabox:updated/);
        expect(a).not.toMatch(/C12|secret-value-canary/);
    });

    test('PATCH with new fields locks them; unlock over REST', async () => {
        const id = mk();
        const res = await request(app).patch(`/hub/flights/${id}`).set(auth('writer')).send({ dep_terminal: 'b', est_dep: '2030-01-01T10:00Z' }).expect(200);
        expect(res.body.locked_fields).toEqual(['est_dep', 'dep_terminal']);
        const un = await request(app).patch(`/hub/flights/${id}`).set(auth('writer')).send({ unlock: ['est_dep'] }).expect(200);
        expect(un.body.locked_fields).toEqual(['dep_terminal']);
        const got = (await request(app).get(`/hub/flights/${id}`).set(auth('reader')).expect(200)).body;
        expect(got).toMatchObject({ dep_terminal: 'B', est_dep: '2030-01-01T10:00:00.000Z', locked_fields: ['dep_terminal'], source_says_cancelled: false });
        await request(app).patch(`/hub/flights/${id}`).set(auth('writer')).send({ delay_min: 9999 }).expect(400);
    });
});

describe('admin API', () => {
    test('sources, refresh and unlock mirror /hub', async () => {
        const id = mk();
        const s = await agent.get('/admin/api/flights/sources').expect(200);
        expect(s.body.sources.map((x) => x.name).sort()).toEqual(['aerodatabox', 'gmail']);
        await agent.put('/admin/api/flights/sources').send({ name: 'gmail', priority: 25 }).expect(403);
        const put = await agent.put('/admin/api/flights/sources').set(H).send({ name: 'gmail', priority: 25 }).expect(200);
        expect(put.body.sources.find((x) => x.name === 'gmail').priority).toBe(25);
        await agent.put('/admin/api/flights/sources').set(H).send({ name: 'gmail', priority: 20 }).expect(200);
        const r = await agent.post(`/admin/api/flights/${id}/refresh`).set(H).send({}).expect(200);
        expect(r.body.results[0].result).toBe('not_configured');
        await agent.patch(`/admin/api/flights/${id}`).set(H).send({ baggage_belt: '7' }).expect(200);
        expect(row(id).locked_fields).toEqual(['baggage_belt']);
        await agent.patch(`/admin/api/flights/${id}`).set(H).send({ unlock: ['baggage_belt'] }).expect(200);
        expect(row(id).locked_fields).toEqual([]);
        await request(app).get('/admin/api/flights/sources').expect(401);
    });
});
