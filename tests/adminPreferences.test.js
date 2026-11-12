// The dashboard's preferences API: an admin session. Every preference in this file is invented.
const KEY = 'e'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const domains = require('../services/domains');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const VALUE = 'canary-value-sandstone';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
afterEach(() => domains.setEnabled(db.get(), 'preferences', true, 'test'));

const item = (extra = {}) => ({ area: 'travel', key: 'airline_seat', value: VALUE, ...extra });

describe('admin preferences: access', () => {
    test('needs a session for reads and the X-Requested-With header for changes', async () => {
        await request(app).get('/admin/api/preferences').expect(401);
        await request(app).get('/admin/api/preferences/1').expect(401);
        await request(app).get('/admin/api/preferences/1/history').expect(401);
        await request(app).post('/admin/api/preferences').set(H).send(item()).expect(401);
        await agent.post('/admin/api/preferences').send(item()).expect(403);
        await agent.post('/admin/api/preferences/1/unset').send({}).expect(403);
        await agent.patch('/admin/api/preferences/1').send({ value: 'x' }).expect(403);
        expect((await agent.get('/admin/api/preferences').expect(200)).body.total).toBe(0);
    });
});

describe('admin preferences: CRUD', () => {
    test('create, list, get with history, patch', async () => {
        const made = (await agent.post('/admin/api/preferences').set(H).send(item()).expect(201)).body;
        expect(made).toEqual({ status: 'created', id: 1, area: 'travel', key: 'airline_seat', rev: 1 });
        await agent.post('/admin/api/preferences').set(H).send(item({ area: 'food', key: 'allergy', value: 'peanuts' })).expect(201);
        const list = (await agent.get('/admin/api/preferences').expect(200)).body;
        expect(list.preferences.map((p) => p.key)).toEqual(['airline_seat', 'allergy']);
        expect((await agent.get('/admin/api/preferences?area=food&q=pea').expect(200)).body.total).toBe(1);
        const one = (await agent.get('/admin/api/preferences/1').expect(200)).body;
        expect(one).toMatchObject({ value: VALUE, revisions: 1 });
        expect(one.history).toEqual([expect.objectContaining({ rev: 1, source: 'create', current: true })]);
        const patched = (await agent.patch('/admin/api/preferences/1').set(H).send({ value: 'window', notes: 'near the wing' }).expect(200)).body;
        expect(patched).toMatchObject({ status: 'updated', rev: 2, fields: ['value', 'notes'] });
        expect((await agent.get('/admin/api/preferences/1?rev=1').expect(200)).body).toMatchObject({ value: VALUE, rev: 1 });
        expect((await agent.get('/admin/api/preferences/1/history').expect(200)).body.revisions).toHaveLength(2);
    });

    test('errors name the code and the field; duplicates are 409', async () => {
        const secret = (await agent.post('/admin/api/preferences').set(H).send(item({ key: 'k', value: 'call 5015551234' })).expect(400)).body;
        expect(secret).toMatchObject({ code: 'secret_like', field: 'value' });
        expect(secret.error).toContain('Keep passwords, numbers and keys in the vault, not here.');
        expect((await agent.post('/admin/api/preferences').set(H).send(item({ key: 'api_token' })).expect(400)).body).toMatchObject({ code: 'secret_like', field: 'key' });
        expect((await agent.post('/admin/api/preferences').set(H).send(item()).expect(409)).body).toMatchObject({ code: 'exists', id: 1 });
        await agent.get('/admin/api/preferences/9999').expect(404);
        await agent.patch('/admin/api/preferences/9999').set(H).send({ value: 'x' }).expect(404);
    });

    test('unset hides, Removed lists it, restore brings it back; there is no delete', async () => {
        await agent.delete('/admin/api/preferences/1').set(H).expect(404);
        expect((await agent.post('/admin/api/preferences/1/unset').set(H).send({}).expect(200)).body.status).toBe('unset');
        expect((await agent.post('/admin/api/preferences/1/unset').set(H).send({}).expect(200)).body.status).toBe('unchanged');
        expect((await agent.get('/admin/api/preferences').expect(200)).body.preferences.map((p) => p.key)).toEqual(['allergy']);
        expect((await agent.get('/admin/api/preferences?removed=true').expect(200)).body.preferences.map((p) => p.key)).toEqual(['airline_seat']);
        expect((await agent.post('/admin/api/preferences/1/restore').set(H).send({}).expect(200)).body).toMatchObject({ status: 'updated', fields: ['removed'] });
        expect((await agent.post('/admin/api/preferences/1/restore').set(H).send({ rev: 1 }).expect(200)).body.fields).toEqual(['value', 'notes']);
        await agent.post('/admin/api/preferences/1/restore').set(H).send({ rev: 99 }).expect(404);
    });

    test('changes are audited as admin with id, area and key only, and the Preferences activity filter finds them', async () => {
        const rows = audit.recent(db.get(), 300).filter((r) => r.action.startsWith('preference_'));
        expect(rows.length).toBeGreaterThan(4);
        expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['admin']));
        for (const r of rows) expect(Object.keys(r.detail).sort()).toEqual(['area', 'id', 'key']);
        expect(JSON.stringify(rows)).not.toContain(VALUE);
        const filtered = (await agent.get('/admin/api/activity?type=preferences').expect(200)).body;
        const list = filtered.events || filtered.items || filtered.activity || [];
        expect(list.length).toBeGreaterThan(0);
        expect(list.every((e) => e.action.startsWith('preference_'))).toBe(true);
    });

    test('works while the domain is switched off', async () => {
        domains.setEnabled(db.get(), 'preferences', false, 'test');
        expect((await agent.get('/admin/api/preferences').expect(200)).body.total).toBeGreaterThan(0);
        await agent.post('/admin/api/preferences').set(H).send(item({ area: 'other', key: 'while_off', value: 'ok' })).expect(201);
    });
});
