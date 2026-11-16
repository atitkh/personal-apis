process.env.HUB_DB_FILE = ':memory:';

// Every note, entity and name in this file is invented.
const db = require('../db');
const notes = require('../services/notes');
const ents = require('../services/entities');
const links = require('../services/links');
const search = require('../services/search');
const graph = require('../services/graph');
const wikilinks = require('../services/lib/wikilinks');
const trips = require('../services/trips');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };
const mk = (extra = {}) => notes.create(conn, { title: 'Garden plan', body: 'Plant beans.', ...extra }, 'tester');
const ent = (name, extra = {}) => ents.create(conn, { kind: 'person', name, ...extra }, 'tester').id;
const mentions = (id) => conn.prepare("SELECT to_domain, to_id, actor FROM links WHERE from_domain = 'notes' AND from_id = ? AND rel = 'mentions' ORDER BY id").all(String(id));
const isDomain = (n) => ['trips', 'entities', 'notes'].includes(n);

describe('wikilink parser', () => {
    test('plain, labelled and domain forms, once per target', () => {
        const p = wikilinks.parse('See [[Garden plan]], [[garden PLAN]], [[Mira|my friend]] and [[trips:3|Paris]] and [[Re: this]].', isDomain);
        expect(p.map((x) => [x.target, x.label, x.ref])).toEqual([
            ['Garden plan', null, null], ['Mira', 'my friend', null], ['trips:3', 'Paris', { domain: 'trips', id: '3' }], ['Re: this', null, null],
        ]);
    });

    test('code fences and inline code are not scanned, an open fence runs to the end', () => {
        const body = ['[[Real one]]', '```js', 'const a = [[Fenced]];', '```', 'and `[[Inline]]` and ``[[Double ` tick]]`` text', '~~~', '[[Tilde]]', '~~~', '[[After]]', '```', '[[Open fence]]'].join('\n');
        expect(wikilinks.parse(body, isDomain).map((x) => x.target)).toEqual(['Real one', 'After']);
    });

    test('empty, nested and over-long brackets are ignored; the count is capped', () => {
        expect(wikilinks.parse('[[ ]] [[]] [[a[[b]]c]] [[' + 'x'.repeat(250) + ']]', isDomain).map((x) => x.target)).toEqual(['b']);
        const many = Array.from({ length: 300 }, (_, i) => `[[T${i}]]`).join(' ');
        expect(wikilinks.parse(many, isDomain)).toHaveLength(wikilinks.MAX_TARGETS);
    });
});

describe('create, validation and reads', () => {
    test('files a note with revision 1, a tidy kind and tags', () => {
        const r = mk({ kind: 'Meeting', tags: ['#Garden', 'two words', 'garden', ''] });
        expect(r).toMatchObject({ status: 'created', id: 1, kind: 'meeting', rev: 1, unresolved: [] });
        expect(notes.get(conn, 1)).toMatchObject({ title: 'Garden plan', body: 'Plant beans.', kind: 'meeting', tags: ['garden', 'two-words'], pinned: false, rev: 1, created_by: 'tester', updated_by: 'tester' });
        expect(notes.get(conn, 1).chars).toBe(12);
    });

    test('title, kind, tags, body and fields are checked', () => {
        expect(code(() => mk({ title: ' ' }))).toBe('bad_title');
        expect(code(() => mk({ title: 'n'.repeat(161) }))).toBe('bad_request');
        expect(code(() => mk({ kind: 'Bad Kind' }))).toBe('bad_kind');
        expect(code(() => mk({ kind: 'k'.repeat(21) }))).toBe('bad_kind');
        expect(code(() => mk({ tags: ['ok', 'bad!'] }))).toBe('bad_tags');
        expect(code(() => mk({ tags: ['t'.repeat(31)] }))).toBe('bad_tags');
        expect(code(() => mk({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).toBe('bad_tags');
        expect(code(() => mk({ body: 'x'.repeat(100001) }))).toBe('bad_body');
        expect(code(() => mk({ body: 5 }))).toBe('bad_body');
        expect(code(() => mk({ colour: 'red' }))).toBe('bad_field');
        expect(notes.list(conn).total).toBe(0);
        expect(mk({ body: 'x'.repeat(100000) }).status).toBe('created');
    });

    test('list: pinned first then newest; filters kind, tag, q, pinned; rows have a preview and no body', () => {
        mk({ title: 'Alpha', body: '# Heading\nhello **bold** [[Beta|the b note]]', tags: ['x'] });
        mk({ title: 'Beta', kind: 'inbox', tags: ['x', 'y'] });
        mk({ title: 'Gamma', pinned: true, body: 'needle in a haystack' });
        conn.prepare("UPDATE notes SET updated_at = '2026-01-01T00:00:00.000Z' WHERE title = 'Alpha'").run();
        const all = notes.list(conn);
        expect(all.notes.map((n) => n.title)).toEqual(['Gamma', 'Beta', 'Alpha']);
        expect(all.notes[0]).not.toHaveProperty('body');
        expect(all.notes[2].preview).toBe('Heading hello bold the b note');
        expect(notes.list(conn, { kind: 'inbox' }).notes.map((n) => n.title)).toEqual(['Beta']);
        expect(notes.list(conn, { tag: 'x' }).total).toBe(2);
        expect(notes.list(conn, { tag: 'y' }).notes[0].title).toBe('Beta');
        expect(notes.list(conn, { q: 'HAYSTACK needle' }).notes.map((n) => n.title)).toEqual(['Gamma']);
        expect(notes.list(conn, { q: '100%' }).total).toBe(0);
        expect(notes.list(conn, { pinned: 'true' }).notes.map((n) => n.title)).toEqual(['Gamma']);
        expect(notes.facets(conn)).toMatchObject({ total: 3, pinned: 1, removed: 0, kinds: [{ kind: 'note', count: 2 }, { kind: 'inbox', count: 1 }], tags: [{ tag: 'x', count: 2 }, { tag: 'y', count: 1 }] });
    });

    test('get of a missing or removed id is not_found; a revision shows the note as it was', () => {
        mk();
        expect(code(() => notes.get(conn, 9))).toBe('not_found');
        notes.update(conn, 1, { body: 'Plant peas.' }, 'tester');
        expect(notes.get(conn, 1, { rev: 1 })).toMatchObject({ body: 'Plant beans.', rev: 1, revisions: 2 });
        expect(code(() => notes.get(conn, 1, { rev: 7 }))).toBe('no_revision');
    });
});

describe('edits and revisions', () => {
    test('a key edit always files a revision; no change is unchanged', () => {
        mk();
        expect(notes.update(conn, 1, { body: 'Plant peas.' }, 'agent-a')).toMatchObject({ status: 'updated', rev: 2, revised: true, fields: ['body'] });
        expect(notes.update(conn, 1, { body: 'Plant peas.', title: 'Garden plan' }, 'agent-a')).toEqual({ status: 'unchanged', id: 1, kind: 'note', rev: 2 });
        expect(code(() => notes.update(conn, 1, {}, 'agent-a'))).toBe('bad_request');
        expect(code(() => notes.update(conn, 9, { title: 'x' }, 'agent-a'))).toBe('not_found');
        expect(notes.get(conn, 1)).toMatchObject({ updated_by: 'agent-a', created_by: 'tester' });
        const h = notes.history(conn, 1);
        expect(h.map((r) => [r.rev, r.source, r.actor, r.current])).toEqual([[2, 'edit', 'agent-a', true], [1, 'create', 'tester', false]]);
        expect(h[1]).toMatchObject({ title: 'Garden plan', chars: 12 });
    });

    test('autosave: no new revision inside 5 minutes, one after; meta-only changes never revise', () => {
        mk();
        const r1 = notes.update(conn, 1, { body: 'Plant beans and peas.' }, 'admin', { autosave: true });
        expect(r1).toMatchObject({ status: 'updated', rev: 1, revised: false });
        expect(notes.update(conn, 1, { pinned: true, tags: ['a'] }, 'admin', { autosave: true })).toMatchObject({ rev: 1, revised: false });
        expect(notes.get(conn, 1)).toMatchObject({ body: 'Plant beans and peas.', pinned: true, rev: 1 });
        expect(notes.update(conn, 1, { body: 'Plant beans and peas.' }, 'admin', { autosave: true }).status).toBe('unchanged');
        conn.prepare("UPDATE note_revisions SET at = ?").run(new Date(Date.now() - notes.REVISION_GAP_MS - 1000).toISOString());
        expect(notes.update(conn, 1, { body: 'Plant beans, peas and kale.' }, 'admin', { autosave: true })).toMatchObject({ rev: 2, revised: true });
        expect(notes.history(conn, 1)[0]).toMatchObject({ rev: 2, source: 'autosave' });
    });

    test('an explicit save files a revision, also for earlier autosaved text', () => {
        mk();
        notes.update(conn, 1, { body: 'Draft one' }, 'admin', { autosave: true });
        expect(notes.update(conn, 1, { body: 'Draft one' }, 'admin', { source: 'save' })).toMatchObject({ status: 'updated', rev: 2, revised: true });
        expect(notes.history(conn, 1)[0]).toMatchObject({ rev: 2, source: 'save' });
        expect(notes.update(conn, 1, { body: 'Draft one' }, 'admin', { source: 'save' }).status).toBe('unchanged');
    });

    test('restore puts an older revision back as a new one and keeps unrevised autosaves', () => {
        mk();
        notes.update(conn, 1, { body: 'Version two' }, 'tester');
        notes.update(conn, 1, { body: 'Unrevised text' }, 'admin', { autosave: true });
        const r = notes.restore(conn, 1, 1, 'admin');
        expect(r).toMatchObject({ status: 'updated', rev: 4, fields: ['body'] });
        expect(notes.get(conn, 1)).toMatchObject({ body: 'Plant beans.', rev: 4 });
        expect(notes.get(conn, 1, { rev: 3 }).body).toBe('Unrevised text');
        expect(notes.history(conn, 1).map((x) => x.source)).toEqual(['restore', 'autosave', 'edit', 'create']);
        expect(notes.restore(conn, 1, 4, 'admin').status).toBe('unchanged');
        expect(code(() => notes.restore(conn, 1, 9, 'admin'))).toBe('no_revision');
    });

    test('append adds after a blank line and files a revision', () => {
        mk();
        expect(notes.append(conn, 1, { text: ' More beans. ' }, 'agent-a')).toMatchObject({ status: 'updated', rev: 2 });
        expect(notes.get(conn, 1).body).toBe('Plant beans.\n\nMore beans.');
        expect(code(() => notes.append(conn, 1, { text: ' ' }, 'agent-a'))).toBe('bad_request');
        expect(code(() => notes.append(conn, 1, { text: 'x'.repeat(notes.APPEND_MAX + 1) }, 'agent-a'))).toBe('bad_body');
        const empty = notes.create(conn, { title: 'Empty' }, 'tester').id;
        notes.append(conn, empty, { text: 'First line' }, 'agent-a');
        expect(notes.get(conn, empty).body).toBe('First line');
    });
});

describe('wikilinks to links', () => {
    test('resolves notes first, then entities and aliases, any case, and adds mentions rows as the writer', () => {
        const mira = ent('Mira Delgado', { aliases: ['MD'] });
        mk({ title: 'Lab trip' });
        const r = notes.create(conn, { title: 'Index', body: 'See [[lab TRIP]], [[md]] and [[Mira Delgado|Mira]].' }, 'agent-a');
        expect(r).toMatchObject({ id: 2, links: { added: 2, removed: 0, resolved: 2 }, unresolved: [] });
        expect(mentions(2)).toEqual([{ to_domain: 'notes', to_id: '1', actor: 'agent-a' }, { to_domain: 'entities', to_id: String(mira), actor: 'agent-a' }]);
        expect(links.listFor(conn, 'notes', '1').links[0]).toMatchObject({ direction: 'in', rel: 'mentions', other: { domain: 'notes', id: '2', title: 'Index' } });
    });

    test('a note beats an entity with the same name; the newest of equal notes wins and is reported', () => {
        ent('Orchard');
        mk({ title: 'Orchard' });
        mk({ title: 'orchard' });
        conn.prepare("UPDATE notes SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 2").run();
        const r = notes.create(conn, { title: 'Src', body: '[[Orchard]]' }, 'tester');
        expect(mentions(r.id)).toEqual([expect.objectContaining({ to_domain: 'notes', to_id: '1' })]);
        expect(r.ambiguous).toEqual([{ target: 'Orchard', candidates: 2, chose: 'notes:1' }]);
    });

    test('[[domain:id]] links any linkable record, an unknown id stays unresolved', () => {
        const t = trips.create(conn, { title: 'Lab visit', kind: 'work' }, 'seed').id;
        const r = notes.create(conn, { title: 'Prep', body: `Go: [[trips:${t}|the trip]], [[trips:99]], [[digests:daily/2026-11-08]]` }, 'tester');
        expect(mentions(r.id)).toEqual([{ to_domain: 'trips', to_id: String(t), actor: 'tester' }]);
        expect(r.unresolved).toEqual(['trips:99', 'digests:daily/2026-11-08']);
        expect(notes.missing(conn).missing).toEqual([]);   // references are not pages to create
    });

    test('on edit: new targets are added, dropped ones removed; other rels and incoming links are never touched', () => {
        const a = ent('Ada Voss');
        const b = ent('Bo Quill');
        mk({ title: 'Other' });
        const r = notes.create(conn, { title: 'Hub', body: '[[Ada Voss]] [[Bo Quill]]' }, 'tester').id;
        links.add(conn, { from: { domain: 'notes', id: String(r) }, to: { domain: 'entities', id: String(a) }, rel: 'about' }, 'person');
        links.add(conn, { from: { domain: 'notes', id: '1' }, to: { domain: 'notes', id: String(r) }, rel: 'mentions' }, 'person');
        const out = notes.update(conn, r, { body: '[[Ada Voss]] [[Other]]' }, 'agent-b');
        // [[Other]] already has a mentions link in the other direction: a duplicate (exists), so no second row
        expect(out.links).toEqual({ added: 0, removed: 1, resolved: 2 });
        expect(mentions(r).map((m) => `${m.to_domain}:${m.to_id}`)).toEqual([`entities:${a}`]);
        expect(conn.prepare("SELECT rel FROM links WHERE from_domain = 'notes' AND from_id = ? AND to_domain = 'entities' AND to_id = ?").all(String(r), String(a)).map((x) => x.rel).sort()).toEqual(['about', 'mentions']);
        expect(conn.prepare("SELECT COUNT(*) AS n FROM links WHERE to_domain = 'notes' AND to_id = ? AND from_id = '1'").get(String(r)).n).toBe(1);
        notes.update(conn, r, { body: 'nothing linked' }, 'agent-b');
        expect(mentions(r)).toEqual([]);
        expect(conn.prepare("SELECT COUNT(*) AS n FROM links WHERE rel = 'about'").get().n).toBe(1);
        expect(conn.prepare("SELECT COUNT(*) AS n FROM links WHERE from_id = '1' AND to_domain = 'notes'").get().n).toBe(1);
        expect(b).toBeGreaterThan(0);
    });

    test('code fences and inline code do not link; self-links are ignored', () => {
        ent('Ada Voss');
        const r = notes.create(conn, { title: 'Me', body: '[[Me]] [[notes:1]]\n```\n[[Ada Voss]]\n```\n`[[Ada Voss]]`' }, 'tester');
        expect(r).toMatchObject({ links: { added: 0, removed: 0, resolved: 0 }, unresolved: [] });
        expect(mentions(1)).toEqual([]);
    });

    test('unresolved titles are returned, listed with counts, and resolve when the page appears', () => {
        const a = notes.create(conn, { title: 'One', body: '[[Ghost page]] [[Other ghost]]' }, 'tester');
        notes.create(conn, { title: 'Two', body: 'again [[ghost PAGE]]' }, 'tester');
        expect(a.unresolved).toEqual(['Ghost page', 'Other ghost']);
        expect(notes.missing(conn).missing).toEqual([
            expect.objectContaining({ target: 'Ghost page', count: 2, notes: expect.any(Array) }), expect.objectContaining({ target: 'Other ghost', count: 1 })]);
        const g = notes.create(conn, { title: 'Ghost page' }, 'tester').id;
        expect(notes.missing(conn).missing.map((m) => m.target)).toEqual(['Other ghost']);
        expect(conn.prepare("SELECT from_id FROM links WHERE to_domain = 'notes' AND to_id = ? ORDER BY from_id").all(String(g)).map((r) => r.from_id)).toEqual(['1', '2']);
        const e = ent('Other ghost');
        expect(notes.missing(conn).missing).toEqual([]);
        notes.update(conn, 1, { body: '[[Other ghost]]' }, 'tester');
        expect(mentions(1)).toEqual([{ to_domain: 'entities', to_id: String(e), actor: 'tester' }]);
    });

    test('a key only links what it can read; plain text stays', () => {
        ent('Ada Voss');
        const r = notes.create(conn, { title: 'K', body: '[[Ada Voss]]' }, 'key-a', { visible: ['notes'] });
        expect(r.links.resolved).toBe(0);
        expect(r.unresolved).toEqual(['Ada Voss']);
        const ok = notes.create(conn, { title: 'K2', body: '[[Ada Voss]]' }, 'key-a', { visible: ['notes', 'entities'] });
        expect(ok.links.resolved).toBe(1);
        // an edit by a key that cannot see entities leaves the existing mention alone
        notes.update(conn, ok.id, { body: '[[Ada Voss]] more' }, 'key-b', { visible: ['notes'] });
        expect(mentions(ok.id)).toHaveLength(1);
    });

    test('restore re-syncs the links; renaming does not rewrite other notes but backlinks survive', () => {
        const t = mk({ title: 'Seeds' }).id;
        const src = notes.create(conn, { title: 'Src', body: '[[Seeds]]' }, 'tester').id;
        notes.update(conn, src, { body: 'none' }, 'tester');
        expect(mentions(src)).toEqual([]);
        notes.restore(conn, src, 1, 'admin');
        expect(mentions(src)).toEqual([{ to_domain: 'notes', to_id: String(t), actor: 'admin' }]);
        notes.update(conn, t, { title: 'Seed bank' }, 'tester');
        expect(notes.get(conn, src).body).toBe('[[Seeds]]');
        expect(mentions(src)).toHaveLength(1);
        expect(links.listFor(conn, 'notes', String(t)).links[0].other.title).toBe('Src');
        expect(notes.get(conn, src).wikilinks.unresolved).toEqual(['Seeds']);
    });

    test('get reports how the body resolves; resolveTargets answers for typed text', () => {
        const mira = ent('Mira Delgado');
        const n = notes.create(conn, { title: 'W', body: '[[Mira Delgado|Mira]] [[Nobody]]' }, 'tester').id;
        expect(notes.get(conn, n).wikilinks).toEqual({ resolved: [{ target: 'Mira Delgado', label: 'Mira', domain: 'entities', id: String(mira), title: 'Mira Delgado', kind: 'person' }], unresolved: ['Nobody'], ambiguous: [] });
        expect(notes.resolveTargets(conn, ['mira delgado', 'W', 'x]]y', 5], { selfId: n }).unresolved).toEqual(['x y']);
    });
});

describe('trash, delete, search and graph', () => {
    test('trash hides a note from lists, links, search and resolution; untrash brings it back', () => {
        const t = mk({ title: 'Seeds', body: 'zebra stripes' }).id;
        const src = notes.create(conn, { title: 'Src', body: '[[Seeds]]' }, 'tester').id;
        expect(notes.trash(conn, t, 'admin').status).toBe('removed');
        expect(notes.trash(conn, t, 'admin').status).toBe('unchanged');
        expect(notes.list(conn).notes.map((n) => n.title)).toEqual(['Src']);
        expect(notes.list(conn, { removed: true }).notes.map((n) => n.title)).toEqual(['Seeds']);
        expect(code(() => notes.get(conn, t))).toBe('not_found');
        expect(notes.get(conn, t, { removed: true }).removed).toBe(true);
        expect(code(() => notes.update(conn, t, { title: 'x' }, 'a'))).toBe('not_found');
        expect(search.search(conn, 'zebra').total).toBe(0);
        expect(links.listFor(conn, 'notes', String(src)).links).toEqual([]);
        expect(notes.stats(conn).records).toBe(1);
        expect(notes.untrash(conn, t, 'admin').status).toBe('restored');
        expect(search.search(conn, 'zebra').total).toBe(1);
        expect(links.listFor(conn, 'notes', String(src)).links).toHaveLength(1);
    });

    test('permanent delete needs confirm, reports the link and revision counts and takes the links with it', () => {
        const t = mk({ title: 'Seeds' }).id;
        notes.create(conn, { title: 'Src', body: '[[Seeds]]' }, 'tester');
        notes.update(conn, t, { body: 'x' }, 'tester');
        expect(code(() => notes.remove(conn, t, {}))).toBe('confirm_required');
        expect(notes.removalPreview(conn, t)).toEqual({ id: t, kind: 'note', label: 'Seeds', counts: { links: 1, revisions: 2 } });
        const out = notes.remove(conn, t, { confirm: true });
        expect(out).toMatchObject({ status: 'deleted', counts: { links: 1, revisions: 2 } });
        expect(conn.prepare('SELECT COUNT(*) AS n FROM links').get().n).toBe(0);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM note_revisions WHERE note_id = ?').get(t).n).toBe(0);
        expect(notes.removedAuditDetail(out)).toEqual({ id: t, kind: 'note', links: 1, revisions: 2 });
    });

    test('unified search finds a note by title and body with a snippet; the graph lists unlinked notes and links two wikilinks', () => {
        ent('Mira Delgado');
        const lone = mk({ title: 'Lonely page', body: 'About xylophone tuning in the attic.' }).id;
        const r = notes.create(conn, { title: 'Hub page', body: 'Talk to [[Mira Delgado]] about [[Lonely page]].' }, 'tester').id;
        const g = search.search(conn, 'xylophone').groups.find((x) => x.domain === 'notes');
        expect(g.results[0]).toMatchObject({ id: lone, title: 'Lonely page', kind: 'note' });
        expect(g.results[0].snippet).toContain('xylophone tuning');
        expect(search.search(conn, 'hub page').groups.find((x) => x.domain === 'notes').results[0].id).toBe(r);
        const n = graph.neighborhood(conn, { domain: 'notes', id: String(r) });
        expect(n.nodes.map((x) => x.key).sort()).toEqual([`entities:1`, `notes:${lone}`, `notes:${r}`].sort());
        expect(n.nodes.find((x) => x.domain === 'notes' && x.id === String(r))).toMatchObject({ title: 'Hub page', kind: 'note' });
        expect(JSON.stringify(n)).not.toMatch(/xylophone|Talk to/);
        mk({ title: 'Orphan' });
        expect(graph.unlinked(conn, { domain: 'notes' }).records.map((x) => x.title)).toEqual(['Orphan']);
    });

    test('titles and bodies never reach audit rows or error messages', () => {
        const audit = require('../services/audit');
        const r = mk({ title: 'canary-title-quartz', body: 'canary-body-quartz' });
        audit.record(conn, 'admin', 'note_created', notes.auditDetail(r), '127.0.0.1');
        const u = notes.update(conn, r.id, { body: 'canary-body-quartz two' }, 'tester');
        audit.record(conn, 'admin', 'note_updated', notes.auditDetail(u), '127.0.0.1');
        expect(JSON.stringify(conn.prepare('SELECT * FROM audit_log').all())).not.toMatch(/quartz/);
        let msg = '';
        try { notes.create(conn, { title: 'canary-title-quartz', body: 5 }, 'tester'); } catch (e) { msg = e.message + JSON.stringify(e.extra || {}); }
        expect(msg).not.toMatch(/quartz/);
    });
});
