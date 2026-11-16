// [[wikilinks]] in digests: 'mentions' links from the digest, kept in line with its text. Every name here is invented.
process.env.HUB_DB_FILE = ':memory:';

const db = require('../db');
const digests = require('../services/digests');
const notes = require('../services/notes');
const ents = require('../services/entities');
const links = require('../services/links');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const D = 'daily/2026-11-08';
const put = (body, extra = {}) => digests.put(conn, 'daily', '2026-11-08', { body, actor: 'digest-job', ...extra });
const ent = (name, extra = {}) => String(ents.create(conn, { kind: 'person', name, ...extra }, 'tester').id);
const rows = (rel) => conn.prepare("SELECT to_domain, to_id FROM links WHERE from_domain = 'digests' AND from_id = ? AND rel = ? ORDER BY to_domain, to_id").all(D, rel);
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };

test('put links what the text names (notes, entities, aliases, domain refs) and get explains it', () => {
    const quill = ent('Quill Vantor', { aliases: ['QV'] });
    const n = notes.create(conn, { title: 'Moss garden', body: '' }, 'tester');
    expect(put('Met [[Quill Vantor]] and [[qv]], read [[Moss garden]], see [[notes:' + n.id + '|that]], and [[Nobody here]].').status).toBe('created');
    expect(rows('mentions')).toEqual([{ to_domain: 'entities', to_id: quill }, { to_domain: 'notes', to_id: String(n.id) }]);
    const d = digests.get(conn, 'daily', '2026-11-08');
    expect(d.wikilinks.unresolved).toEqual(['Nobody here']);
    expect(d.wikilinks.resolved.map((r) => `${r.domain}:${r.title}`)).toEqual(['entities:Quill Vantor', 'entities:Quill Vantor', 'notes:Moss garden', 'notes:Moss garden']);
    expect(links.listFor(conn, 'digests', D).links.map((l) => l.rel)).toEqual(['mentions', 'mentions']);
});

test('edit and restore sync only rel mentions; covers links are never touched; a link to itself is skipped', () => {
    const a = ent('Quill Vantor');
    const b = ent('Orrin Plume');
    put('With [[Quill Vantor]] and [[digests:daily/2026-11-08]].');
    conn.prepare("INSERT INTO links (from_domain, from_id, to_domain, to_id, rel, created_at, actor) VALUES ('digests', ?, 'entities', ?, 'covers', 'x', 'script')").run(D, b);
    expect(rows('mentions')).toEqual([{ to_domain: 'entities', to_id: a }]);
    digests.edit(conn, 'daily', '2026-11-08', { body: 'Now with [[Orrin Plume]] only.', actor: 'admin' });
    expect(rows('mentions')).toEqual([{ to_domain: 'entities', to_id: b }]);
    expect(rows('covers')).toEqual([{ to_domain: 'entities', to_id: b }]);
    digests.restore(conn, 'daily', '2026-11-08', 1, 'admin');
    expect(rows('mentions')).toEqual([{ to_domain: 'entities', to_id: a }]);
    expect(rows('covers')).toEqual([{ to_domain: 'entities', to_id: b }]);
});

test('hand-edit protection is unchanged; visible limits what a key can link', () => {
    const a = ent('Quill Vantor');
    put('first');
    digests.edit(conn, 'daily', '2026-11-08', { body: 'edited by hand [[Quill Vantor]]', actor: 'admin' });
    expect(code(() => put('generated again [[Quill Vantor]]'))).toBe('edited');
    expect(rows('mentions')).toEqual([{ to_domain: 'entities', to_id: a }]);
    put('forced, no links', { force: true });
    expect(rows('mentions')).toEqual([]);
    digests.edit(conn, 'daily', '2026-11-08', { body: 'x [[Quill Vantor]]', actor: 'k' }, { visible: ['digests', 'notes'] });
    expect(rows('mentions')).toEqual([]);
    expect(digests.get(conn, 'daily', '2026-11-08', { visible: ['digests'] }).wikilinks.unresolved).toEqual(['Quill Vantor']);
});

test('resolveTargets for the editor, and recent leaves wikilinks out', () => {
    ent('Quill Vantor');
    put('hello');
    const r = digests.resolveTargets(conn, 'daily', '2026-11-08', ['quill vantor', 'Nope', 'digests:daily/2026-11-08']);
    expect(r.resolved.map((x) => x.title)).toEqual(['Quill Vantor']);
    expect(r.unresolved).toEqual(['Nope']);
    expect(digests.recent(conn, 'daily', 1)[0].wikilinks).toBeUndefined();
});

test('permanent delete drops the digest\'s own mentions rows', () => {
    ent('Quill Vantor');
    put('[[Quill Vantor]]');
    digests.remove(conn, 'daily', '2026-11-08', { confirm: true });
    expect(rows('mentions')).toEqual([]);
});
