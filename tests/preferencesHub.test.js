process.env.HUB_DB_FILE = ':memory:';

// Every preference in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const audit = require('../services/audit');
const app = require('../app');

let reader;
let writer;
let writeOnly;
let other;

beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'prefs-reader', scopes: 'preferences:read' }).key;
    writer = apiKeys.create(conn, { name: 'prefs-editor', scopes: 'preferences:read, preferences:api-write' }).key;
    writeOnly = apiKeys.create(conn, { name: 'prefs-blind', scopes: 'preferences:api-write' }).key;
    other = apiKeys.create(conn, { name: 'deadlines-only', scopes: 'deadlines:read, deadlines:api-write' }).key;
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const as = (key) => ({
    get: (url) => request(app).get(url).set(auth(key)),
    post: (url, body) => request(app).post(url).set(auth(key)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(key)).send(body),
    delete: (url) => request(app).delete(url).set(auth(key)),
});
const VALUE = 'quiet row far from the engines';
const NOTE = 'private reasoning text';
const item = (extra = {}) => ({ area: 'travel', key: 'airline_seat', value: VALUE, notes: NOTE, ...extra });

describe('access', () => {
    test('needs a key', async () => {
        await request(app).get('/hub/preferences').expect(401);
        await request(app).post('/hub/preferences').send(item()).expect(401);
    });

    test('a key for another domain gets 403 everywhere', async () => {
        await as(other).get('/hub/preferences').expect(403);
        await as(other).get('/hub/preferences/1').expect(403);
        await as(other).get('/hub/preferences/1/history').expect(403);
        await as(other).post('/hub/preferences', item()).expect(403);
    });

    test('read cannot write; write alone cannot create (the answer needs read)', async () => {
        await as(reader).post('/hub/preferences', item()).expect(403);
        await as(reader).patch('/hub/preferences/1', { value: 'x' }).expect(403);
        await as(reader).post('/hub/preferences/1/unset').expect(403);
        await as(reader).post('/hub/preferences/1/restore', {}).expect(403);
        await as(writeOnly).post('/hub/preferences', item()).expect(403);
        await as(writeOnly).get('/hub/preferences').expect(403);
    });
});

describe('REST', () => {
    test('create, list, get, patch, history', async () => {
        const made = await as(writer).post('/hub/preferences', item()).expect(201);
        expect(made.body).toEqual({ status: 'created', id: 1, area: 'travel', key: 'airline_seat', rev: 1 });
        await as(writer).post('/hub/preferences', item({ area: 'communication', key: 'call_hours', value: 'No calls before 10 am' })).expect(201);
        const list = (await as(reader).get('/hub/preferences').expect(200)).body;
        expect(list.preferences.map((p) => p.key)).toEqual(['airline_seat', 'call_hours']);
        expect((await as(reader).get('/hub/preferences?area=communication').expect(200)).body.total).toBe(1);
        expect((await as(reader).get('/hub/preferences?q=engines').expect(200)).body.total).toBe(1);
        expect((await as(reader).get('/hub/preferences?area=pets').expect(400)).body.error).toBe('bad_area');
        expect((await as(reader).get('/hub/preferences/1').expect(200)).body).toMatchObject({ value: VALUE, revisions: 1 });
        await as(writer).patch('/hub/preferences/1', { value: 'window' }).expect(200);
        const h = (await as(reader).get('/hub/preferences/1/history').expect(200)).body.revisions;
        expect(h.map((r) => r.rev)).toEqual([2, 1]);
        expect((await as(reader).get('/hub/preferences/1?rev=1').expect(200)).body.value).toBe(VALUE);
        await as(reader).get('/hub/preferences/99').expect(404);
    });

    test('errors: duplicate 409, secret-looking 400 with the field, unknown field', async () => {
        const dup = await as(writer).post('/hub/preferences', item()).expect(409);
        expect(dup.body).toMatchObject({ error: 'exists', id: 1 });
        const secret = await as(writer).post('/hub/preferences', item({ key: 'wifi', value: 'pak_abc123' })).expect(400);
        expect(secret.body).toMatchObject({ error: 'secret_like', field: 'value' });
        expect(secret.body.message).toContain('Keep passwords, numbers and keys in the vault, not here.');
        expect((await as(writer).post('/hub/preferences', item({ key: 'wifi_password' })).expect(400)).body.field).toBe('key');
        await as(writer).post('/hub/preferences', item({ key: 'x', colour: 'red' })).expect(400);
    });

    test('there is no DELETE; unset hides, restore brings back', async () => {
        await as(writer).delete('/hub/preferences/1').expect(404);
        expect((await as(writer).post('/hub/preferences/1/unset').expect(200)).body).toMatchObject({ status: 'unset', id: 1 });
        expect((await as(reader).get('/hub/preferences').expect(200)).body.preferences.map((p) => p.key)).toEqual(['call_hours']);
        expect((await as(reader).get('/hub/preferences?removed=true').expect(200)).body.preferences.map((p) => p.key)).toEqual(['airline_seat']);
        const back = (await as(writer).post('/hub/preferences/1/restore', {}).expect(200)).body;
        expect(back).toMatchObject({ status: 'updated', id: 1 });
        expect((await as(reader).get('/hub/preferences').expect(200)).body.total).toBe(2);
        const old = (await as(writer).post('/hub/preferences/1/restore', { rev: 1 }).expect(200)).body;
        expect(old.fields).toEqual(['value']);
        await as(writer).post('/hub/preferences/1/restore', { rev: 77 }).expect(404);
    });
});

describe('audit', () => {
    test('rows hold id, area and key, never the value or the notes', async () => {
        await as(writer).post('/hub/preferences', item({ key: 'meal', area: 'food', value: 'the vegetarian plate', notes: NOTE })).expect(201);
        await as(writer).patch('/hub/preferences/3', { value: 'the vegan plate' }).expect(200);
        await as(writer).post('/hub/preferences/3/unset').expect(200);
        await as(writer).post('/hub/preferences/3/restore', { rev: 1 }).expect(200);
        const rows = audit.recent(db.get(), 300).filter((r) => r.action.startsWith('preference_'));
        expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['preference_set', 'preference_updated', 'preference_unset', 'preference_restored']));
        for (const r of rows) {
            expect(Object.keys(r.detail).sort()).toEqual(['area', 'id', 'key', 'key_id']);
            expect(r.actor).toBe('prefs-editor');
        }
        const text = JSON.stringify(rows);
        for (const secret of [VALUE, NOTE, 'vegetarian', 'vegan']) expect(text).not.toContain(secret);
    });

    test('an unchanged patch or a refused write leaves no audit row', async () => {
        const before = audit.recent(db.get(), 300).length;
        await as(writer).patch('/hub/preferences/1', { value: (await as(reader).get('/hub/preferences/1')).body.value }).expect(200);
        await as(writer).post('/hub/preferences', item({ key: 'bad', value: 'sk-123' })).expect(400);
        expect(audit.recent(db.get(), 300).length).toBe(before);
    });
});

describe('domain switch', () => {
    afterEach(() => domains.setEnabled(db.get(), 'preferences', true, 'test'));

    test('a switched-off domain answers 503 to valid keys but keeps its data', async () => {
        domains.setEnabled(db.get(), 'preferences', false, 'test');
        expect((await as(reader).get('/hub/preferences').expect(503)).body.error).toBe('domain_disabled');
        await as(reader).get('/hub/preferences/1').expect(503);
        await as(reader).get('/hub/preferences/1/history').expect(503);
        await as(writer).post('/hub/preferences', item({ key: 'z' })).expect(503);
        await as(writer).post('/hub/preferences/1/unset').expect(503);
        domains.setEnabled(db.get(), 'preferences', true, 'test');
        expect((await as(reader).get('/hub/preferences').expect(200)).body.total).toBe(3);
    });
});
