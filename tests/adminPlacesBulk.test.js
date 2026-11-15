// The places queue: "Dismiss all waiting" and "Delete all" by status. Streets here are invented.
const KEY = 'b'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const places = require('../services/places');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const file = (street) => places.resolve(db.get(), { geocode: `${street}, Springfield`, suggest: true }).suggestion;
const counts = async () => (await agent.get('/admin/api/places/suggestions').expect(200)).body.counts;

test('dismiss all moves every waiting spot to dismissed, once, and is audited by count', async () => {
    file('Alder Row 1'); file('Birch Lane 2'); file('Cedar Court 3');
    expect(await counts()).toMatchObject({ pending: 3, dismissed: 0 });
    await request(app).post('/admin/api/places/suggestions/dismiss-all').send({}).expect(403);
    const r = (await agent.post('/admin/api/places/suggestions/dismiss-all').set(H).send({}).expect(200)).body;
    expect(r).toMatchObject({ status: 'dismissed', count: 3, counts: { pending: 0, dismissed: 3 } });
    expect((await agent.post('/admin/api/places/suggestions/dismiss-all').set(H).send({}).expect(200)).body.status).toBe('unchanged');
    const rows = db.get().prepare("SELECT detail FROM audit_log WHERE action = 'place_suggestions_dismissed'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBe('{"count":3}');
});

test('delete all by status needs confirm and a valid status, removes only that status, and never logs a street', async () => {
    file('Dogwood Way 4'); file('Elm Close 5');
    await agent.delete('/admin/api/places/suggestions').set(H).send({ status: 'pending' }).expect(400); // no confirm
    await agent.delete('/admin/api/places/suggestions').set(H).send({ status: 'bogus', confirm: true }).expect(400);
    const gone = (await agent.delete('/admin/api/places/suggestions').set(H).send({ status: 'pending', confirm: true }).expect(200)).body;
    expect(gone).toMatchObject({ status: 'deleted', count: 2, suggestion_status: 'pending' });
    expect(await counts()).toMatchObject({ pending: 0, dismissed: 3 });
    const all = (await agent.delete('/admin/api/places/suggestions').set(H).send({ status: 'all', confirm: true }).expect(200)).body;
    expect(all.count).toBe(3);
    expect(await counts()).toMatchObject({ pending: 0, accepted: 0, dismissed: 0 });
    const text = db.get().prepare("SELECT detail FROM audit_log WHERE action = 'place_suggestion_deleted'").all().map((r) => r.detail).join(' ');
    expect(text).not.toMatch(/Alder|Birch|Cedar|Dogwood|Elm/);
});
