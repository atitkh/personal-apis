process.env.HUB_DB_FILE = ':memory:';

// /hub/notes. Every note and name in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const entities = require('../services/entities');
const app = require('../app');

let reader;
let writer;
let writeOnly;
let other;
let narrow;
beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'note-reader', scopes: 'notes:read' }).key;
    writer = apiKeys.create(conn, { name: 'note-editor', scopes: 'notes:read, notes:api-write, entities:read' }).key;
    narrow = apiKeys.create(conn, { name: 'note-narrow', scopes: 'notes:read, notes:api-write' }).key;
    writeOnly = apiKeys.create(conn, { name: 'note-blind', scopes: 'notes:api-write' }).key;
    other = apiKeys.create(conn, { name: 'trips-only', scopes: 'trips:read' }).key;
    entities.create(conn, { kind: 'person', name: 'Zorblax Quimby', aliases: ['Zed'] }, 'seed');
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const TITLE = 'Quartz field notes';

test('scopes: read lists, api-write needs read too, other keys get nothing', async () => {
    await request(app).get('/hub/notes').expect(401);
    await request(app).get('/hub/notes').set(auth(other)).expect(403);
    await request(app).post('/hub/notes').set(auth(reader)).send({ title: TITLE }).expect(403);
    await request(app).post('/hub/notes').set(auth(writeOnly)).send({ title: TITLE }).expect(403);
    const made = await request(app).post('/hub/notes').set(auth(writer)).send({ title: TITLE, body: 'Met [[Zed]] and [[Nobody here]].', tags: ['field'] }).expect(201);
    expect(made.body).toMatchObject({ status: 'created', id: 1, kind: 'note', rev: 1, links: { added: 1, removed: 0, resolved: 1 }, unresolved: ['Nobody here'] });
    expect((await request(app).get('/hub/notes?tag=field').set(auth(reader)).expect(200)).body.notes[0]).toMatchObject({ title: TITLE, kind: 'note', tags: ['field'] });
    await request(app).get('/hub/notes/99').set(auth(reader)).expect(404);
});

test('get returns the body and the links only for domains the key can read', async () => {
    const full = (await request(app).get('/hub/notes/1').set(auth(writer)).expect(200)).body;
    expect(full).toMatchObject({ body: 'Met [[Zed]] and [[Nobody here]].', hidden: 0 });
    expect(full.links[0]).toMatchObject({ rel: 'mentions', direction: 'out', other: { domain: 'entities', title: 'Zorblax Quimby' } });
    const less = (await request(app).get('/hub/notes/1').set(auth(reader)).expect(200)).body;
    expect(less.links).toEqual([]);
    expect(less.hidden).toBe(1);
    expect((await request(app).get('/hub/notes/missing').set(auth(reader)).expect(200)).body.missing[0]).toMatchObject({ target: 'Nobody here', count: 1 });
});

test('patch, history and restore work; there is no DELETE or trash; the audit row has no titles or text', async () => {
    await request(app).patch('/hub/notes/1').set(auth(writer)).send({ body: 'canary-body-sandstone' }).expect(200);
    expect((await request(app).get('/hub/notes/1/history').set(auth(reader)).expect(200)).body.revisions).toHaveLength(2);
    expect((await request(app).post('/hub/notes/1/restore').set(auth(writer)).send({ rev: 1 }).expect(200)).body).toMatchObject({ rev: 3, links: { added: 1 } });
    expect([404, 405]).toContain((await request(app).delete('/hub/notes/1').set(auth(writer))).status);
    expect([404, 405]).toContain((await request(app).post('/hub/notes/1/trash').set(auth(writer))).status);
    expect((await request(app).get('/hub/notes/1').set(auth(reader)).expect(200)).body.title).toBe(TITLE);
    const rows = JSON.stringify(db.get().prepare("SELECT actor, action, detail FROM audit_log WHERE action LIKE 'note_%'").all());
    expect(rows).toContain('note-editor');
    expect(rows).not.toMatch(/quartz|zed|canary|zorblax/i);
});

test('a key that cannot read entities leaves [[Zed]] as plain text', async () => {
    const r = (await request(app).post('/hub/notes').set(auth(narrow)).send({ title: 'Narrow', body: '[[Zed]]' }).expect(201)).body;
    expect(r.links.resolved).toBe(0);
    expect(r.unresolved).toEqual(['Zed']);
});
