process.env.HUB_DB_FILE = ':memory:';

// Every address, street and coordinate in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const audit = require('../services/audit');
const app = require('../app');

let reader;
let writer;
let suggester;
let other;

beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'places-reader', scopes: 'places:read' }).key;
    writer = apiKeys.create(conn, { name: 'places-editor', scopes: 'places:read, places:write' }).key;
    suggester = apiKeys.create(conn, { name: 'nightly', scopes: 'places:read, places:suggest' }).key;
    other = apiKeys.create(conn, { name: 'digest-only', scopes: 'digests:read, digests:write' }).key;
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const as = (key) => ({
    get: (url) => request(app).get(url).set(auth(key)),
    post: (url, body) => request(app).post(url).set(auth(key)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(key)).send(body),
    del: (url) => request(app).delete(url).set(auth(key)),
});

describe('access', () => {
    test('needs a key', async () => {
        await request(app).get('/hub/places').expect(401);
        await request(app).post('/hub/places').send({ label: 'x' }).expect(401);
        await request(app).post('/hub/places/resolve').send({ zone: 'home' }).expect(401);
    });

    test('a key for another domain gets nothing', async () => {
        await as(other).get('/hub/places').expect(403);
        await as(other).post('/hub/places/resolve', { zone: 'home' }).expect(403);
        await as(other).post('/hub/places', { label: 'x' }).expect(403);
    });

    test('a read key can read and resolve but not change anything', async () => {
        const id = (await as(writer).post('/hub/places', { label: 'Guarded', rules: [{ type: 'zone', value: 'guarded' }] }).expect(201)).body.id;
        const ruleId = (await as(reader).get(`/hub/places/${id}`).expect(200)).body.rules[0].id;

        await as(reader).get('/hub/places').expect(200);
        await as(reader).get(`/hub/places/${id}/history`).expect(200);
        await as(reader).get('/hub/places/suggestions').expect(200);
        await as(reader).post('/hub/places/resolve', { zone: 'guarded' }).expect(200);

        await as(reader).post('/hub/places', { label: 'Nope' }).expect(403);
        await as(reader).patch(`/hub/places/${id}`, { label: 'Nope' }).expect(403);
        await as(reader).post(`/hub/places/${id}/restore`, { rev: 1 }).expect(403);
        await as(reader).del(`/hub/places/${id}`).expect(403);
        await as(reader).post(`/hub/places/${id}/rules`, { type: 'zone', value: 'nope' }).expect(403);
        await as(reader).patch(`/hub/places/${id}/rules/${ruleId}`, { priority: 3 }).expect(403);
        await as(reader).del(`/hub/places/${id}/rules/${ruleId}`).expect(403);

        expect((await as(reader).get(`/hub/places/${id}`).expect(200)).body).toMatchObject({ label: 'Guarded', rev: 1 });
        await as(writer).del(`/hub/places/${id}`).expect(200);
    });
});

describe('places over HTTP', () => {
    let id;

    test('create, read, list', async () => {
        const made = await as(writer).post('/hub/places', {
            label: 'Home', kind: 'home', notes: 'The flat.', rules: [{ type: 'street', value: 'Maple Ridge Dr' }],
        }).expect(201);
        expect(made.body).toEqual({ status: 'created', id: expect.any(Number), label: 'Home', rev: 1 });
        id = made.body.id;

        const one = (await as(reader).get(`/hub/places/${id}`).expect(200)).body;
        expect(one).toMatchObject({ id, label: 'Home', kind: 'home', notes: 'The flat.', rev: 1, revisions: 1, updated_by: 'places-editor' });
        expect(one.rules).toEqual([expect.objectContaining({ type: 'street', value: 'Maple Ridge Dr', exclude: false })]);

        const list = (await as(reader).get('/hub/places').expect(200)).body.places;
        expect(list.map((p) => p.label)).toEqual(['Home']);
        expect((await as(reader).get('/hub/places?kind=store').expect(200)).body.places).toEqual([]);
        expect((await as(reader).get('/hub/places').expect(200)).headers['cache-control']).toBe('no-store');
    });

    test('edit, rules, history and restore', async () => {
        expect((await as(writer).patch(`/hub/places/${id}`, { notes: 'The flat, second floor.' }).expect(200)).body).toEqual({ status: 'updated', id, label: 'Home', rev: 2 });
        expect((await as(writer).patch(`/hub/places/${id}`, { notes: 'The flat, second floor.' }).expect(200)).body.status).toBe('unchanged');

        const added = (await as(writer).post(`/hub/places/${id}/rules`, { type: 'radius', lat: 40, lon: -75, radius_m: 90 }).expect(201)).body;
        expect(added).toEqual({ status: 'updated', id, label: 'Home', rev: 3, rule_id: expect.any(Number), rule_type: 'radius' });
        expect((await as(writer).patch(`/hub/places/${id}/rules/${added.rule_id}`, { radius_m: 150 }).expect(200)).body.rev).toBe(4);
        expect((await as(writer).del(`/hub/places/${id}/rules/${added.rule_id}`).expect(200)).body.rev).toBe(5);

        const hist = (await as(reader).get(`/hub/places/${id}/history`).expect(200)).body.revisions;
        expect(hist.map((h) => [h.rev, h.source])).toEqual([[5, 'rule'], [4, 'rule'], [3, 'rule'], [2, 'edit'], [1, 'create']]);

        expect((await as(reader).get(`/hub/places/${id}?rev=4`).expect(200)).body.rules).toHaveLength(2);
        expect((await as(writer).post(`/hub/places/${id}/restore`, { rev: 4 }).expect(200)).body).toEqual({ status: 'updated', id, label: 'Home', rev: 6 });
        const now = (await as(reader).get(`/hub/places/${id}`).expect(200)).body;
        expect(now.rules.map((r) => [r.id, r.type, r.radius_m])).toEqual([[expect.any(Number), 'street', null], [added.rule_id, 'radius', 150]]);
    });

    test('resolve', async () => {
        const byStreet = (await as(reader).post('/hub/places/resolve', { geocode: '410 maple ridge dr, Springfield, AR' }).expect(200)).body;
        expect(byStreet).toMatchObject({ match: { id, label: 'Home', kind: 'home' }, matched_rule: { type: 'street' }, confidence: 'street' });

        const byPoint = (await as(reader).post('/hub/places/resolve', { geocode: '410 maple ridge dr', lat: 40.0005, lon: -75 }).expect(200)).body;
        expect(byPoint).toMatchObject({ match: { id }, matched_rule: { type: 'radius', distance_m: 56 }, confidence: 'exact' });

        expect((await as(reader).post('/hub/places/resolve', { geocode: '77 Juniper Hollow' }).expect(200)).body).toEqual({ match: null });
        expect((await as(reader).post('/hub/places/resolve', {}).expect(400)).body.error).toBe('bad_query');
        // Addresses go in the body, not the URL.
        await as(reader).get('/hub/places/resolve?geocode=410%20Maple%20Ridge%20Dr').expect(404);
    });

    test('suggest needs its own scope (or write)', async () => {
        const refused = await as(reader).post('/hub/places/resolve', { geocode: '77 Juniper Hollow, Springfield', suggest: true }).expect(403);
        expect(refused.body.message).toMatch(/places:suggest/);
        expect((await as(reader).get('/hub/places/suggestions').expect(200)).body.suggestions).toEqual([]);

        const filed = (await as(suggester).post('/hub/places/resolve', { geocode: '77 Juniper Hollow, Springfield', suggest: true }).expect(200)).body;
        expect(filed).toMatchObject({ match: null, suggestion: { street: 'Juniper Hollow', count: 1, status: 'pending' } });
        expect((await as(writer).post('/hub/places/resolve', { geocode: '79 Juniper Hollow, Springfield', suggest: true }).expect(200)).body.suggestion.count).toBe(2);

        const queue = (await as(reader).get('/hub/places/suggestions').expect(200)).body.suggestions;
        expect(queue).toEqual([expect.objectContaining({ street: 'Juniper Hollow', count: 2, status: 'pending' })]);
        expect((await as(reader).get('/hub/places/suggestions?status=dismissed').expect(200)).body.suggestions).toEqual([]);
        await as(reader).get('/hub/places/suggestions?status=lost').expect(400);

        // The suggest key still cannot change places.
        await as(suggester).post('/hub/places', { label: 'Nope' }).expect(403);
    });

    test('bad input gets a clear 4xx', async () => {
        expect((await as(writer).post('/hub/places', { label: 'home' }).expect(409)).body.error).toBe('label_taken');
        expect((await as(writer).post('/hub/places', {}).expect(400)).body.error).toBe('bad_label');
        expect((await as(writer).post('/hub/places', { label: 'X', kind: 'castle' }).expect(400)).body.error).toBe('bad_kind');
        expect((await as(writer).post(`/hub/places/${id}/rules`, { type: 'street', value: 'x' }).expect(400)).body.error).toBe('bad_rule');
        expect((await as(writer).post(`/hub/places/${id}/rules`, { type: 'street', value: 'MAPLE RIDGE DR' }).expect(409)).body.error).toBe('duplicate_rule');
        expect((await as(writer).patch(`/hub/places/${id}`, {}).expect(400)).body.error).toBe('bad_request');
        expect((await as(writer).post(`/hub/places/${id}/restore`, { rev: 99 }).expect(404)).body.error).toBe('no_revision');
        expect((await as(reader).get('/hub/places/9999').expect(404)).body.error).toBe('not_found');
        expect((await as(reader).get('/hub/places/abc').expect(404)).body.error).toBe('not_found');
        expect((await as(writer).del(`/hub/places/${id}/rules/9999`).expect(404)).body.error).toBe('no_rule');
        expect((await as(reader).get(`/hub/places/${id}/nope`).expect(404)).body.error).toBe('not_found');
    });

    test('changes are audited with ids and labels, never with rule values or addresses', async () => {
        const temp = (await as(writer).post('/hub/places', { label: 'Passing', rules: [{ type: 'street', value: 'Tannery Row' }] }).expect(201)).body.id;
        await as(writer).del(`/hub/places/${temp}`).expect(200);

        const rows = audit.recent(db.get(), 200).filter((r) => r.action.startsWith('place_'));
        expect(new Set(rows.map((r) => r.action))).toEqual(new Set([
            'place_created', 'place_updated', 'place_restored', 'place_deleted', 'place_rule_added', 'place_rule_updated', 'place_rule_removed',
        ]));
        expect(rows.find((r) => r.action === 'place_created' && r.detail.label === 'Home')).toMatchObject({ actor: 'places-editor', detail: { id, label: 'Home', rev: 1 } });
        expect(rows.find((r) => r.action === 'place_rule_added').detail).toEqual({ id, label: 'Home', rev: 3, rule_id: expect.any(Number), rule_type: 'radius' });
        expect(rows.find((r) => r.action === 'place_deleted' && r.detail.label === 'Passing').detail).toEqual({ id: temp, label: 'Passing', rev: 1 });
        // The no-op edit and the reads (resolve, suggestions) left nothing behind.
        expect(rows.filter((r) => r.action === 'place_updated')).toHaveLength(1);

        const everything = JSON.stringify(audit.recent(db.get(), 200));
        expect(everything).not.toMatch(/maple|ridge|tannery|juniper|hollow|springfield|flat|-75|radius_m|"value"|"lat"|"notes"/i);
    });
});

describe('suggestions over HTTP', () => {
    const fileIt = async (geocode) => (await as(suggester).post('/hub/places/resolve', { geocode, suggest: true }).expect(200)).body.suggestion;

    test('the queue filters by status and reports counts for every status', async () => {
        await fileIt('3 Quillfeather Lane, Springfield');
        const all = (await as(reader).get('/hub/places/suggestions?status=all').expect(200)).body;
        expect(all.status).toBe('all');
        expect(all.counts).toEqual({ pending: expect.any(Number), accepted: expect.any(Number), dismissed: expect.any(Number) });
        expect(all.suggestions.length).toBe(all.counts.pending + all.counts.accepted + all.counts.dismissed);
        const pending = (await as(reader).get('/hub/places/suggestions').expect(200)).body;
        expect(pending.status).toBe('pending');
        expect(pending.suggestions.every((s) => s.status === 'pending')).toBe(true);
        expect(pending.suggestions.length).toBe(all.counts.pending);
    });

    test('accept and dismiss need places:write', async () => {
        const s = await fileIt('9 Brambleworth Close');
        for (const key of [reader, suggester, other]) {
            await as(key).post(`/hub/places/suggestions/${s.id}/accept`, { label: 'Nope' }).expect(403);
            await as(key).post(`/hub/places/suggestions/${s.id}/dismiss`, {}).expect(403);
        }
        const still = (await as(reader).get('/hub/places/suggestions').expect(200)).body.suggestions.find((x) => x.id === s.id);
        expect(still.status).toBe('pending');
    });

    test('accept as a new place, accept onto an existing place, dismiss; all audited without the street', async () => {
        const a = await fileIt('9 Brambleworth Close');
        const made = (await as(writer).post(`/hub/places/suggestions/${a.id}/accept`, { label: 'Pottery class', kind: 'other', notes: 'Wednesdays.' }).expect(200)).body;
        expect(made).toMatchObject({ status: 'accepted', suggestion: { id: a.id, status: 'accepted', resolved_place_id: made.place.id }, place: { status: 'created', label: 'Pottery class' } });
        expect((await as(reader).post('/hub/places/resolve', { geocode: '11 Brambleworth Close' }).expect(200)).body.match.label).toBe('Pottery class');
        await as(writer).post(`/hub/places/suggestions/${a.id}/accept`, { label: 'Again' }).expect(409);

        const b = await fileIt('3 Quillfeather Lane');
        const attached = (await as(writer).post(`/hub/places/suggestions/${b.id}/accept`, { place_id: made.place.id }).expect(200)).body;
        expect(attached.place).toMatchObject({ status: 'updated', id: made.place.id, rev: 2, rule_type: 'street' });

        const c = await fileIt('40 Wrenfold Mews');
        expect((await as(writer).post(`/hub/places/suggestions/${c.id}/dismiss`, {}).expect(200)).body.status).toBe('dismissed');
        expect((await as(writer).post(`/hub/places/suggestions/${c.id}/dismiss`, {}).expect(200)).body.status).toBe('unchanged');
        expect(await fileIt('42 Wrenfold Mews')).toMatchObject({ id: c.id, status: 'dismissed', count: 2 });
        await as(writer).post('/hub/places/suggestions/99999/dismiss', {}).expect(404);
        expect((await as(writer).post(`/hub/places/suggestions/${c.id}/accept`, {}).expect(400)).body.error).toBe('bad_request');

        const rows = audit.recent(db.get(), 200).filter((r) => r.action.startsWith('place_suggestion_'));
        expect(rows.map((r) => r.action).sort()).toEqual(['place_suggestion_accepted', 'place_suggestion_accepted', 'place_suggestion_dismissed']);
        expect(rows.find((r) => r.detail.suggestion_id === a.id)).toMatchObject({ actor: 'places-editor', detail: { status: 'accepted', label: 'Pottery class', created: true } });
        expect(JSON.stringify(audit.recent(db.get(), 300))).not.toMatch(/brambleworth|quillfeather|wrenfold|wednesdays/i);
    });
});

describe('domain switch', () => {
    afterEach(() => domains.setEnabled(db.get(), 'places', true, 'test'));

    test('a switched-off places domain answers 503 to valid keys, reads and writes, but keeps its data', async () => {
        const before = (await as(reader).get('/hub/places').expect(200)).body.places.map((p) => p.label);
        domains.setEnabled(db.get(), 'places', false, 'test');
        expect((await as(reader).get('/hub/places').expect(503)).body.error).toBe('domain_disabled');
        await as(reader).post('/hub/places/resolve', { zone: 'home' }).expect(503);
        await as(writer).post('/hub/places', { label: 'While off' }).expect(503);
        await as(writer).del('/hub/places/1').expect(503);
        await request(app).get('/hub/places').expect(401); // authentication is still checked first
        await as(other).get('/hub/digests').expect(200);   // other domains are untouched

        domains.setEnabled(db.get(), 'places', true, 'test');
        const list = (await as(reader).get('/hub/places').expect(200)).body.places;
        expect(list.map((p) => p.label)).toEqual(before);
        expect(before).toContain('Home');
    });
});
