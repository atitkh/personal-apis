// The dashboard's entities API: an admin session. Every entity in this file is invented.
const KEY = 'e'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const links = require('../services/links');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const NAME = 'Zorblax Quimby';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const ent = (extra = {}) => ({ kind: 'person', name: NAME, aliases: ['Zed'], notes: 'canary-note-sandstone', ...extra });

test('needs a session for reads and the X-Requested-With header for changes', async () => {
    await request(app).get('/admin/api/entities').expect(401);
    await request(app).post('/admin/api/entities').set(H).send(ent()).expect(401);
    await agent.post('/admin/api/entities').send(ent()).expect(403);
    await agent.delete('/admin/api/entities/1').send({ confirm: true }).expect(403);
});

test('create, list, get with history, patch, restore', async () => {
    expect((await agent.post('/admin/api/entities').set(H).send(ent()).expect(201)).body).toEqual({ status: 'created', id: 1, kind: 'person', rev: 1 });
    await agent.post('/admin/api/entities').set(H).send(ent()).expect(409);
    await agent.post('/admin/api/entities').set(H).send(ent({ kind: 'project', name: 'Hub', aliases: [] })).expect(201);
    expect((await agent.get('/admin/api/entities?kind=project').expect(200)).body.entities.map((e) => e.name)).toEqual(['Hub']);
    expect((await agent.get('/admin/api/entities?q=zed').expect(200)).body.total).toBe(1);
    const one = (await agent.get('/admin/api/entities/1').expect(200)).body;
    expect(one).toMatchObject({ name: NAME, aliases: ['Zed'], revisions: 1, link_count: 0 });
    expect(one.history).toEqual([expect.objectContaining({ rev: 1, source: 'create', current: true })]);
    expect((await agent.patch('/admin/api/entities/1').set(H).send({ aliases: ['Zed', 'ZQ'] }).expect(200)).body).toMatchObject({ status: 'updated', rev: 2, fields: ['aliases'] });
    expect((await agent.patch('/admin/api/entities/1').set(H).send({ aliases: ['Zed', 'ZQ'] }).expect(200)).body.status).toBe('unchanged');
    await agent.post('/admin/api/entities/1/restore').set(H).send({ rev: 1 }).expect(200);
    expect((await agent.get('/admin/api/entities/1').expect(200)).body.aliases).toEqual(['Zed']);
    await agent.get('/admin/api/entities/99').expect(404);
    await agent.post('/admin/api/entities').set(H).send({ kind: 'person' }).expect(400);
});

test('delete needs confirm, previews the links, takes them with it and audits without the name', async () => {
    links.add(db.get(), { from: { domain: 'entities', id: '1' }, to: { domain: 'entities', id: '2' } }, 't');
    expect((await agent.get('/admin/api/entities/1/delete-preview').expect(200)).body).toMatchObject({ label: NAME, counts: { links: 1 } });
    await agent.delete('/admin/api/entities/1').set(H).expect(400);
    expect((await agent.get('/admin/api/entities/1').expect(200)).body.name).toBe(NAME);
    const out = (await agent.delete('/admin/api/entities/1').set(H).send({ confirm: true }).expect(200)).body;
    expect(out).toMatchObject({ status: 'deleted', id: 1, counts: { links: 1 }, backup: null });
    expect(db.get().prepare('SELECT COUNT(*) AS n FROM links').get().n).toBe(0);
    await agent.delete('/admin/api/entities/1').set(H).send({ confirm: true }).expect(404);
    const rows = JSON.stringify(db.get().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'entity_%'").all());
    expect(rows).toContain('entity_deleted');
    expect(rows).toContain('entity_created');
    expect(rows).not.toMatch(/zorblax|zed|canary/i);
});
