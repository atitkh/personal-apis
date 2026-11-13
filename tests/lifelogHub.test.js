process.env.HUB_DB_FILE = ':memory:';

// /hub/lifelog and the sensitive-scope rule. Every observation and episode in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const audit = require('../services/audit');
const app = require('../app');

const TEXT = 'secret caption about the sofa';
const keys = {};
beforeAll(() => {
    const conn = db.get();
    const make = (name, scopes) => { keys[name] = apiKeys.create(conn, { name, scopes }).key; };
    make('cam-desk', 'lifelog:push');
    make('reader', 'lifelog:read');
    make('writer', 'lifelog:read, lifelog:api-write');
    make('blind-writer', 'lifelog:api-write');
    make('star', '*');
    make('all-lifelog', 'lifelog:*');
});
afterAll(() => db.close());
afterEach(() => domains.setEnabled(db.get(), 'lifelog', true, 'test'));

const auth = (key) => ({ Authorization: `Bearer ${keys[key]}` });
const as = (key) => ({
    get: (url) => request(app).get(url).set(auth(key)),
    post: (url, body) => request(app).post(url).set(auth(key)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(key)).send(body),
});
const obs = (extra = {}) => ({ at: '2026-11-13T18:00:00Z', text: TEXT, kind: 'sit', ...extra });
const episode = (extra = {}) => ({ kind: 'sit', title: 'Sofa time', start_at: '2026-11-13T18:00:00Z', detail: 'private detail words', ...extra });

describe('scopes', () => {
    test('hasScope: "*" does not grant lifelog, lifelog:* and named scopes do, "*" still grants everything else', () => {
        expect(apiKeys.hasScope(['*'], 'lifelog:read')).toBe(false);
        expect(apiKeys.hasScope(['*'], 'lifelog:push')).toBe(false);
        expect(apiKeys.hasScope(['*'], 'trips:api-write')).toBe(true);
        expect(apiKeys.hasScope(['*'], 'digests:edit')).toBe(true);
        expect(apiKeys.hasScope(['lifelog:*'], 'lifelog:api-write')).toBe(true);
        expect(apiKeys.hasScope(['*', 'lifelog:read'], 'lifelog:read')).toBe(true);
    });

    test('a push key can push and nothing else; a read key can read and not push', async () => {
        const r = (await as('cam-desk').post('/hub/lifelog/observations', { observations: [obs({ dedupe: 'p1' })] }).expect(201)).body;
        expect(r).toMatchObject({ accepted: 1, duplicates: 0, rejected: [] });
        await as('cam-desk').get('/hub/lifelog/observations').expect(403);
        await as('cam-desk').post('/hub/lifelog/episodes', episode()).expect(403);
        await as('reader').post('/hub/lifelog/observations', [obs()]).expect(403);
        const list = (await as('reader').get('/hub/lifelog/observations').expect(200)).body;
        expect(list.observations[0]).toMatchObject({ source: 'cam-desk', text: TEXT });
        await as('reader').post('/hub/lifelog/episodes', episode()).expect(403);
        await as('blind-writer').post('/hub/lifelog/episodes', episode()).expect(403);
    });

    test('a push key cannot push under another source; api-write may', async () => {
        const r = (await as('cam-desk').post('/hub/lifelog/observations', [obs({ source: 'glasses' })]).expect(200)).body;
        expect(r).toMatchObject({ accepted: 0, rejected: [{ index: 0, code: 'bad_source' }] });
        expect((await as('writer').post('/hub/lifelog/observations', [obs({ source: 'glasses' })]).expect(201)).body.accepted).toBe(1);
    });

    test('a "*" key is refused on lifelog but still works elsewhere; lifelog:* works', async () => {
        await as('star').get('/hub/lifelog/observations').expect(403);
        await as('star').post('/hub/lifelog/observations', [obs()]).expect(403);
        await as('star').get('/hub/lifelog/day/2026-11-13').expect(403);
        await as('star').get('/hub/trips').expect(200);
        await as('star').get('/hub/deadlines').expect(200);
        await as('all-lifelog').get('/hub/lifelog/day/2026-11-13').expect(200);
        expect((await as('all-lifelog').post('/hub/lifelog/observations', [obs()]).expect(201)).body.accepted).toBe(1);
    });

    test('the domain switched off answers 503', async () => {
        domains.setEnabled(db.get(), 'lifelog', false, 'test');
        await as('reader').get('/hub/lifelog/observations').expect(503);
        await as('cam-desk').post('/hub/lifelog/observations', [obs()]).expect(503);
    });
});

describe('routes', () => {
    test('episodes: create, read, patch, history, restore, link and unlink', async () => {
        const [oid] = (await as('writer').post('/hub/lifelog/observations', [obs({ text: 'link me' })]).expect(201)).body.ids;
        const c = (await as('writer').post('/hub/lifelog/episodes', episode()).expect(201)).body;
        await as('writer').patch(`/hub/lifelog/episodes/${c.id}`, { title: 'Sofa, longer' }).expect(200);
        expect((await as('reader').get(`/hub/lifelog/episodes/${c.id}/history`).expect(200)).body.revisions).toHaveLength(2);
        await as('writer').post(`/hub/lifelog/episodes/${c.id}/restore`, { rev: 1 }).expect(200);
        expect((await as('writer').post(`/hub/lifelog/episodes/${c.id}/observations`, { observation_ids: [oid] }).expect(200)).body.linked).toBe(1);
        expect((await as('reader').get(`/hub/lifelog/episodes/${c.id}`).expect(200)).body).toMatchObject({ title: 'Sofa time', observation_count: 1 });
        await as('writer').post(`/hub/lifelog/episodes/${c.id}/observations/unlink`, { observation_ids: [oid] }).expect(200);
        expect((await as('reader').get('/hub/lifelog/episodes?local_date=2026-11-13').expect(200)).body.total).toBeGreaterThan(0);
        expect((await as('reader').get('/hub/lifelog/day/2026-11-13').expect(200)).body.episodes.length).toBeGreaterThan(0);
        await as('reader').get('/hub/lifelog/episodes/999999').expect(404);
        await as('reader').get('/hub/lifelog/day/nope').expect(400);
    });

    test('no DELETE and no forget over /hub', async () => {
        await request(app).delete('/hub/lifelog/observations').set(auth('all-lifelog')).send({ from: '2026-01-01', to: '2027-01-01', confirm: true }).expect(404);
        await as('all-lifelog').get('/hub/lifelog/forget-preview?from=2026-01-01&to=2027-01-01').expect(404);
    });

    test('batch and body limits: 101 items is a 413, a full batch fits, a body over 1 MB is a 413 in plain words', async () => {
        const many = Array.from({ length: 101 }, () => obs());
        expect((await as('cam-desk').post('/hub/lifelog/observations', many).expect(413)).body.error).toBe('too_many');
        const full = Array.from({ length: 100 }, () => obs({ text: 'y'.repeat(2000), data: { pad: 'z'.repeat(2000) } }));
        expect((await as('cam-desk').post('/hub/lifelog/observations', full).expect(201)).body.accepted).toBe(100);
        const huge = Array.from({ length: 100 }, () => obs({ text: 'y'.repeat(11000) }));
        const r = (await as('cam-desk').post('/hub/lifelog/observations', huge).expect(413)).body;
        expect(r).toMatchObject({ error: 'too_large' });
        expect(r.message).toMatch(/1 MB/);
    });

    test('audit: one row per batch with counts and sources, never the text', async () => {
        await as('cam-desk').post('/hub/lifelog/observations', [obs({ text: 'unique audit words' }), obs({ text: '' })]).expect(201);
        const row = audit.recent(db.get(), 1, { actions: ['lifelog_pushed'] })[0];
        expect(row.detail).toMatchObject({ sources: ['cam-desk'], accepted: 1, rejected: 1 });
        const all = JSON.stringify(audit.recent(db.get(), 200));
        expect(all).not.toMatch(/unique audit words|secret caption|private detail|Sofa/);
    });
});
