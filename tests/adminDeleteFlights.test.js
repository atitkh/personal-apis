// Permanent delete for flights, trips and found flights: admin session only, confirm required, cascades, audit without values.
// Every flight and booking reference in this file is invented.
const KEY = 'e'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const flights = require('../services/flights');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const REF = 'ZZ9PLURAL';
const conn = () => db.get();
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const n = (sql, ...a) => conn().prepare(sql).get(...a).n;
const flight = (num, extra = {}) => flights.create(conn(), {
    airline_iata: 'AA', flight_number: String(num), origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: '2031-03-04T15:00:00Z',
    booking_ref: REF, ...extra,
}, 'test');
const observe = (id) => conn().prepare("INSERT INTO flight_observations (flight_id, source, fetched_at, ok, fields, actor) VALUES (?, 'aerodatabox', '2031-03-04T00:00:00Z', 1, '{}', 'test')").run(id);
const lastAudit = (action) => audit.recent(conn(), 5, { actions: [action] })[0];
const del = (path, body) => agent.delete(`/admin/api/${path}`).set(H).send(body);

describe('delete flights', () => {
    test('cascades revisions and observations; the audit row has label and counts only', async () => {
        const f = flight(500);
        flights.update(conn(), f.id, { seat: '12C' }, 'test');
        observe(f.id); observe(f.id);
        const pre = (await agent.get(`/admin/api/flights/${f.id}/delete-preview`).expect(200)).body;
        expect(pre).toMatchObject({ id: f.id, label: 'AA 500 DFW-LIT 2031-03-04', counts: { revisions: 2, observations: 2, candidates: 0 } });
        const r = (await del(`flights/${f.id}`, { confirm: true }).expect(200)).body;
        expect(r).toMatchObject({ status: 'deleted', id: f.id, backup: null });
        expect(n('SELECT COUNT(*) AS n FROM flights WHERE id = ?', f.id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM flight_revisions WHERE flight_id = ?', f.id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM flight_observations WHERE flight_id = ?', f.id)).toBe(0);
        const row = lastAudit('flight_deleted');
        expect(row.actor).toBe('admin');
        expect(row.detail).toMatchObject({ id: f.id, flight: 'AA 500 DFW-LIT 2031-03-04', revisions: 2, observations: 2 });
        expect(JSON.stringify(row)).not.toContain(REF);
        expect(JSON.stringify(row)).not.toContain('12C');
    });

    test('needs a session, the header, confirm: true, and an existing flight', async () => {
        const f = flight(501);
        await request(app).delete(`/admin/api/flights/${f.id}`).set(H).send({ confirm: true }).expect(401);
        await agent.delete(`/admin/api/flights/${f.id}`).send({ confirm: true }).expect(403);
        expect((await del(`flights/${f.id}`, {}).expect(400)).body.code).toBe('confirm_required');
        await del(`flights/${f.id}`, { confirm: 'yes' }).expect(400);
        await del(`flights/${f.id}`).expect(400);
        await del('flights/99999', { confirm: true }).expect(404);
        expect(n('SELECT COUNT(*) AS n FROM flights WHERE id = ?', f.id)).toBe(1);
    });

    test('a flight with an accepted candidate: forget_candidate (default) deletes it, so a re-scan can file the flight again', async () => {
        const c = flights.suggest(conn(), { airline_iata: 'AS', flight_number: '77', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2031-05-05T08:00', source: 'gmail', source_key: 'g:77' }, 'job').candidate;
        const acc = flights.acceptCandidate(conn(), c.id, null, 'admin');
        expect(flights.suggest(conn(), { airline_iata: 'AS', flight_number: '77', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2031-05-05T08:00', source: 'gmail', source_key: 'g:77' }, 'job').status).toBe('exists');
        const r = (await del(`flights/${acc.flight.id}`, { confirm: true }).expect(200)).body;
        expect(r.counts.candidates).toBe(1);
        expect(n('SELECT COUNT(*) AS n FROM flight_candidates WHERE id = ?', c.id)).toBe(0);
        expect(n("SELECT COUNT(*) AS n FROM flights WHERE source_key = 'g:77'")).toBe(0);
        expect(flights.suggest(conn(), { airline_iata: 'AS', flight_number: '77', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2031-05-05T08:00', source: 'gmail', source_key: 'g:77' }, 'job').status).toBe('filed');
        expect(lastAudit('flight_deleted').detail).toMatchObject({ candidates: 1, forget_candidate: true });
    });

    test('forget_candidate: false keeps the candidate with accepted_flight_id set to NULL', async () => {
        const c = flights.suggest(conn(), { airline_iata: 'AS', flight_number: '78', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2031-05-06T08:00', source: 'gmail', source_key: 'g:78' }, 'job').candidate;
        const acc = flights.acceptCandidate(conn(), c.id, null, 'admin');
        await del(`flights/${acc.flight.id}`, { confirm: true, forget_candidate: false }).expect(200);
        const row = conn().prepare('SELECT status, accepted_flight_id FROM flight_candidates WHERE id = ?').get(c.id);
        expect(row).toEqual({ status: 'accepted', accepted_flight_id: null });
        expect(flights.suggest(conn(), { airline_iata: 'AS', flight_number: '78', origin_iata: 'SEA', dest_iata: 'PDX', sched_dep: '2031-05-06T08:00', source: 'gmail', source_key: 'g:78' }, 'job').status).toBe('already_suggested');
    });

    test('works while the flights domain is switched off', async () => {
        const domains = require('../services/domains');
        const f = flight(502);
        domains.setEnabled(conn(), 'flights', false, 'test');
        try { await del(`flights/${f.id}`, { confirm: true }).expect(200); } finally { domains.setEnabled(conn(), 'flights', true, 'test'); }
    });
});

describe('delete trips', () => {
    test('refuses with 409 and the count while flights use it; unassign frees them and clears deadlines', async () => {
        const t = flights.createTrip(conn(), { title: 'Spring trip' }, 'test');
        const a = flight(510, { trip_id: t.id });
        flight(511, { trip_id: t.id });
        conn().prepare("INSERT INTO deadlines (title, kind, due_date, trip_id, created_at, updated_at, updated_by) VALUES ('Visa', 'document', '2031-02-01', ?, 'x', 'x', 'test')").run(t.id);
        const pre = (await agent.get(`/admin/api/flights/trips/${t.id}/delete-preview`).expect(200)).body;
        expect(pre).toMatchObject({ label: 'Spring trip', counts: { flights: 2, deadlines: 1 } });
        const r = await del(`flights/trips/${t.id}`, { confirm: true }).expect(409);
        expect(r.body).toMatchObject({ code: 'trip_in_use', flights: 2 });
        expect(r.body.error).toMatch(/2 flights/);
        expect(n('SELECT COUNT(*) AS n FROM trips WHERE id = ?', t.id)).toBe(1);
        await del(`flights/trips/${t.id}`, { unassign: true }).expect(400);
        await del(`flights/trips/${t.id}`, { confirm: true, unassign: true }).expect(200);
        expect(n('SELECT COUNT(*) AS n FROM trips WHERE id = ?', t.id)).toBe(0);
        expect(conn().prepare('SELECT trip_id FROM flights WHERE id = ?').get(a.id).trip_id).toBeNull();
        expect(n('SELECT COUNT(*) AS n FROM deadlines WHERE trip_id IS NOT NULL')).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM flights WHERE id = ?', a.id)).toBe(1);
        expect(lastAudit('trip_deleted').detail).toMatchObject({ trip: 'Spring trip', flights: 2, deadlines: 1, unassigned: true });
    });

    test('an empty trip deletes without unassign; unknown trip is 404', async () => {
        const t = flights.createTrip(conn(), { title: 'Empty' }, 'test');
        await del(`flights/trips/${t.id}`, { confirm: true }).expect(200);
        await del(`flights/trips/${t.id}`, { confirm: true }).expect(404);
    });
});

describe('delete found flights', () => {
    const file = (k, extra = {}) => flights.suggest(conn(), { airline_iata: 'UA', flight_number: String(k), origin_iata: 'ORD', dest_iata: 'LIT', sched_dep: '2031-06-06T08:00', source: 'gmail', source_key: `g:${k}`, booking_ref: REF, ...extra }, 'job').candidate;

    test('deletes a candidate of any status and audits id, label and status only', async () => {
        const p = file(600), d = file(601, { sched_dep: '2031-06-07T08:00' });
        flights.dismissCandidate(conn(), d.id, 'admin');
        await del(`flights/candidates/${p.id}`, { confirm: true }).expect(200);
        await del(`flights/candidates/${d.id}`, {}).expect(400);
        await del(`flights/candidates/${d.id}`, { confirm: true }).expect(200);
        await del(`flights/candidates/${d.id}`, { confirm: true }).expect(404);
        const row = lastAudit('flight_candidate_deleted');
        expect(row.detail).toMatchObject({ id: d.id, status: 'dismissed' });
        expect(JSON.stringify(row)).not.toContain(REF);
    });

    test('deleting an accepted candidate leaves its flight', async () => {
        const c = file(602, { sched_dep: '2031-06-08T08:00' });
        const acc = flights.acceptCandidate(conn(), c.id, null, 'admin');
        await del(`flights/candidates/${c.id}`, { confirm: true }).expect(200);
        expect(n('SELECT COUNT(*) AS n FROM flights WHERE id = ?', acc.flight.id)).toBe(1);
    });

    test('delete all dismissed removes only dismissed ones and says how many', async () => {
        const ids = [610, 611, 612].map((k) => file(k, { sched_dep: `2031-07-${k - 600}T08:00` }).id);
        flights.dismissCandidate(conn(), ids[0], 'admin');
        flights.dismissCandidate(conn(), ids[1], 'admin');
        const before = flights.candidateCounts(conn());
        await del('flights/candidates/dismissed', {}).expect(400);
        const r = (await del('flights/candidates/dismissed', { confirm: true }).expect(200)).body;
        expect(r.count).toBe(before.dismissed);
        expect(flights.candidateCounts(conn()).dismissed).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM flight_candidates WHERE id = ?', ids[2])).toBe(1);
        expect(lastAudit('flight_candidate_deleted').detail).toEqual({ count: before.dismissed, status: 'dismissed' });
    });
});

describe('delete with a backup', () => {
    test('backup: true on an in-memory hub is skipped; a failed backup aborts the delete', async () => {
        const backup = require('../services/backup');
        const f = flight(520);
        const spy = jest.spyOn(backup, 'snapshotBeforeDelete').mockRejectedValueOnce(new Error('disk full'));
        const r = await del(`flights/${f.id}`, { confirm: true, backup: true }).expect(500);
        expect(r.body.error).toMatch(/nothing was deleted.*disk full/);
        expect(n('SELECT COUNT(*) AS n FROM flights WHERE id = ?', f.id)).toBe(1);
        spy.mockResolvedValueOnce('hub-pre-delete-20310101-000000.db');
        const ok = (await del(`flights/${f.id}`, { confirm: true, backup: true }).expect(200)).body;
        expect(ok.backup).toBe('hub-pre-delete-20310101-000000.db');
        expect(lastAudit('flight_deleted').detail.backup).toBe('hub-pre-delete-20310101-000000.db');
        spy.mockRestore();
    });
});

describe('activity for deletes', () => {
    test('the new actions are under the Flights filter', async () => {
        const out = (await agent.get('/admin/api/activity?type=flights').expect(200)).body.events.map((e) => e.action);
        expect(out).toEqual(expect.arrayContaining(['flight_deleted', 'trip_deleted', 'flight_candidate_deleted']));
    });
});
