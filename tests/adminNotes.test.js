// The dashboard's notes API: an admin session. Every note and name in this file is invented.
const KEY = 'n'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const entities = require('../services/entities');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
    entities.create(db.get(), { kind: 'person', name: 'Zorblax Quimby' }, 'seed');
});
afterAll(() => db.close());

const note = (extra = {}) => ({ title: 'Quartz field notes', body: 'canary-body-sandstone with [[Zorblax Quimby]] and [[Not yet]]', tags: ['field'], ...extra });

test('needs a session for reads and the X-Requested-With header for changes', async () => {
    await request(app).get('/admin/api/notes').expect(401);
    await request(app).post('/admin/api/notes').set(H).send(note()).expect(401);
    await agent.post('/admin/api/notes').send(note()).expect(403);
    await agent.delete('/admin/api/notes/1').send({ confirm: true }).expect(403);
});

test('create, list, facets, get with history and wikilinks, missing, resolve', async () => {
    const made = (await agent.post('/admin/api/notes').set(H).send(note()).expect(201)).body;
    expect(made).toMatchObject({ status: 'created', id: 1, rev: 1, links: { resolved: 1 }, unresolved: ['Not yet'] });
    await agent.post('/admin/api/notes').set(H).send({ body: 'no title' }).expect(400);
    expect((await agent.get('/admin/api/notes?tag=field').expect(200)).body.notes[0]).toMatchObject({ title: 'Quartz field notes', updated_by: 'admin' });
    expect((await agent.get('/admin/api/notes/facets').expect(200)).body).toMatchObject({ total: 1, tags: [{ tag: 'field', count: 1 }] });
    const one = (await agent.get('/admin/api/notes/1').expect(200)).body;
    expect(one).toMatchObject({ body: expect.stringContaining('canary'), revisions: 1, wikilinks: { unresolved: ['Not yet'] } });
    expect(one.history).toEqual([expect.objectContaining({ rev: 1, source: 'create', current: true })]);
    expect((await agent.get('/admin/api/notes/missing').expect(200)).body.missing[0]).toMatchObject({ target: 'Not yet', count: 1 });
    const r = (await agent.post('/admin/api/notes/resolve').set(H).send({ id: 1, targets: ['zorblax quimby', 'Nope'] }).expect(200)).body;
    expect(r.resolved[0]).toMatchObject({ domain: 'entities', title: 'Zorblax Quimby' });
    expect(r.unresolved).toEqual(['Nope']);
    await agent.get('/admin/api/notes/99').expect(404);
});

test('autosave edits skip the revision inside 5 minutes; explicit save and restore file one', async () => {
    const a = (await agent.patch('/admin/api/notes/1').set(H).send({ body: 'second text', autosave: true }).expect(200)).body;
    expect(a).toMatchObject({ status: 'updated', rev: 1, revised: false });
    expect((await agent.patch('/admin/api/notes/1').set(H).send({ body: 'second text' }).expect(200)).body).toMatchObject({ rev: 2, revised: true });
    expect((await agent.patch('/admin/api/notes/1').set(H).send({ body: 'second text' }).expect(200)).body.status).toBe('unchanged');
    expect((await agent.post('/admin/api/notes/1/restore').set(H).send({ rev: 1 }).expect(200)).body).toMatchObject({ rev: 3, links: { added: 1 } });
    expect((await agent.get('/admin/api/notes/1?rev=2').expect(200)).body.body).toBe('second text');
});

test('trash and put back, then permanent delete needs confirm, previews links and audits without text', async () => {
    expect((await agent.post('/admin/api/notes/1/trash').set(H).expect(200)).body.status).toBe('removed');
    expect((await agent.get('/admin/api/notes').expect(200)).body.total).toBe(0);
    expect((await agent.get('/admin/api/notes?removed=1').expect(200)).body.total).toBe(1);
    expect((await agent.get('/admin/api/notes/1').expect(200)).body.removed).toBe(true);
    expect((await agent.post('/admin/api/notes/1/untrash').set(H).expect(200)).body.status).toBe('restored');
    expect((await agent.get('/admin/api/notes/1/delete-preview').expect(200)).body).toMatchObject({ label: 'Quartz field notes', counts: { links: 1, revisions: 3 } });
    await agent.delete('/admin/api/notes/1').set(H).expect(400);
    const out = (await agent.delete('/admin/api/notes/1').set(H).send({ confirm: true }).expect(200)).body;
    expect(out).toMatchObject({ status: 'deleted', id: 1, counts: { links: 1 }, backup: null });
    expect(db.get().prepare('SELECT COUNT(*) AS n FROM links').get().n).toBe(0);
    await agent.delete('/admin/api/notes/1').set(H).send({ confirm: true }).expect(404);
    const rows = JSON.stringify(db.get().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'note_%'").all());
    for (const a of ['note_created', 'note_updated', 'note_restored', 'note_trashed', 'note_untrashed', 'note_deleted']) expect(rows).toContain(a);
    expect(rows).not.toMatch(/quartz|zorblax|canary|second text/i);
});
