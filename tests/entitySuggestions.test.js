// The entities review queue: filing (no duplicates, nothing for a name that already is an entity), accept, dismiss, delete,
// the dashboard's API and the briefing line. Every name here is invented.
const KEY = 'c'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const ents = require('../services/entities');
const sug = require('../services/entitySuggestions');
const hooks = require('../services/briefingHooks');
const app = require('../app');

const conn = db.get();
const H = { 'X-Requested-With': 'hub-admin' };
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());
const rows = () => conn.prepare('SELECT name, status, count FROM entity_suggestions ORDER BY id').all();

test('files a new name once and counts repeat sightings, whatever the case', () => {
    expect(sug.suggest(conn, { name: '  Orla   Finch ', kind: 'person', example: 'a lab meeting' }, 'job').status).toBe('created');
    const again = sug.suggest(conn, { name: 'orla finch', kind: 'organization' }, 'job');
    expect(again.status).toBe('seen');
    expect(again.suggestion).toMatchObject({ count: 2, kind: 'person', example: 'a lab meeting' });
    expect(rows()).toEqual([{ name: 'Orla Finch', status: 'pending', count: 2 }]);
});

test('does not file a name that already is an entity or one of its aliases', () => {
    ents.create(conn, { kind: 'organization', name: 'Quillon Labs', aliases: ['QL'] }, 'test');
    const r = sug.suggest(conn, { name: 'ql' }, 'job');
    expect(r).toMatchObject({ status: 'exists', entity: { kind: 'organization', name: 'Quillon Labs' } });
    expect(sug.suggest(conn, { name: 'QUILLON labs' }, 'job').status).toBe('exists');
    expect(rows().map((x) => x.name)).toEqual(['Orla Finch']);
});

test('rejects a missing name or an unknown kind', () => {
    expect(() => sug.suggest(conn, { name: '  ' }, 'job')).toThrow(/required/);
    expect(() => sug.suggest(conn, { name: 'Zed', kind: 'planet' }, 'job')).toThrow(/kind/);
});

test('dismissed names stay dismissed and only count up', () => {
    const id = sug.suggest(conn, { name: 'Pell Rowan', kind: 'person' }, 'job').suggestion.id;
    expect(sug.dismiss(conn, id, 'admin').status).toBe('dismissed');
    expect(sug.dismiss(conn, id, 'admin').status).toBe('unchanged');
    const r = sug.suggest(conn, { name: 'Pell Rowan' }, 'job');
    expect(r.suggestion).toMatchObject({ status: 'dismissed', count: 2 });
    expect(sug.counts(conn)).toEqual({ pending: 1, accepted: 0, dismissed: 1 });
});

test('accept makes an entity, or adds an alias, and cannot happen twice', () => {
    const id = sug.suggest(conn, { name: 'Orla Finch' }, 'job').suggestion.id;
    const out = sug.accept(conn, id, { notes: 'invented' }, 'admin');
    expect(out).toMatchObject({ status: 'accepted', alias: false, entity: { kind: 'person', name: 'Orla Finch' } });
    expect(ents.find(conn, 'orla finch').count).toBe(1);
    expect(() => sug.accept(conn, id, {}, 'admin')).toThrow(/already/);
    const b = sug.suggest(conn, { name: 'Q Labs', kind: 'organization' }, 'job').suggestion.id;
    const ql = ents.find(conn, 'Quillon Labs').entities[0];
    expect(sug.accept(conn, b, { entity_id: ql.id }, 'admin')).toMatchObject({ alias: true, entity: { id: ql.id } });
    expect(ents.get(conn, ql.id).aliases).toEqual(['QL', 'Q Labs']);
    expect(sug.suggest(conn, { name: 'q labs' }, 'job').status).toBe('exists');
});

test('the dashboard API lists, dismisses all, deletes by status and audits counts, never names', async () => {
    sug.suggest(conn, { name: 'Sable Hart' }, 'job'); sug.suggest(conn, { name: 'Tarn Voss', kind: 'project' }, 'job');
    expect((await agent.get('/admin/api/entities/suggestions').expect(200)).body.counts.pending).toBe(2);
    await request(app).post('/admin/api/entities/suggestions/dismiss-all').send({}).expect(403);
    const d = (await agent.post('/admin/api/entities/suggestions/dismiss-all').set(H).send({}).expect(200)).body;
    expect(d).toMatchObject({ status: 'dismissed', count: 2, counts: { pending: 0, dismissed: 3 } });
    await agent.delete('/admin/api/entities/suggestions').set(H).send({ status: 'dismissed' }).expect(400);
    const gone = (await agent.delete('/admin/api/entities/suggestions').set(H).send({ status: 'dismissed', confirm: true }).expect(200)).body;
    expect(gone).toMatchObject({ status: 'deleted', count: 3, suggestion_status: 'dismissed' });
    const log = conn.prepare("SELECT detail FROM audit_log WHERE action LIKE 'entity_suggestion%'").all().map((r) => r.detail).join(' ');
    expect(log).not.toMatch(/Orla|Pell|Sable|Tarn|Quillon|Q Labs/);
});

test('the briefing line counts waiting names without naming them', () => {
    expect(hooks.entities(conn).attention).toEqual([]);
    sug.suggest(conn, { name: 'Vesper Lund' }, 'job');
    const a = hooks.entities(conn).attention;
    expect(a).toHaveLength(1);
    expect(a[0].text).toBe('1 name waits for review in Entities');
    expect(JSON.stringify(a)).not.toMatch(/Vesper/);
});
