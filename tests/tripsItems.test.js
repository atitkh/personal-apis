// Trip items: the service, /hub/trips/:id/items and the admin API. Every trip, item, place and reference here is invented.
const KEY = 'i'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const trips = require('../services/trips');
const items = require('../services/tripItems');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const REF = 'ITEMREF-77QX';
const NOTE = 'item canary note lanterns';
const PLACE = '12 Invented Harbour Road';
const conn = () => db.get();
let reader;
let writer;
let admin;

beforeAll(async () => {
    reader = apiKeys.create(conn(), { name: 'items-reader', scopes: 'trips:read' }).key;
    writer = apiKeys.create(conn(), { name: 'items-editor', scopes: 'trips:read, trips:api-write' }).key;
    admin = request.agent(app);
    await admin.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const as = (key) => ({
    get: (url) => request(app).get(url).set(auth(key)),
    post: (url, body) => request(app).post(url).set(auth(key)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(key)).send(body),
    delete: (url) => request(app).delete(url).set(auth(key)),
});
const newTrip = (extra = {}) => trips.create(conn(), { title: 'Harbour trip', destination: 'Hong Kong', start_date: '2099-11-12', end_date: '2099-11-20', ...extra }, 'test').id;
const code = (fn) => { try { fn(); return 'no error'; } catch (err) { return err.code; } };
const item = (extra = {}) => ({ kind: 'stay', title: 'Hotel', start_date: '2099-11-12', end_date: '2099-11-20', place: PLACE, notes: NOTE, reference: REF, ...extra });
const auditRows = (actions) => audit.recent(conn(), 50, { actions });

describe('service', () => {
    test('add, list in date then sort order, update, remove', () => {
        const t = newTrip();
        const a = items.add(conn(), t, item({ title: 'Late', start_date: '2099-11-15', sort: 0 }), 'test');
        expect(a).toMatchObject({ status: 'created', id: t, title: 'Late', item: { kind: 'stay', has_reference: true } });
        expect(a.item.reference).toBeUndefined();
        items.add(conn(), t, item({ title: 'Second', start_date: '2099-11-12', end_date: null, sort: 2 }), 'test');
        items.add(conn(), t, item({ title: 'First', start_date: '2099-11-12', end_date: null, sort: 1 }), 'test');
        items.add(conn(), t, { title: 'Someday' }, 'test');
        expect(items.list(conn(), t).items.map((i) => i.title)).toEqual(['First', 'Second', 'Late', 'Someday']);
        const got = trips.get(conn(), t);
        expect(got.item_count).toBe(4);
        expect(got.items.map((i) => i.title)).toEqual(['First', 'Second', 'Late', 'Someday']);
        expect(got.items.every((i) => i.reference === undefined)).toBe(true);
        expect(trips.get(conn(), t, { reference: true }).items.find((i) => i.title === 'Late').reference).toBe(REF);
        expect(items.list(conn(), t, { reference: true }).items[2].reference).toBe(REF);
        expect(trips.list(conn()).trips.find((x) => x.id === t).item_count).toBe(4);

        const u = items.update(conn(), t, a.item_id, { place: null, kind: 'booking' }, 'test');
        expect(u).toMatchObject({ status: 'updated', fields: ['kind', 'place'], item: { place: null, kind: 'booking' } });
        expect(items.update(conn(), t, a.item_id, { kind: 'booking' }, 'test').status).toBe('unchanged');
        expect(items.remove(conn(), t, a.item_id)).toMatchObject({ status: 'removed', id: t, item_id: a.item_id, title: 'Late' });
        expect(items.list(conn(), t).items).toHaveLength(3);
    });

    test('validation: real dates, end not before start, kinds, title, unknown fields, sort', () => {
        const t = newTrip();
        expect(code(() => items.add(conn(), t, item({ start_date: '2099-02-30' }), 't'))).toBe('bad_date');
        expect(code(() => items.add(conn(), t, item({ start_date: '2099-13-01' }), 't'))).toBe('bad_date');
        expect(code(() => items.add(conn(), t, item({ start_date: '2099-11-20', end_date: '2099-11-19' }), 't'))).toBe('bad_date');
        expect(code(() => items.add(conn(), t, item({ kind: 'flight' }), 't'))).toBe('bad_kind');
        expect(code(() => items.add(conn(), t, item({ title: '  ' }), 't'))).toBe('bad_request');
        expect(code(() => items.add(conn(), t, item({ price: 3 }), 't'))).toBe('bad_field');
        expect(code(() => items.add(conn(), t, item({ sort: -1 }), 't'))).toBe('bad_sort');
        expect(code(() => items.add(conn(), t, item({ reference: 'x'.repeat(121) }), 't'))).toBe('bad_request');
        expect(code(() => items.add(conn(), 999, item(), 't'))).toBe('no_trip');
        const a = items.add(conn(), t, item(), 't').item_id;
        expect(code(() => items.update(conn(), t, a, { title: null }, 't'))).toBe('bad_request');
        expect(code(() => items.update(conn(), t, a, {}, 't'))).toBe('bad_request');
        // An item of another trip is not found under this trip.
        const other = newTrip();
        expect(code(() => items.update(conn(), other, a, { title: 'x' }, 't'))).toBe('no_item');
        expect(code(() => items.remove(conn(), other, a))).toBe('no_item');
    });

    test('items outside the trip dates are allowed (no warning, no refusal)', () => {
        const t = newTrip();
        expect(items.add(conn(), t, item({ start_date: '2099-11-11', end_date: '2099-12-01' }), 't').status).toBe('created');
    });

    test('errors never echo the submitted reference', () => {
        const t = newTrip();
        try { items.add(conn(), t, item({ reference: `${REF}${'y'.repeat(130)}` }), 't'); } catch (err) { expect(err.message).not.toContain(REF); }
    });

    test('items go with their trip', () => {
        const t = newTrip();
        items.add(conn(), t, item(), 't');
        trips.remove(conn(), t, { confirm: true });
        expect(conn().prepare('SELECT COUNT(*) AS n FROM trip_items WHERE trip_id = ?').get(t).n).toBe(0);
    });
});

describe('/hub/trips/:id/items', () => {
    test('read lists without references unless include_reference=true; read cannot write', async () => {
        const t = newTrip();
        items.add(conn(), t, item(), 't');
        const list = (await as(reader).get(`/hub/trips/${t}/items`).expect(200)).body;
        expect(list.items[0]).toMatchObject({ title: 'Hotel', has_reference: true });
        expect(JSON.stringify(list)).not.toContain(REF);
        expect(JSON.stringify((await as(reader).get(`/hub/trips/${t}`).expect(200)).body)).not.toContain(REF);
        expect((await as(reader).get(`/hub/trips/${t}/items?include_reference=true`).expect(200)).body.items[0].reference).toBe(REF);
        expect((await as(reader).get(`/hub/trips/${t}?include_reference=true`).expect(200)).body.items[0].reference).toBe(REF);
        await as(reader).post(`/hub/trips/${t}/items`, item()).expect(403);
        await as(reader).patch(`/hub/trips/${t}/items/1`, { title: 'x' }).expect(403);
        await as(reader).post(`/hub/trips/${t}/items/1/remove`, {}).expect(403);
    });

    test('api-write adds, changes and removes (a POST); answers and audit rows carry no reference, place or notes', async () => {
        const t = newTrip();
        const added = (await as(writer).post(`/hub/trips/${t}/items`, item()).expect(201)).body;
        expect(added).toMatchObject({ status: 'created', id: t, title: 'Hotel' });
        expect(JSON.stringify(added)).not.toContain(REF);
        await as(writer).post(`/hub/trips/${t}/items`, item({ start_date: 'soon' })).expect(400);
        const changed = (await as(writer).patch(`/hub/trips/${t}/items/${added.item_id}`, { reference: `${REF}-2`, title: 'Hotel two' }).expect(200)).body;
        expect(changed.fields).toEqual(['title', 'reference']);
        await as(writer).patch(`/hub/trips/${t}/items/9999`, { title: 'x' }).expect(404);
        await as(writer).post(`/hub/trips/${t}/items/${added.item_id}/remove`, {}).expect(200);
        await as(writer).post(`/hub/trips/${t}/items/${added.item_id}/remove`, {}).expect(404);
        await as(writer).delete(`/hub/trips/${t}/items/${added.item_id}`).expect(404); // no DELETE under /hub
        const rows = auditRows(['trip_item_added', 'trip_item_updated', 'trip_item_removed']).filter((r) => r.detail.id === t);
        expect(rows.map((r) => r.action).sort()).toEqual(['trip_item_added', 'trip_item_removed', 'trip_item_updated']);
        expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['items-editor']));
        const text = JSON.stringify(rows);
        for (const secret of [REF, PLACE, NOTE]) expect(text).not.toContain(secret);
        expect(rows.find((r) => r.action === 'trip_item_added').detail).toMatchObject({ id: t, item_id: added.item_id, title: 'Hotel' });
    });
});

describe('admin items', () => {
    test('CRUD with references visible to the admin, DELETE removes, audited as admin without content', async () => {
        const t = newTrip();
        await request(app).get(`/admin/api/trips/${t}/items`).expect(401);
        await admin.post(`/admin/api/trips/${t}/items`).send(item()).expect(403); // no X-Requested-With
        const added = (await admin.post(`/admin/api/trips/${t}/items`).set(H).send(item()).expect(201)).body;
        expect((await admin.get(`/admin/api/trips/${t}/items`).expect(200)).body.items[0].reference).toBe(REF);
        expect((await admin.get(`/admin/api/trips/${t}`).expect(200)).body.items[0].reference).toBe(REF);
        await admin.patch(`/admin/api/trips/${t}/items/${added.item_id}`).set(H).send({ notes: `${NOTE} more` }).expect(200);
        await admin.delete(`/admin/api/trips/${t}/items/${added.item_id}`).set(H).expect(200);
        await admin.delete(`/admin/api/trips/${t}/items/${added.item_id}`).set(H).expect(404);
        const rows = auditRows(['trip_item_added', 'trip_item_updated', 'trip_item_removed']).filter((r) => r.detail.id === t);
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['admin']));
        for (const secret of [REF, PLACE, NOTE]) expect(JSON.stringify(rows)).not.toContain(secret);
    });
});
