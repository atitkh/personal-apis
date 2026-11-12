// The dashboard's places API (read side for the Places view, plus the changes it makes as `admin`).
// Every address, street and coordinate in this file is invented.
const KEY = 'b'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const domains = require('../services/domains');
const places = require('../services/places');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
afterEach(() => domains.setEnabled(db.get(), 'places', true, 'test'));

const file = (geocode) => places.resolve(db.get(), { geocode, suggest: true }).suggestion;

describe('admin places: access', () => {
    test('needs a session for reads and the X-Requested-With header for changes', async () => {
        await request(app).get('/admin/api/places').expect(401);
        await request(app).get('/admin/api/places/suggestions').expect(401);
        await request(app).post('/admin/api/places/resolve').set(H).send({ zone: 'home' }).expect(401);
        await agent.post('/admin/api/places').send({ label: 'No header' }).expect(403);
        await agent.post('/admin/api/places/resolve').send({ zone: 'home' }).expect(403);
        expect(places.list(db.get())).toEqual([]);
    });
});

describe('admin places: places and rules', () => {
    let id;

    test('create, list with rule and revision counts, get with history', async () => {
        const made = (await agent.post('/admin/api/places').set(H).send({ label: 'Home', kind: 'home', notes: 'The flat.', rules: [{ type: 'street', value: 'Maple Ridge Dr' }] }).expect(201)).body;
        id = made.id;
        expect(made).toEqual({ status: 'created', id, label: 'Home', rev: 1 });
        await agent.post(`/admin/api/places/${id}/rules`).set(H).send({ type: 'zone', value: 'home' }).expect(201);

        const list = (await agent.get('/admin/api/places').expect(200)).body;
        expect(list.kinds).toContain('home');
        expect(list.suggestions).toEqual({ pending: 0, accepted: 0, dismissed: 0 });
        expect(list.places).toEqual([expect.objectContaining({ id, label: 'Home', ruleCount: 2, revisions: 2, lastChange: { at: expect.any(String), by: 'admin' } })]);
        expect((await agent.get('/admin/api/places?kind=store').expect(200)).body.places).toEqual([]);

        const one = (await agent.get(`/admin/api/places/${id}`).expect(200)).body;
        expect(one).toMatchObject({ id, label: 'Home', rev: 2, revisions: 2 });
        expect(one.rules.map((r) => r.type)).toEqual(['street', 'zone']);
        expect(one.history.map((h) => [h.rev, h.source, h.actor])).toEqual([[2, 'rule', 'admin'], [1, 'create', 'admin']]);
        expect((await agent.get(`/admin/api/places/${id}?rev=1`).expect(200)).body.rules).toHaveLength(1);
    });

    test('edit, rule edit and remove, restore, delete', async () => {
        const ruleId = (await agent.get(`/admin/api/places/${id}`).expect(200)).body.rules[1].id;
        expect((await agent.patch(`/admin/api/places/${id}`).set(H).send({ notes: 'Second floor.' }).expect(200)).body).toMatchObject({ status: 'updated', rev: 3 });
        expect((await agent.patch(`/admin/api/places/${id}`).set(H).send({ notes: 'Second floor.' }).expect(200)).body.status).toBe('unchanged');
        expect((await agent.patch(`/admin/api/places/${id}/rules/${ruleId}`).set(H).send({ priority: 4 }).expect(200)).body).toMatchObject({ rev: 4, rule_type: 'zone' });
        expect((await agent.delete(`/admin/api/places/${id}/rules/${ruleId}`).set(H).expect(200)).body.rev).toBe(5);
        const restored = (await agent.post(`/admin/api/places/${id}/restore`).set(H).send({ rev: 2 }).expect(200)).body;
        expect(restored).toMatchObject({ status: 'updated', rev: 6 });
        const now = (await agent.get(`/admin/api/places/${id}`).expect(200)).body;
        expect(now).toMatchObject({ notes: 'The flat.', rules: [expect.objectContaining({ type: 'street' }), expect.objectContaining({ id: ruleId, type: 'zone' })] });

        const temp = (await agent.post('/admin/api/places').set(H).send({ label: 'Passing' }).expect(201)).body.id;
        await agent.delete(`/admin/api/places/${temp}`).set(H).expect(400);
        expect((await agent.delete(`/admin/api/places/${temp}`).set(H).send({ confirm: true }).expect(200)).body.status).toBe('deleted');
        await agent.get(`/admin/api/places/${temp}`).expect(404);
    });

    test('errors come back as { error, code } with the service status', async () => {
        expect((await agent.post('/admin/api/places').set(H).send({ label: 'home' }).expect(409)).body).toMatchObject({ code: 'label_taken', error: expect.any(String) });
        expect((await agent.post('/admin/api/places').set(H).send({}).expect(400)).body.code).toBe('bad_label');
        expect((await agent.post(`/admin/api/places/${id}/rules`).set(H).send({ type: 'street', value: 'x' }).expect(400)).body.code).toBe('bad_rule');
        expect((await agent.post(`/admin/api/places/${id}/restore`).set(H).send({ rev: 99 }).expect(404)).body.code).toBe('no_revision');
        expect((await agent.get('/admin/api/places/99999').expect(404)).body.code).toBe('not_found');
        expect((await agent.get('/admin/api/places?kind=castle').expect(400)).body.code).toBe('bad_kind');
    });

    test('the dashboard still works while the places domain is switched off', async () => {
        domains.setEnabled(db.get(), 'places', false, 'test');
        await agent.get('/admin/api/places').expect(200);
        await agent.patch(`/admin/api/places/${id}`).set(H).send({ kind: 'family' }).expect(200);
        await agent.patch(`/admin/api/places/${id}`).set(H).send({ kind: 'home' }).expect(200);
    });
});

describe('admin places: resolve box and suggestions', () => {
    test('resolve answers like the hub but never files a suggestion, even when asked to', async () => {
        const hit = (await agent.post('/admin/api/places/resolve').set(H).send({ geocode: '410 Maple Ridge Dr, Springfield' }).expect(200)).body;
        expect(hit).toMatchObject({ match: { label: 'Home' }, confidence: 'street', matched_rule: { type: 'street' } });
        const miss = (await agent.post('/admin/api/places/resolve').set(H).send({ geocode: '9 Brambleworth Close', suggest: true }).expect(200)).body;
        expect(miss).toEqual({ match: null });
        expect(places.suggestionCounts(db.get())).toEqual({ pending: 0, accepted: 0, dismissed: 0 });
        expect((await agent.post('/admin/api/places/resolve').set(H).send({}).expect(400)).body.code).toBe('bad_query');
    });

    test('the queue, accept as new, accept onto a place, dismiss', async () => {
        const a = file('9 Brambleworth Close');
        const b = file('3 Quillfeather Lane');
        const c = file('40 Wrenfold Mews');
        const q = (await agent.get('/admin/api/places/suggestions').expect(200)).body;
        expect(q).toMatchObject({ status: 'pending', counts: { pending: 3, accepted: 0, dismissed: 0 } });
        expect(q.suggestions.map((s) => s.id).sort()).toEqual([a.id, b.id, c.id].sort());

        const made = (await agent.post(`/admin/api/places/suggestions/${a.id}/accept`).set(H).send({ label: 'Pottery class', kind: 'other' }).expect(200)).body;
        expect(made).toMatchObject({ status: 'accepted', suggestion: { status: 'accepted', decided_by: 'admin' }, place: { status: 'created', label: 'Pottery class' } });
        const home = places.list(db.get()).find((p) => p.label === 'Home').id;
        expect((await agent.post(`/admin/api/places/suggestions/${b.id}/accept`).set(H).send({ place_id: home }).expect(200)).body.place).toMatchObject({ id: home, rule_type: 'street' });
        expect((await agent.post(`/admin/api/places/suggestions/${c.id}/dismiss`).set(H).send({}).expect(200)).body.status).toBe('dismissed');
        expect((await agent.post(`/admin/api/places/suggestions/${a.id}/accept`).set(H).send({ label: 'Twice' }).expect(409)).body.code).toBe('already_accepted');
        await agent.post('/admin/api/places/suggestions/99999/dismiss').set(H).send({}).expect(404);
        await agent.post(`/admin/api/places/suggestions/${c.id}/dismiss`).expect(403);

        expect((await agent.get('/admin/api/places/suggestions?status=all').expect(200)).body.counts).toEqual({ pending: 0, accepted: 2, dismissed: 1 });
        expect((await agent.get('/admin/api/places/suggestions?status=dismissed').expect(200)).body.suggestions.map((s) => s.id)).toEqual([c.id]);
        await agent.get('/admin/api/places/suggestions?status=lost').expect(400);
        expect(places.history(db.get(), made.place.id)[0]).toMatchObject({ source: 'suggestion', actor: 'admin' });
    });

    test('every change is audited as admin with ids and labels only, and shows under the places filter', async () => {
        const rows = audit.recent(db.get(), 300).filter((r) => r.action.startsWith('place_'));
        expect(rows.every((r) => r.actor === 'admin')).toBe(true);
        expect(new Set(rows.map((r) => r.action))).toEqual(new Set([
            'place_created', 'place_updated', 'place_restored', 'place_deleted', 'place_rule_added', 'place_rule_updated', 'place_rule_removed',
            'place_suggestion_accepted', 'place_suggestion_dismissed',
        ]));
        const filtered = (await agent.get('/admin/api/activity?type=places&limit=199').expect(200)).body.events;
        expect(filtered.length).toBe(rows.length);
        expect(JSON.stringify(audit.recent(db.get(), 500))).not.toMatch(/maple|ridge|springfield|brambleworth|quillfeather|wrenfold|flat|second floor/i);
    });
});

describe('admin places: overview', () => {
    test('the overview carries the suggestion counts (for the attention list) and never a street', async () => {
        const before = (await agent.get('/admin/api/overview').expect(200)).body;
        file('77 Thistledown Lane, Invented Town');
        const after = (await agent.get('/admin/api/overview').expect(200)).body;
        expect(after.places.suggestions.pending).toBe(before.places.suggestions.pending + 1);
        expect(Object.keys(after.places.suggestions).sort()).toEqual(['accepted', 'dismissed', 'pending']);
        expect(JSON.stringify(after.places)).not.toMatch(/thistledown/i);
        expect(after.domains.map((d) => d.name)).toContain('places');
    });
});
