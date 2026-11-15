process.env.HUB_DB_FILE = ':memory:';

// /hub/entities. Every entity in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const app = require('../app');

let reader;
let writer;
let writeOnly;
let other;
beforeAll(() => {
    const conn = db.get();
    reader = apiKeys.create(conn, { name: 'ent-reader', scopes: 'entities:read' }).key;
    writer = apiKeys.create(conn, { name: 'ent-editor', scopes: 'entities:read, entities:api-write' }).key;
    writeOnly = apiKeys.create(conn, { name: 'ent-blind', scopes: 'entities:api-write' }).key;
    other = apiKeys.create(conn, { name: 'trips-only', scopes: 'trips:read' }).key;
});
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const NAME = 'Zorblax Quimby';

test('scopes: read lists, api-write needs read too, other keys get nothing', async () => {
    await request(app).get('/hub/entities').expect(401);
    await request(app).get('/hub/entities').set(auth(other)).expect(403);
    await request(app).post('/hub/entities').set(auth(reader)).send({ kind: 'person', name: NAME }).expect(403);
    await request(app).post('/hub/entities').set(auth(writeOnly)).send({ kind: 'person', name: NAME }).expect(403);
    const made = await request(app).post('/hub/entities').set(auth(writer)).send({ kind: 'person', name: NAME, aliases: ['Zed'] }).expect(201);
    expect(made.body).toEqual({ status: 'created', id: 1, kind: 'person', rev: 1 });
    expect((await request(app).get('/hub/entities?q=zed').set(auth(reader)).expect(200)).body.entities[0]).toMatchObject({ name: NAME, link_count: 0 });
    await request(app).get('/hub/entities/99').set(auth(reader)).expect(404);
});

test('patch, history and restore work; there is no DELETE; the audit row has no names', async () => {
    await request(app).patch('/hub/entities/1').set(auth(writer)).send({ notes: 'canary-note-sandstone' }).expect(200);
    expect((await request(app).get('/hub/entities/1/history').set(auth(reader)).expect(200)).body.revisions).toHaveLength(2);
    expect((await request(app).post('/hub/entities/1/restore').set(auth(writer)).send({ rev: 1 }).expect(200)).body.rev).toBe(3);
    expect([404, 405]).toContain((await request(app).delete('/hub/entities/1').set(auth(writer))).status);
    expect((await request(app).get('/hub/entities/1').set(auth(reader)).expect(200)).body.name).toBe(NAME);
    const rows = JSON.stringify(db.get().prepare("SELECT actor, action, detail FROM audit_log WHERE action LIKE 'entity_%'").all());
    expect(rows).toContain('ent-editor');
    expect(rows).not.toMatch(/zorblax|zed|canary/i);
});
