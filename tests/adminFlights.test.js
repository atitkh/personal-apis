// The dashboard's found-flights API: accepting and dismissing candidates is for a person only.
// Every flight and booking reference in this file is invented.
const KEY = 'c'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const domains = require('../services/domains');
const flights = require('../services/flights');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const REF = 'MV3TQ8';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
afterEach(() => domains.setEnabled(db.get(), 'flights', true, 'test'));

const file = (n, extra = {}) => flights.suggest(db.get(), {
    airline_iata: 'AS', flight_number: String(n), origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: `2030-07-${String(10 + (n % 20)).padStart(2, '0')}T08:00`,
    source: 'gmail', source_key: `g:${n}`, booking_ref: REF, ...extra,
}, 'flights-job').candidate;

describe('admin flights: access', () => {
    test('needs a session for reads and the X-Requested-With header for changes', async () => {
        const c = file(1);
        await request(app).get('/admin/api/flights/candidates').expect(401);
        await request(app).post(`/admin/api/flights/candidates/${c.id}/accept`).set(H).send({}).expect(401);
        await agent.post(`/admin/api/flights/candidates/${c.id}/accept`).send({}).expect(403);
        await agent.post(`/admin/api/flights/candidates/${c.id}/dismiss`).send({}).expect(403);
        expect(flights.listCandidates(db.get())[0].status).toBe('pending');
    });
});

describe('admin flights: the queue', () => {
    test('list with counts (the dashboard sees the booking reference); bad status is 400', async () => {
        const r = (await agent.get('/admin/api/flights/candidates').expect(200)).body;
        expect(r.counts).toEqual({ pending: 1, accepted: 0, dismissed: 0 });
        expect(r.candidates[0]).toMatchObject({ flight_number: '1', booking_ref: REF, status: 'pending' });
        expect((await agent.get('/admin/api/flights/candidates?status=bogus').expect(400)).body.code).toBe('bad_status');
    });

    test('accept with overrides creates the flight; again is 409; audited without the booking reference', async () => {
        const c = flights.listCandidates(db.get())[0];
        const r = (await agent.post(`/admin/api/flights/candidates/${c.id}/accept`).set(H).send({ seat: '12F' }).expect(200)).body;
        expect(r).toMatchObject({ status: 'accepted', candidate: { status: 'accepted', decided_by: 'admin' }, flight: { status: 'created', rev: 1 } });
        expect(flights.get(db.get(), r.flight.id)).toMatchObject({ seat: '12F', booking_ref: REF, source: 'gmail', updated_by: 'admin' });
        const again = (await agent.post(`/admin/api/flights/candidates/${c.id}/accept`).set(H).send({}).expect(409)).body;
        expect(again).toMatchObject({ code: 'already_accepted', id: r.flight.id });
        await agent.post('/admin/api/flights/candidates/99999/accept').set(H).send({}).expect(404);
        await agent.post(`/admin/api/flights/candidates/${c.id}/dismiss`).set(H).send({}).expect(409);
        const row = audit.recent(db.get(), 50).find((e) => e.action === 'flight_candidate_accepted');
        expect(row.detail).toEqual({ id: c.id, flight: 'AS 1 SEA-PDX 2030-07-11', flight_id: r.flight.id, rev: 1 });
    });

    test('a candidate that is already a flight answers 409 duplicate with the flight id', async () => {
        const c = file(2);
        const made = flights.create(db.get(), { airline_iata: 'AS', flight_number: '2', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2030-07-12T08:00' }, 'person');
        const r = (await agent.post(`/admin/api/flights/candidates/${c.id}/accept`).set(H).send({}).expect(409)).body;
        expect(r).toMatchObject({ code: 'duplicate', id: made.id });
    });

    test('accept-all: each id on its own, one audit row per accepted flight', async () => {
        const a = file(3).id;
        const b = file(4).id;
        const dup = flights.listCandidates(db.get()).find((x) => x.flight_number === '2').id;
        const before = audit.recent(db.get(), 500).filter((e) => e.action === 'flight_candidate_accepted').length;
        const r = (await agent.post('/admin/api/flights/candidates/accept-all').set(H).send({ ids: [a, dup, 424242, b] }).expect(200)).body;
        expect(r).toMatchObject({ accepted: 2, failed: 2 });
        expect(r.results.map((x) => x.error || x.status)).toEqual(['accepted', 'duplicate', 'not_found', 'accepted']);
        const after = audit.recent(db.get(), 500).filter((e) => e.action === 'flight_candidate_accepted').length;
        expect(after - before).toBe(2);
        expect((await agent.post('/admin/api/flights/candidates/accept-all').set(H).send({}).expect(400)).body.code).toBe('bad_request');
    });

    test('dismiss once (audited), again unchanged; works while the domain is off', async () => {
        const c = file(5);
        domains.setEnabled(db.get(), 'flights', false, 'test');
        expect((await agent.post(`/admin/api/flights/candidates/${c.id}/dismiss`).set(H).send({}).expect(200)).body.status).toBe('dismissed');
        expect((await agent.post(`/admin/api/flights/candidates/${c.id}/dismiss`).set(H).send({}).expect(200)).body.status).toBe('unchanged');
        const rows = audit.recent(db.get(), 50).filter((e) => e.action === 'flight_candidate_dismissed');
        expect(rows.length).toBe(1);
        expect(rows[0].detail).toEqual({ id: c.id, flight: 'AS 5 SEA-PDX 2030-07-15' });
        expect(JSON.stringify(audit.recent(db.get(), 500))).not.toContain(REF);
    });

    test('the overview carries counts only', async () => {
        file(6);
        const o = (await agent.get('/admin/api/overview').expect(200)).body;
        expect(o.flights).toEqual({ candidates: { pending: 2, accepted: 3, dismissed: 1 } });
    });

    test('the activity filter flights includes the candidate actions', async () => {
        const r = (await agent.get('/admin/api/activity?type=flights').expect(200)).body;
        const actions = new Set((r.events || r.entries || r.rows || []).map((e) => e.action));
        expect(actions.has('flight_candidate_accepted')).toBe(true);
        expect(actions.has('flight_candidate_dismissed')).toBe(true);
    });

    test('Agent access lists the flights tool and its actions', async () => {
        const r = (await agent.get('/admin/api/agents').expect(200)).body;
        const t = JSON.stringify(r);
        for (const a of ['list', 'get', 'upcoming', 'stats', 'trips', 'candidates', 'suggest', 'add', 'edit']) expect(t).toContain(`"${a}"`);
        expect(t).toContain('"flights"');
    });
});

describe('admin flights: a candidate with flight_status', () => {
    test('shows in the queue and accepting makes the flight cancelled; an override can change it', async () => {
        const c = file(901, { flight_status: 'cancelled' });
        expect(c.flight_status).toBe('cancelled');
        const queue = (await agent.get('/admin/api/flights/candidates').expect(200)).body.candidates;
        expect(queue.find((x) => x.id === c.id)).toMatchObject({ flight_status: 'cancelled' });
        const r = (await agent.post(`/admin/api/flights/candidates/${c.id}/accept`).set(H).send({}).expect(200)).body;
        expect(flights.get(db.get(), r.flight.id)).toMatchObject({ status: 'cancelled', status_override: 'cancelled' });
        const d = file(902, { flight_status: 'cancelled' });
        const r2 = (await agent.post(`/admin/api/flights/candidates/${d.id}/accept`).set(H).send({ status: 'auto' }).expect(200)).body;
        expect(flights.get(db.get(), r2.flight.id)).toMatchObject({ status: 'scheduled', status_override: null });
    });
});
