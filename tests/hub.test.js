process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const app = require('../app');

let reader;
let writer;
let other;

beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'agent', scopes: 'digests:read' }).key;
    writer = apiKeys.create(conn, { name: 'digest-job', scopes: 'digests:read, digests:api-write' }).key;
    other = apiKeys.create(conn, { name: 'flights', scopes: 'flights:read' }).key;
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });

describe('access', () => {
    test('needs a key', async () => {
        await request(app).get('/hub/digests').expect(401);
        await request(app).put('/hub/digests/daily/2026-11-08').send({ body: 'x' }).expect(401);
    });

    test('needs the right scope', async () => {
        await request(app).get('/hub/digests').set(auth(other)).expect(403);
        await request(app).put('/hub/digests/daily/2026-11-08').set(auth(reader)).send({ body: 'x' }).expect(403);
        await request(app).patch('/hub/digests/daily/2026-11-08').set(auth(reader)).send({ body: 'x' }).expect(403);
        await request(app).get('/hub/digests').set(auth(reader)).expect(200);
    });

    test('is not advertised in /api', async () => {
        const res = await request(app).get('/api').expect(200);
        expect(JSON.stringify(res.body)).not.toMatch(/\/hub|\/admin|digest/i);
    });

    test('unknown hub routes are a JSON 404', async () => {
        const res = await request(app).get('/hub/nope').set(auth(reader)).expect(404);
        expect(res.body.error).toBe('not_found');
    });
});

describe('digests over HTTP', () => {
    test('PUT creates (201), repeats (200 unchanged) and updates (200)', async () => {
        const created = await request(app).put('/hub/digests/daily/2026-11-08').set(auth(writer))
            .send({ body: '# 2026-11-08\n\nWorked on the hub.', model: 'bonsai2', meta: { sources: { ha: 'ok', calendar: 'failed' } } }).expect(201);
        expect(created.body).toEqual({ status: 'created', rev: 1 });

        const again = await request(app).put('/hub/digests/daily/2026-11-08').set(auth(writer)).send({ body: 'Worked on the hub.' }).expect(200);
        expect(again.body.status).toBe('unchanged');

        const updated = await request(app).put('/hub/digests/daily/2026-11-08').set(auth(writer)).send({ body: 'Worked on the hub and the digest.' }).expect(200);
        expect(updated.body).toEqual({ status: 'updated', rev: 2 });
    });

    test('GET returns the text, other revisions and the history', async () => {
        const res = await request(app).get('/hub/digests/daily/2026-11-08').set(auth(reader)).expect(200);
        expect(res.body).toMatchObject({ kind: 'daily', period: '2026-11-08', rev: 2, actor: 'digest-job', model: null });

        const first = await request(app).get('/hub/digests/daily/2026-11-08?rev=1').set(auth(reader)).expect(200);
        expect(first.body).toMatchObject({ rev: 1, body: 'Worked on the hub.', model: 'bonsai2', meta: { sources: { ha: 'ok', calendar: 'failed' } } });

        const hist = await request(app).get('/hub/digests/daily/2026-11-08/revisions').set(auth(reader)).expect(200);
        expect(hist.body.revisions.map((r) => r.rev)).toEqual([2, 1]);
    });

    test('list, latest, recent and search', async () => {
        await request(app).put('/hub/digests/daily/2026-11-07').set(auth(writer)).send({ body: 'Quiet day with a seminar.' }).expect(201);
        await request(app).put('/hub/digests/weekly/2026-W45').set(auth(writer)).send({ body: 'A week of hub work.' }).expect(201);

        const list = await request(app).get('/hub/digests?kind=daily').set(auth(reader)).expect(200);
        expect(list.body.digests.map((d) => d.period)).toEqual(['2026-11-08', '2026-11-07']);
        expect(list.body.digests[0]).not.toHaveProperty('body');

        expect((await request(app).get('/hub/digests/daily/latest').set(auth(reader)).expect(200)).body.period).toBe('2026-11-08');
        expect((await request(app).get('/hub/digests/weekly/latest').set(auth(reader)).expect(200)).body.period).toBe('2026-W45');

        const recent = await request(app).get('/hub/digests/recent?kind=daily&days=2').set(auth(reader)).expect(200);
        expect(recent.body.digests.map((d) => d.period)).toEqual(['2026-11-08', '2026-11-07']);
        expect(recent.body.digests[1].body).toMatch(/seminar/);

        const found = await request(app).get('/hub/digests/search?q=seminar').set(auth(reader)).expect(200);
        expect(found.body.results).toEqual([expect.objectContaining({ kind: 'daily', period: '2026-11-07' })]);
        await request(app).get('/hub/digests/search?q=').set(auth(reader)).expect(400);
    });

    test('an edit protects against reruns, force overrides, restore brings a revision back', async () => {
        await request(app).patch('/hub/digests/daily/2026-11-07').set(auth(writer)).send({ body: 'I corrected this.', note: 'wrong' }).expect(200);

        const blocked = await request(app).put('/hub/digests/daily/2026-11-07').set(auth(writer)).send({ body: 'generated again' }).expect(409);
        expect(blocked.body.error).toBe('edited');

        await request(app).put('/hub/digests/daily/2026-11-07').set(auth(writer)).send({ body: 'forced text', force: true }).expect(200);
        const restored = await request(app).post('/hub/digests/daily/2026-11-07/restore').set(auth(writer)).send({ rev: 1 }).expect(200);
        expect(restored.body.status).toBe('updated');
        expect((await request(app).get('/hub/digests/daily/2026-11-07').set(auth(reader))).body.body).toBe('Quiet day with a seminar.');
    });

    test('bad input gets a clear 4xx', async () => {
        const put = (p, b) => request(app).put(p).set(auth(writer)).send(b);
        expect((await put('/hub/digests/yearly/2026', { body: 'x' }).expect(400)).body.error).toBe('bad_kind');
        expect((await put('/hub/digests/daily/yesterday', { body: 'x' }).expect(400)).body.error).toBe('bad_period');
        expect((await put('/hub/digests/daily/2026-11-09', {}).expect(400)).body.error).toBe('bad_body');
        await request(app).get('/hub/digests/daily/2020-01-01').set(auth(reader)).expect(404);
        await request(app).patch('/hub/digests/daily/2020-01-01').set(auth(writer)).send({ body: 'x' }).expect(404);
    });
});

describe('domain switches', () => {
    afterEach(() => {
        domains.setEnabled(db.get(), 'digests', true, 'test');
        domains.setEnabled(db.get(), 'portfolio', true, 'test');
    });

    test('a switched-off digests domain answers 503 to valid keys, reads and writes, but keeps its data', async () => {
        domains.setEnabled(db.get(), 'digests', false, 'test');
        const res = await request(app).get('/hub/digests').set(auth(reader)).expect(503);
        expect(res.body.error).toBe('domain_disabled');
        await request(app).put('/hub/digests/daily/2026-11-10').set(auth(writer)).send({ body: 'x' }).expect(503);
        await request(app).get('/hub/digests').expect(401); // authentication is still checked first

        domains.setEnabled(db.get(), 'digests', true, 'test');
        await request(app).get('/hub/digests/daily/2026-11-08').set(auth(reader)).expect(200);
    });

    test('switching the portfolio off takes the public routes down and back up', async () => {
        await request(app).get('/portfolio/atit').expect(200);
        domains.setEnabled(db.get(), 'portfolio', false, 'test');
        await request(app).get('/portfolio/atit').expect(503);
        await request(app).get('/portfolio/atit/md?id=0').expect(503);
        await request(app).get('/api/v1/portfolio/atit').expect(503);
        domains.setEnabled(db.get(), 'portfolio', true, 'test');
        await request(app).get('/portfolio/atit').expect(200);
    });
});
