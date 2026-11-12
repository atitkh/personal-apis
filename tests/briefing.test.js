process.env.HUB_DB_FILE = ':memory:';
process.env.ADMIN_KEY = 'briefing-admin-key-0123456789abcdef';

// Every flight, booking reference and street in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const digests = require('../services/digests');
const flights = require('../services/flights');
const places = require('../services/places');
const deadlines = require('../services/deadlines');
const briefing = require('../services/briefing');
const registry = require('../services/mcp/registry');
const audit = require('../services/audit');
const app = require('../app');

const NOW = new Date('2026-11-11T16:00:00Z'); // 10:00 in Chicago
const BOOKING = 'QZ7RK2';
const STREET = 'Maple Ridge Dr';
const H = { 'X-Requested-With': 'hub-admin' };

const flight = (extra = {}) => ({
    airline_iata: 'CX', flight_number: '891', origin_iata: 'DFW', dest_iata: 'HKG',
    sched_dep: '2026-12-17T01:00:00Z', sched_arr: '2026-12-17T17:00:00Z', ...extra,
});
const addFlight = (conn, extra) => flights.create(conn, flight(extra), 'tester');
const addSuggestion = (conn, street = STREET) => conn.prepare(
    "INSERT INTO place_suggestions (street, count, first_seen, last_seen, status) VALUES (?, 1, ?, ?, 'pending')").run(street, NOW.toISOString(), NOW.toISOString());
const addDigest = (conn, period) => digests.put(conn, 'daily', period, { body: 'A quiet day.', source: 'generated', actor: 'test' });

afterAll(() => db.close());

describe('briefing.collect', () => {
    let conn;
    beforeEach(() => { conn = db.open(':memory:'); });
    afterEach(() => conn.close());

    const collect = (o = {}) => briefing.collect(conn, { now: NOW, ...o });

    test('an empty hub gives an empty briefing', () => {
        expect(collect()).toEqual({ generated_at: NOW.toISOString(), days: 14, attention: [], upcoming: [], more: 0 });
    });

    test('flights: the next flight inside the horizon is upcoming, with an airport-local date', () => {
        const f = addFlight(conn, { sched_dep: '2026-11-13T01:00:00Z', sched_arr: '2026-11-13T05:00:00Z' });
        const out = collect();
        expect(out.upcoming).toHaveLength(1);
        expect(out.upcoming[0]).toMatchObject({
            id: `flights:${f.id}:departs-2026-11-12`, domain: 'flights', severity: 'info',
            date: '2026-11-12', ref: { domain: 'flights', id: f.id },
        });
        expect(out.upcoming[0].text).toBe('CX 891 DFW to HKG departs tomorrow (2026-11-12)');
    });

    test('flights past the horizon are left out until the horizon grows', () => {
        addFlight(conn); // 2026-12-16 local, 35 days away
        expect(collect().upcoming).toEqual([]);
        const out = collect({ days: 60 });
        expect(out.upcoming).toHaveLength(1);
        expect(out.upcoming[0].text).toBe('CX 891 DFW to HKG departs in 35 days (2026-12-16)');
    });

    test('found flights, place suggestions and a missing digest need attention', () => {
        flights.suggest(conn, { airline_iata: 'AS', flight_number: '2', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2026-12-01T08:00', source: 'gmail', source_key: 'g:1' }, 'job');
        flights.suggest(conn, { airline_iata: 'AS', flight_number: '3', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2026-12-02T08:00', source: 'gmail', source_key: 'g:2' }, 'job');
        addSuggestion(conn);
        addDigest(conn, '2026-11-01'); // some daily exists, yesterday's (2026-11-10) does not
        const ids = collect().attention.map((i) => i.id);
        expect(ids).toEqual(expect.arrayContaining(['flights:candidates:pending', 'places:suggestions:pending', 'digests:missing:2026-11-10']));
        const found = collect().attention.find((i) => i.id === 'flights:candidates:pending');
        expect(found.text).toBe('2 found flights wait for review');
    });

    test('the digest is not missing before 6 AM in Chicago, or when it has arrived', () => {
        addDigest(conn, '2026-11-01');
        expect(briefing.collect(conn, { now: new Date('2026-11-11T10:00:00Z') }).attention).toEqual([]); // 04:00
        addDigest(conn, '2026-11-10');
        expect(collect().attention).toEqual([]);
    });

    test('a flight a source says is cancelled is urgent, whatever the horizon', () => {
        const f = addFlight(conn, { sched_dep: '2027-03-01T15:00:00Z', sched_arr: '2027-03-01T18:00:00Z' });
        require('../services/enrich').observe(conn, f.id, 'aerodatabox', {}, { source_status: 'cancelled', at: NOW.toISOString(), actor: 'test' });
        const out = collect();
        expect(out.attention).toEqual([expect.objectContaining({ severity: 'urgent', domain: 'flights', ref: { domain: 'flights', id: f.id } })]);
        expect(out.upcoming).toEqual([]);
    });

    test('ids are stable across two calls', () => {
        addFlight(conn, { sched_dep: '2026-11-20T15:00:00Z', sched_arr: '2026-11-20T18:00:00Z' });
        addSuggestion(conn);
        const ids = (o) => [...o.attention, ...o.upcoming].map((i) => i.id);
        const a = collect();
        const b = briefing.collect(conn, { now: new Date(NOW.getTime() + 60000) });
        expect(ids(a)).toEqual(ids(b));
        expect(ids(a).length).toBe(2);
    });

    test('days defaults to 14 and is clamped to 1..90', () => {
        expect(collect().days).toBe(14);
        expect(collect({ days: 0 }).days).toBe(1);
        expect(collect({ days: -5 }).days).toBe(1);
        expect(collect({ days: 500 }).days).toBe(90);
        expect(collect({ days: '30' }).days).toBe(30);
        expect(collect({ days: 'soon' }).days).toBe(14);
        expect(collect({ days: 7.9 }).days).toBe(7);
    });

    describe('with extra domains', () => {
        const made = [];
        const fake = (name, briefingFn, extra = {}) => {
            domains.REGISTRY[name] = { title: name, sensitivity: 'private', storage: 'db', defaultEnabled: true, stats: () => ({}), briefing: briefingFn, ...extra };
            made.push(name);
        };
        afterEach(() => { while (made.length) delete domains.REGISTRY[made.pop()]; });
        const item = (id, severity, date, extra = {}) => ({ id, severity, text: id, date, ...extra });

        test('items are ordered by severity, then date, then id; sections follow the hook', () => {
            fake('zz', () => ({
                attention: [item('zz:c', 'attention', '2026-11-20'), item('zz:a', 'urgent', '2026-11-30'), item('zz:b', 'attention', '2026-11-12'), item('zz:d', 'info')],
                upcoming: [item('zz:u2', 'info', '2026-11-15'), item('zz:u1', 'info', '2026-11-14')],
            }));
            const out = collect({ domains: ['zz'] });
            expect(out.attention.map((i) => i.id)).toEqual(['zz:a', 'zz:b', 'zz:c', 'zz:d']);
            expect(out.upcoming.map((i) => i.id)).toEqual(['zz:u1', 'zz:u2']);
        });

        test('a flat list from a hook goes to upcoming', () => {
            fake('zz', () => [item('zz:1', 'info', '2026-11-12')]);
            expect(collect({ domains: ['zz'] }).upcoming.map((i) => i.id)).toEqual(['zz:1']);
        });

        test('about 20 items are kept, attention first, and `more` counts the rest', () => {
            fake('zz', () => ({
                attention: Array.from({ length: 8 }, (_, i) => item(`zz:a${i}`, 'attention', `2026-11-${String(12 + i).padStart(2, '0')}`)),
                upcoming: Array.from({ length: 20 }, (_, i) => item(`zz:u${String(i).padStart(2, '0')}`, 'info', `2026-11-${String(12 + (i % 15)).padStart(2, '0')}`)),
            }));
            const out = collect({ domains: ['zz'] });
            expect(out.attention).toHaveLength(8);
            expect(out.upcoming).toHaveLength(12);
            expect(out.more).toBe(8);
            const many = (n) => ({ attention: Array.from({ length: n }, (_, i) => item(`zz:x${i}`, 'urgent', '2026-11-12')), upcoming: [item('zz:u', 'info')] });
            domains.REGISTRY.zz.briefing = () => many(25);
            const big = collect({ domains: ['zz'] });
            expect(big.attention).toHaveLength(20);
            expect(big.upcoming).toHaveLength(0);
            expect(big.more).toBe(6);
        });

        test('a hook that throws is skipped and the others still run', () => {
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
            fake('zz', () => { throw new Error('boom'); });
            fake('yy', () => [item('yy:1', 'info')]);
            const out = collect({ domains: ['zz', 'yy'] });
            expect(out.upcoming.map((i) => i.id)).toEqual(['yy:1']);
            spy.mockRestore();
        });

        test('malformed items are dropped, not thrown on', () => {
            fake('zz', () => ({ attention: [null, { id: 3 }, { id: 'zz:ok', text: 'fine', severity: 'bogus' }] }));
            expect(collect({ domains: ['zz'] }).attention).toEqual([{ id: 'zz:ok', domain: 'zz', severity: 'info', text: 'fine' }]);
        });

        test('a domain that is off contributes nothing and its hook does not run', () => {
            const hook = jest.fn(() => [item('zz:1', 'info')]);
            fake('zz', hook);
            domains.setEnabled(conn, 'zz', false, 'test');
            expect(collect({ domains: ['zz'] }).upcoming).toEqual([]);
            expect(hook).not.toHaveBeenCalled();
            domains.setEnabled(conn, 'places', false, 'test');
            addSuggestion(conn);
            expect(collect().attention).toEqual([]);
        });

        test('visibleDomains and the domains list both narrow, and hidden hooks do not run', () => {
            const hook = jest.fn(() => [item('zz:1', 'info')]);
            fake('zz', hook);
            addSuggestion(conn);
            expect(collect({ visibleDomains: ['places'] }).attention.map((i) => i.domain)).toEqual(['places']);
            expect(hook).not.toHaveBeenCalled();
            expect(collect({ visibleDomains: ['zz'] }).upcoming.map((i) => i.id)).toEqual(['zz:1']);
            expect(collect({ visibleDomains: [] })).toMatchObject({ attention: [], upcoming: [], more: 0 });
            expect(collect({ domains: ['zz'], visibleDomains: ['places'] })).toMatchObject({ attention: [], upcoming: [] });
        });
    });

    test('no sensitive text: a booking reference and a street appear nowhere in the JSON', () => {
        addFlight(conn, { booking_ref: BOOKING, sched_dep: '2026-11-15T15:00:00Z', sched_arr: '2026-11-15T18:00:00Z' });
        const f2 = addFlight(conn, { booking_ref: BOOKING, flight_number: '12', sched_dep: '2027-01-15T15:00:00Z', sched_arr: '2027-01-15T18:00:00Z' });
        require('../services/enrich').observe(conn, f2.id, 'aerodatabox', {}, { source_status: 'cancelled', at: NOW.toISOString(), actor: 'test' });
        flights.suggest(conn, { airline_iata: 'AS', flight_number: '2', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2026-12-01T08:00', booking_ref: BOOKING, source: 'gmail', source_key: 'g:1' }, 'job');
        places.create(conn, { label: 'Home', kind: 'home', rules: [{ type: 'street', value: STREET }] }, 'tester');
        addSuggestion(conn);
        const out = collect({ days: 90 });
        expect(out.attention.length + out.upcoming.length).toBeGreaterThan(2);
        const json = JSON.stringify(out);
        expect(json).not.toContain(BOOKING);
        expect(json).not.toContain(STREET);
        expect(json).not.toContain('Maple');
    });
});

describe('briefing: deadlines hook', () => {
    let conn;
    beforeEach(() => { conn = db.open(':memory:'); });
    afterEach(() => conn.close());

    const collect = (o = {}) => briefing.collect(conn, { now: NOW, ...o });
    // Today in Chicago is 2026-11-11.
    const add = (extra) => deadlines.create(conn, { title: 'Passport renewal', kind: 'document', due_date: '2026-12-30', ...extra }, 'tester').id;
    const all = (out) => [...out.attention, ...out.upcoming];

    test('windows are per item: urgent, attention, and upcoming only inside the horizon', () => {
        const urgent = add({ title: 'Urgent one', due_date: '2026-11-13', lead_days: 30, urgent_days: 3 });
        const attn = add({ title: 'Attention one', due_date: '2026-11-25', lead_days: 30, urgent_days: 3 });
        const near = add({ title: 'Near later', due_date: '2026-11-20', lead_days: 5, urgent_days: 1 });
        const far = add({ title: 'Far later', due_date: '2026-12-30', lead_days: 5, urgent_days: 1 });
        const out = collect();
        expect(out.attention.map((i) => [i.id, i.severity])).toEqual([
            [`deadlines:${urgent}:due-2026-11-13`, 'urgent'], [`deadlines:${attn}:due-2026-11-25`, 'attention'],
        ]);
        expect(out.attention[0]).toMatchObject({ domain: 'deadlines', text: 'Urgent one due in 2 days (2026-11-13)', date: '2026-11-13', ref: { domain: 'deadlines', id: urgent } });
        expect(out.attention[1].text).toBe('Attention one due in 14 days (2026-11-25)');
        // Inside the 14-day horizon but outside its own lead window: info under upcoming.
        expect(out.upcoming).toHaveLength(1);
        expect(out.upcoming[0]).toMatchObject({ id: `deadlines:${near}:due-2026-11-20`, severity: 'info', text: 'Near later due in 9 days (2026-11-20)' });
        expect(all(out).some((i) => i.ref.id === far)).toBe(false);
        expect(collect({ days: 60 }).upcoming.map((i) => i.ref.id)).toEqual([near, far]);
    });

    test('a lead window longer than the horizon still raises attention', () => {
        const id = add({ title: 'Passport', due_date: '2027-02-01', lead_days: 90, urgent_days: 14 });
        expect(collect({ days: 7 }).attention.map((i) => i.id)).toEqual([`deadlines:${id}:due-2027-02-01`]);
    });

    test('due today, one day, and overdue', () => {
        const today = add({ title: 'Today thing', due_date: '2026-11-11' });
        const one = add({ title: 'Tomorrow thing', due_date: '2026-11-12' });
        const late = add({ title: 'Late thing', due_date: '2026-11-01' });
        const out = collect();
        const byId = Object.fromEntries(out.attention.map((i) => [i.ref.id, i]));
        expect(byId[today]).toMatchObject({ severity: 'urgent', text: 'Today thing due today (2026-11-11)' });
        expect(byId[one].text).toBe('Tomorrow thing due in 1 day (2026-11-12)');
        expect(byId[late]).toMatchObject({ id: `deadlines:${late}:due-2026-11-01:overdue`, severity: 'urgent', text: 'Overdue: Late thing (was due 2026-11-01)', date: '2026-11-01' });
        expect(out.attention[0].ref.id).toBe(late); // oldest date first within a severity
    });

    test('done, ended and one-off finished items are silent; a rolled item follows its new date', () => {
        const done = add({ title: 'Finished', due_date: '2026-11-12' });
        const ended = add({ title: 'Cancelled', due_date: '2026-11-12' });
        const rolling = add({ title: 'Yearly', due_date: '2026-11-12', repeat_kind: 'yearly' });
        deadlines.done(conn, done, 'tester', { now: NOW });
        deadlines.end(conn, ended, 'tester');
        deadlines.done(conn, rolling, 'tester', { now: NOW });
        expect(collect().attention).toEqual([]);
        expect(collect({ days: 90 }).upcoming).toEqual([]);
        expect(collect({ days: 90 }).attention).toEqual([]);
        expect(deadlines.get(conn, rolling, { now: NOW }).due_date).toBe('2027-11-12');
    });

    test('a changed due date gives a new id, the same date gives the same id', () => {
        const id = add({ title: 'Move me', due_date: '2026-11-13' });
        const first = collect().attention[0].id;
        expect(collect().attention[0].id).toBe(first);
        deadlines.update(conn, id, { due_date: '2026-11-14' }, 'tester');
        expect(collect().attention[0].id).toBe(`deadlines:${id}:due-2026-11-14`);
        expect(first).not.toBe(`deadlines:${id}:due-2026-11-14`);
    });

    test('privacy: reference, amount and notes appear nowhere in the briefing', () => {
        add({ title: 'Car insurance', kind: 'insurance', due_date: '2026-11-12', reference: 'POL-8841-ZETA', notes: 'call agent Bob on 555-0142' });
        add({ title: 'Streaming', kind: 'subscription', due_date: '2026-11-01', amount_cents: 123456, currency: 'USD', cycle: 'monthly', reference: 'ACCT-7777-OMEGA', notes: 'family plan secret' });
        add({ title: 'Gym', kind: 'membership', due_date: '2026-12-01', amount_cents: 98765, currency: 'EUR', issuer: 'Iron Works Ltd', reference: 'MEM-5150-SIGMA' });
        const out = collect({ days: 90 });
        expect(all(out).length).toBe(3);
        const json = JSON.stringify(out);
        for (const secret of ['POL-8841', 'ACCT-7777', 'MEM-5150', '555-0142', 'Bob', 'family plan', 'Iron Works', '123456', '98765', 'USD', 'EUR', 'amount', 'reference', 'notes']) {
            expect(json).not.toContain(secret);
        }
    });

    test('the briefing only includes deadlines for a key that can read them', () => {
        add({ due_date: '2026-11-12' });
        expect(collect({ visibleDomains: ['places'] }).attention).toEqual([]);
        expect(collect({ visibleDomains: ['deadlines'] }).attention).toHaveLength(1);
        expect(collect({ domains: ['flights'] }).attention).toEqual([]);
    });
});

/* ---------- MCP tool, REST route, admin endpoint ---------- */

const keys = {};
const rpc = (key, method, params = {}) => {
    const r = request(app).post('/hub/mcp').set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json');
    if (key) r.set('Authorization', `Bearer ${key}`);
    return r.send({ jsonrpc: '2.0', id: 1, method, params });
};
const jsonOf = (result) => JSON.parse(result.content[0].text.replace(/^NOTE:[^\n]*\n/, ''));
const bearer = (k) => ({ Authorization: `Bearer ${k}` });

describe('hub_briefing, GET /hub/briefing, GET /admin/api/briefing', () => {
    beforeAll(() => {
        const conn = db.get();
        const make = (name, scopes) => { keys[name] = apiKeys.create(conn, { name, scopes }).key; };
        make('everything', '*');
        make('flights-reader', 'flights:read');
        make('places-reader', 'places:read');
        make('nothing', 'attendance:read');
        addFlight(conn, { booking_ref: BOOKING, sched_dep: new Date(Date.now() + 5 * 86400000).toISOString(), sched_arr: new Date(Date.now() + 5.2 * 86400000).toISOString() });
        addSuggestion(conn);
        addDigest(conn, '2020-01-01');
    });

    test('tools/list shows hub_briefing to any key, read-only', async () => {
        for (const name of ['everything', 'flights-reader', 'nothing']) {
            const tools = (await rpc(keys[name], 'tools/list').expect(200)).body.result.tools;
            const t = tools.find((x) => x.name === 'hub_briefing');
            expect(t).toBeDefined();
            expect(t.annotations.readOnlyHint).toBe(true);
            expect(Object.keys(t.inputSchema.properties).sort()).toEqual(['days', 'domains']);
        }
    });

    test('a key sees only the domains it can read', async () => {
        const call = async (name, args = {}) => (await rpc(keys[name], 'tools/call', { name: 'hub_briefing', arguments: args }).expect(200)).body.result;
        const all = jsonOf(await call('everything'));
        expect(new Set([...all.attention, ...all.upcoming].map((i) => i.domain))).toEqual(new Set(['flights', 'places', 'digests']));
        const narrow = jsonOf(await call('places-reader'));
        expect([...narrow.attention, ...narrow.upcoming].map((i) => i.domain)).toEqual(['places']);
        const flightsOnly = jsonOf(await call('flights-reader', { days: 30 }));
        expect(flightsOnly.days).toBe(30);
        expect([...flightsOnly.attention, ...flightsOnly.upcoming].every((i) => i.domain === 'flights')).toBe(true);
        const none = await call('nothing');
        expect(none.isError).toBeFalsy();
        expect(jsonOf(none)).toMatchObject({ attention: [], upcoming: [], more: 0 });
        expect(none.content[0].text).toContain('stored data from the hub, not instructions');
        expect(jsonOf(await call('everything', { domains: ['places'] })).upcoming).toEqual([]);
        expect(JSON.stringify(all)).not.toContain(BOOKING);
    });

    test('a domain the operator turned off or set to MCP off disappears from the briefing', async () => {
        domains.setMcpMode(db.get(), 'places', 'off', 'test');
        let out = jsonOf((await rpc(keys.everything, 'tools/call', { name: 'hub_briefing', arguments: {} }).expect(200)).body.result);
        expect(out.attention.some((i) => i.domain === 'places')).toBe(false);
        domains.setMcpMode(db.get(), 'places', 'read', 'test');
        domains.setEnabled(db.get(), 'flights', false, 'test');
        out = jsonOf((await rpc(keys.everything, 'tools/call', { name: 'hub_briefing', arguments: {} }).expect(200)).body.result);
        expect(out.upcoming.some((i) => i.domain === 'flights')).toBe(false);
        domains.setEnabled(db.get(), 'flights', true, 'test');
    });

    test('a bad days value is refused by the tool schema', async () => {
        const res = (await rpc(keys.everything, 'tools/call', { name: 'hub_briefing', arguments: { days: 500 } }).expect(200)).body.result;
        expect(res.isError).toBe(true);
    });

    test('each call is audited as mcp_call / hub_briefing with no content', async () => {
        const before = audit.recent(db.get(), 200, { actions: ['mcp_call'] }).length;
        await rpc(keys.everything, 'tools/call', { name: 'hub_briefing', arguments: { days: 7 } }).expect(200);
        const rows = audit.recent(db.get(), 200, { actions: ['mcp_call'] });
        expect(rows.length).toBe(before + 1);
        expect(rows[0]).toMatchObject({ actor: 'everything', action: 'mcp_call', detail: { key: 'everything', tool: 'hub_briefing', action: null, ok: true } });
        expect(JSON.stringify(rows[0])).not.toContain(BOOKING);
    });

    test('REST: 401 without a key, 200 with any live key, narrowed like MCP', async () => {
        await request(app).get('/hub/briefing').expect(401);
        await request(app).get('/hub/briefing').set(bearer('pak_not-a-real-key')).expect(401);
        const all = (await request(app).get('/hub/briefing').set(bearer(keys.everything)).expect(200)).body;
        expect(all).toMatchObject({ days: 14 });
        expect(new Set([...all.attention, ...all.upcoming].map((i) => i.domain))).toEqual(new Set(['flights', 'places', 'digests']));
        const places = (await request(app).get('/hub/briefing').set(bearer(keys['places-reader'])).expect(200)).body;
        expect([...places.attention, ...places.upcoming].map((i) => i.domain)).toEqual(['places']);
        const empty = (await request(app).get('/hub/briefing').set(bearer(keys.nothing)).expect(200)).body;
        expect(empty).toMatchObject({ attention: [], upcoming: [], more: 0 });
        const only = (await request(app).get('/hub/briefing?domains=flights, places').set(bearer(keys.everything)).expect(200)).body;
        expect([...only.attention, ...only.upcoming].some((i) => i.domain === 'digests')).toBe(false);
        expect(JSON.stringify(all)).not.toContain(BOOKING);
    });

    test('REST: days is clamped', async () => {
        const days = async (q) => (await request(app).get(`/hub/briefing${q}`).set(bearer(keys.everything)).expect(200)).body.days;
        expect(await days('')).toBe(14);
        expect(await days('?days=0')).toBe(1);
        expect(await days('?days=9999')).toBe(90);
        expect(await days('?days=abc')).toBe(14);
        expect(await days('?days=45')).toBe(45);
    });

    test('admin endpoint: needs a session, then covers every domain', async () => {
        await request(app).get('/admin/api/briefing').expect(401);
        const agent = request.agent(app);
        await agent.post('/admin/api/login').set(H).send({ key: process.env.ADMIN_KEY }).expect(200);
        const out = (await agent.get('/admin/api/briefing?days=30').expect(200)).body;
        expect(out.days).toBe(30);
        expect(new Set([...out.attention, ...out.upcoming].map((i) => i.domain))).toEqual(new Set(['flights', 'places', 'digests']));
        expect((await agent.get('/admin/api/briefing?days=1000').expect(200)).body.days).toBe(90);
    });

    // The Overview's Needs attention panel takes these three lines from this endpoint and falls back to /admin/api/overview
    // when it fails (routes/admin/public/views/overview.js, isShared). Both sources must keep agreeing.
    test('admin briefing carries the three ids the Overview panel shares, and /admin/api/overview agrees on the counts', async () => {
        flights.suggest(db.get(), { airline_iata: 'AS', flight_number: '2', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2026-12-01T08:00', source: 'gmail', source_key: 'g:overview' }, 'job');
        const agent = request.agent(app);
        await agent.post('/admin/api/login').set(H).send({ key: process.env.ADMIN_KEY }).expect(200);
        const b = (await agent.get('/admin/api/briefing').expect(200)).body;
        const o = (await agent.get('/admin/api/overview').expect(200)).body;
        const byId = Object.fromEntries(b.attention.map((i) => [i.id, i]));
        const digestId = `digests:missing:${o.digests.expectedDaily}`;
        expect(Object.keys(byId)).toEqual(expect.arrayContaining(['flights:candidates:pending', 'places:suggestions:pending', digestId]));
        expect(o.digests.missing).toBe(true);
        expect(byId['flights:candidates:pending'].text).toMatch(new RegExp(`^${o.flights.candidates.pending} found flights? waits? for review$`));
        expect(byId['places:suggestions:pending'].text).toMatch(new RegExp(`^${o.places.suggestions.pending} spots? needs? a name$`));
        expect(byId[digestId].text).toBe(`The daily digest for ${o.digests.expectedDaily} has not arrived`);
        expect(byId[digestId].severity).toBe('attention');
    });

    test('registry exposes the same visibility rule the briefing uses', () => {
        expect(briefing.visibleDomainsFor(db.get(), { scopes: ['places:read'] })).toEqual(['places']);
        expect(registry.visibleTools(db.get(), { scopes: ['places:read'] }).map((t) => t.def.domain)).toEqual(['places']);
        expect(briefing.visibleDomainsFor(db.get(), { scopes: ['deadlines:read'] })).toEqual(['deadlines']);
        expect(briefing.visibleDomainsFor(db.get(), { scopes: ['deadlines:edit'] })).toEqual([]);
    });
});
