process.env.HUB_DB_FILE = ':memory:';

// Every entity in this file is invented.
const db = require('../db');
const ents = require('../services/entities');
const links = require('../services/links');
const search = require('../services/search');
const audit = require('../services/audit');
const trips = require('../services/trips');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };
const mk = (extra = {}) => ents.create(conn, { kind: 'person', name: 'Mira Delgado', aliases: ['MD', 'Mira'], notes: 'Met at the lab', ...extra }, 'tester');

describe('create and validation', () => {
    test('files an entity with revision 1 and tidy aliases', () => {
        const r = mk({ name: '  Mira   Delgado ', aliases: 'MD, md, Mira Delgado,  M  D ,' });
        expect(r).toEqual({ status: 'created', id: 1, kind: 'person', rev: 1 });
        expect(ents.get(conn, 1)).toMatchObject({ name: 'Mira Delgado', aliases: ['MD', 'M D'], notes: 'Met at the lab', rev: 1, revisions: 1, link_count: 0 });
    });

    test('kind, name, aliases and notes are checked', () => {
        expect(code(() => mk({ kind: 'pet' }))).toBe('bad_kind');
        expect(code(() => mk({ name: ' ' }))).toBe('bad_name');
        expect(code(() => mk({ name: 'n'.repeat(121) }))).toBe('bad_request');
        expect(code(() => mk({ aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) }))).toBe('bad_aliases');
        expect(code(() => mk({ aliases: ['x'.repeat(61)] }))).toBe('bad_request');
        expect(code(() => mk({ notes: 'n'.repeat(2001) }))).toBe('bad_request');
        expect(code(() => mk({ colour: 'red' }))).toBe('bad_field');
        expect(ents.list(conn).total).toBe(0);
    });

    test('one entity per kind and name, ignoring case, without the name in the error', () => {
        mk();
        let err;
        try { mk({ name: 'MIRA delgado' }); } catch (e) { err = e; }
        expect(err.code).toBe('exists');
        expect(err.status).toBe(409);
        expect(err.extra).toEqual({ id: 1 });
        expect(err.message).not.toMatch(/mira/i);
        expect(mk({ kind: 'project', name: 'Mira Delgado' }).status).toBe('created');
    });
});

describe('update, revisions and restore', () => {
    test('partial updates, unchanged detection and null clears', () => {
        mk();
        expect(ents.update(conn, 1, { notes: 'Colleague' }, 'tester')).toMatchObject({ status: 'updated', rev: 2, fields: ['notes'] });
        expect(ents.update(conn, 1, { notes: 'Colleague', aliases: ['MD', 'Mira'] }, 'tester').status).toBe('unchanged');
        expect(ents.update(conn, 1, { aliases: null, notes: null }, 'tester')).toMatchObject({ rev: 3, fields: ['aliases', 'notes'] });
        expect(ents.get(conn, 1)).toMatchObject({ aliases: [], notes: null });
        expect(code(() => ents.update(conn, 1, {}, 'tester'))).toBe('bad_request');
        expect(code(() => ents.update(conn, 99, { notes: 'x' }, 'tester'))).toBe('not_found');
        mk({ name: 'Other One' });
        expect(code(() => ents.update(conn, 2, { name: 'mira delgado' }, 'tester'))).toBe('exists');
    });

    test('history, reading an old revision and restoring it', () => {
        mk();
        ents.update(conn, 1, { name: 'Mira D.', aliases: ['MD2'] }, 'tester');
        expect(ents.history(conn, 1).map((r) => [r.rev, r.source, r.current])).toEqual([[2, 'edit', true], [1, 'create', false]]);
        expect(ents.get(conn, 1, { rev: 1 })).toMatchObject({ name: 'Mira Delgado', aliases: ['MD', 'Mira'], rev: 1 });
        expect(ents.restore(conn, 1, 1, 'tester')).toMatchObject({ status: 'updated', rev: 3, fields: ['name', 'aliases'] });
        expect(ents.get(conn, 1)).toMatchObject({ name: 'Mira Delgado', aliases: ['MD', 'Mira'] });
        expect(ents.restore(conn, 1, 3, 'tester').status).toBe('unchanged');
        expect(code(() => ents.restore(conn, 1, 9, 'tester'))).toBe('no_revision');
    });
});

describe('find and list', () => {
    test('find matches the name or an alias exactly, any case', () => {
        mk();
        mk({ kind: 'organization', name: 'Mira', aliases: [] });
        expect(ents.find(conn, 'md').entities.map((e) => e.id)).toEqual([1]);
        expect(ents.find(conn, 'MIRA').entities.map((e) => e.id)).toEqual([1, 2]);
        expect(ents.find(conn, 'mira', { kind: 'organization' }).entities.map((e) => e.id)).toEqual([2]);
        expect(ents.find(conn, 'Kun').count).toBe(0);
    });

    test('list filters by kind and by q over name, aliases and notes, with link counts', () => {
        mk();
        mk({ kind: 'project', name: 'Hub', aliases: ['personal-apis'], notes: null });
        expect(ents.list(conn, { kind: 'project' }).entities.map((e) => e.name)).toEqual(['Hub']);
        expect(ents.list(conn, { q: 'personal-apis' }).total).toBe(1);
        expect(ents.list(conn, { q: 'lab' }).entities[0].name).toBe('Mira Delgado');
        expect(ents.list(conn, { q: '%' }).total).toBe(0);
        expect(code(() => ents.list(conn, { kind: 'x' }))).toBe('bad_kind');
        links.add(conn, { from: { domain: 'entities', id: '1' }, to: { domain: 'entities', id: '2' } }, 't');
        expect(ents.list(conn).entities.map((e) => e.link_count)).toEqual([1, 1]);
        expect(ents.stats(conn)).toMatchObject({ records: 2, label: 'entities' });
    });

    test('search finds an entity by alias and shows its name as the title', () => {
        mk();
        const hit = search.search(conn, 'md', { domains: ['entities'] });
        expect(JSON.stringify(hit)).toContain('Mira Delgado');
    });
});

describe('links and delete', () => {
    test('links describes entities, so records can point at them', () => {
        mk();
        const t = trips.create(conn, { title: 'Lab visit', kind: 'work' }, 't').id;
        links.add(conn, { from: { domain: 'trips', id: String(t) }, to: { domain: 'entities', id: '1' }, rel: 'with' }, 't');
        expect(links.listFor(conn, 'entities', '1').links[0].other).toMatchObject({ domain: 'trips', title: 'Lab visit' });
        expect(links.listFor(conn, 'trips', String(t)).links[0].other).toMatchObject({ domain: 'entities', title: 'Mira Delgado', kind: 'person' });
    });

    test('delete needs confirm, shows the counts, and takes the links with it', () => {
        mk();
        const t = trips.create(conn, { title: 'Lab visit', kind: 'work' }, 't').id;
        links.add(conn, { from: { domain: 'trips', id: String(t) }, to: { domain: 'entities', id: '1' } }, 't');
        expect(ents.removalPreview(conn, 1)).toMatchObject({ id: 1, kind: 'person', label: 'Mira Delgado', counts: { links: 1, revisions: 1 } });
        expect(code(() => ents.remove(conn, 1, {}))).toBe('confirm_required');
        const out = ents.remove(conn, 1, { confirm: true });
        expect(out.status).toBe('deleted');
        expect(conn.prepare('SELECT COUNT(*) AS n FROM links').get().n).toBe(0);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM entity_revisions').get().n).toBe(0);
        expect(trips.get(conn, t).title).toBe('Lab visit');
        expect(code(() => ents.get(conn, 1))).toBe('not_found');
    });

    test('audit detail never carries names, aliases or notes', () => {
        const r = mk();
        const u = ents.update(conn, 1, { name: 'Mira D.', notes: 'secret note' }, 'tester');
        audit.record(conn, 'admin', 'entity_created', ents.auditDetail(r));
        audit.record(conn, 'admin', 'entity_updated', ents.auditDetail(u));
        audit.record(conn, 'admin', 'entity_deleted', ents.removedAuditDetail(ents.remove(conn, 1, { confirm: true })));
        const all = conn.prepare('SELECT action, detail FROM audit_log').all();
        expect(JSON.parse(all.find((a) => a.action === 'entity_updated').detail)).toEqual({ id: 1, kind: 'person', rev: 2, fields: ['name', 'notes'] });
        const rows = JSON.stringify(all);
        expect(rows).not.toMatch(/mira|secret note|Met at/i);
    });
});
