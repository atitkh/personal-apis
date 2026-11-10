process.env.HUB_DB_FILE = ':memory:';

const db = require('../db');
const digests = require('../services/digests');
const domains = require('../services/domains');
const { digestWatch } = require('../services/adminStats');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const put = (period, body, extra = {}) => digests.put(conn, 'daily', period, { body, actor: 'digest-job', ...extra });

describe('put', () => {
    test('creates a digest, strips the file heading and keeps revision 1', () => {
        expect(put('2026-11-08', '# 2026-11-08\n\nAtit worked on the hub.\n', { model: 'bonsai2', meta: { sources: { ha: 'ok' } } }))
            .toEqual({ status: 'created', rev: 1 });
        const d = digests.get(conn, 'daily', '2026-11-08');
        expect(d).toMatchObject({ rev: 1, body: 'Atit worked on the hub.', source: 'generated', actor: 'digest-job', model: 'bonsai2', meta: { sources: { ha: 'ok' } } });
    });

    test('is safe to repeat: same text is unchanged, new text is a new revision', () => {
        put('2026-11-08', 'first');
        expect(put('2026-11-08', 'first').status).toBe('unchanged');
        expect(put('2026-11-08', 'second')).toEqual({ status: 'updated', rev: 2 });
        expect(digests.get(conn, 'daily', '2026-11-08', { rev: 1 }).body).toBe('first');
        expect(digests.get(conn, 'daily', '2026-11-08').body).toBe('second');
    });

    test('import is recorded as its own source', () => {
        put('2026-10-01', 'old file', { source: 'import', actor: 'importer' });
        expect(digests.get(conn, 'daily', '2026-10-01').source).toBe('import');
    });

    test('an imported file keeps its original time, other sources cannot backdate', () => {
        put('2026-10-01', 'from a file', { source: 'import', actor: 'importer', at: '2026-10-01T23:20:00Z' });
        expect(digests.get(conn, 'daily', '2026-10-01')).toMatchObject({ revisedAt: '2026-10-01T23:20:00.000Z', createdAt: '2026-10-01T23:20:00.000Z' });

        put('2026-10-02', 'generated tonight', { at: '2020-01-01T00:00:00Z' });
        expect(digests.get(conn, 'daily', '2026-10-02').revisedAt.startsWith('2020')).toBe(false);
        put('2026-10-03', 'bad stamp', { source: 'import', at: 'not a date' });
        expect(Date.now() - Date.parse(digests.get(conn, 'daily', '2026-10-03').revisedAt)).toBeLessThan(5000);
    });

    test('rejects bad kinds, periods, sources and bodies', () => {
        expect(() => digests.put(conn, 'yearly', '2026', { body: 'x', actor: 'a' })).toThrow(/Kind must be/);
        expect(() => put('2026-13-40', 'x')).toThrow(/not a real date|looks like/);
        expect(() => put('11-08-2026', 'x')).toThrow(/looks like/);
        expect(() => digests.put(conn, 'weekly', '2026-11-08', { body: 'x', actor: 'a' })).toThrow(/looks like/);
        expect(() => put('2026-11-08', '   ')).toThrow(/empty/);
        expect(() => put('2026-11-08', 'x', { source: 'edit' })).toThrow(/source must be/);
        expect(() => put('2026-11-08', 'x'.repeat(70 * 1024))).toThrow(/64 KB/);
        expect(() => put('2026-11-08', 'x', { meta: 'nope' })).toThrow(/meta must be an object/);
    });

    test('weekly digests use ISO week periods', () => {
        expect(digests.put(conn, 'weekly', '2026-W45', { body: 'a week', actor: 'weekly' }).status).toBe('created');
        expect(digests.get(conn, 'weekly', '2026-W45').body).toBe('a week');
    });
});

describe('human edits', () => {
    test('an edit adds a revision and generated reruns cannot overwrite it', () => {
        put('2026-11-08', 'generated');
        expect(digests.edit(conn, 'daily', '2026-11-08', { body: 'fixed by hand', actor: 'admin', note: 'wrong place' })).toEqual({ status: 'updated', rev: 2 });

        expect(() => put('2026-11-08', 'generated again')).toThrow(/edited by hand/);
        try { put('2026-11-08', 'generated again'); } catch (e) { expect(e.status).toBe(409); expect(e.code).toBe('edited'); }
        expect(put('2026-11-08', 'fixed by hand').status).toBe('unchanged');

        expect(put('2026-11-08', 'forced', { force: true }).status).toBe('updated');
        expect(digests.get(conn, 'daily', '2026-11-08').body).toBe('forced');
    });

    test('editing something that does not exist is a 404, and the same text is unchanged', () => {
        expect(() => digests.edit(conn, 'daily', '2026-11-08', { body: 'x', actor: 'admin' })).toThrow(/No daily digest/);
        put('2026-11-08', 'same');
        expect(digests.edit(conn, 'daily', '2026-11-08', { body: 'same', actor: 'admin' }).status).toBe('unchanged');
    });

    test('history lists every revision with who made it, newest first', () => {
        put('2026-11-08', 'v1');
        digests.edit(conn, 'daily', '2026-11-08', { body: 'v2', actor: 'admin', note: 'tidy' });
        const h = digests.revisions(conn, 'daily', '2026-11-08');
        expect(h.map((r) => [r.rev, r.source, r.actor, r.current])).toEqual([[2, 'edit', 'admin', true], [1, 'generated', 'digest-job', false]]);
        expect(h[0].note).toBe('tidy');
    });

    test('restore copies an old revision forward as a new one', () => {
        put('2026-11-08', 'original');
        digests.edit(conn, 'daily', '2026-11-08', { body: 'changed', actor: 'admin' });
        expect(digests.restore(conn, 'daily', '2026-11-08', 1, 'admin')).toEqual({ status: 'updated', rev: 3 });
        const d = digests.get(conn, 'daily', '2026-11-08');
        expect(d).toMatchObject({ rev: 3, body: 'original', source: 'restore', note: 'Restored revision 1' });
        expect(digests.restore(conn, 'daily', '2026-11-08', 3, 'admin').status).toBe('unchanged');
        expect(() => digests.restore(conn, 'daily', '2026-11-08', 99, 'admin')).toThrow(/does not exist/);
    });
});

describe('reading', () => {
    beforeEach(() => {
        put('2026-11-06', 'Slept in and then walked to campus for the Tuesday seminar.');
        put('2026-11-07', 'Spent the evening on the Axis Quest client.');
        put('2026-11-08', 'Drove to Fort Worth and reached the brother\'s place after midnight.');
        digests.put(conn, 'weekly', '2026-W45', { body: 'A week of Axis work.', actor: 'weekly' });
    });

    test('list is newest first, filters by kind and range, and leaves the text out', () => {
        const all = digests.list(conn, { kind: 'daily' });
        expect(all.map((d) => d.period)).toEqual(['2026-11-08', '2026-11-07', '2026-11-06']);
        expect(all[0]).not.toHaveProperty('body');
        expect(digests.list(conn, { kind: 'daily', from: '2026-11-07', to: '2026-11-07' }).map((d) => d.period)).toEqual(['2026-11-07']);
        expect(digests.list(conn, {}).length).toBe(4);
        expect(digests.list(conn, { kind: 'daily', limit: 1 })).toHaveLength(1);
    });

    test('latest, recent and range return text', () => {
        expect(digests.latest(conn, 'daily').period).toBe('2026-11-08');
        expect(digests.latest(conn, 'weekly').period).toBe('2026-W45');
        expect(digests.recent(conn, 'daily', 2).map((d) => d.period)).toEqual(['2026-11-08', '2026-11-07']);
        expect(digests.range(conn, 'daily', '2026-11-06', '2026-11-07').map((d) => d.period)).toEqual(['2026-11-06', '2026-11-07']);
        expect(digests.range(conn, 'daily', '2026-11-06', '2026-11-07')[0].body).toMatch(/seminar/);
    });

    test('a missing digest or an empty kind is a 404', () => {
        expect(() => digests.get(conn, 'daily', '2026-01-01')).toThrow(/No daily digest/);
        conn.exec('DELETE FROM digests');
        expect(() => digests.latest(conn, 'daily')).toThrow(/no daily digest yet/);
    });

    test('search finds words, follows word stems, and survives odd input', () => {
        expect(digests.search(conn, 'seminar').map((r) => r.period)).toEqual(['2026-11-06']);
        expect(digests.search(conn, 'walking').map((r) => r.period)).toEqual(['2026-11-06']); // matches "walked"
        expect(digests.search(conn, 'axis', { kind: 'weekly' }).map((r) => r.period)).toEqual(['2026-W45']);
        expect(digests.search(conn, 'Fort Worth')[0].snippet).toMatch(/\[Fort\]/);
        expect(() => digests.search(conn, '"unterminated AND OR (')).not.toThrow();
        expect(() => digests.search(conn, '   ')).toThrow(/at least one word/);
    });

    test('search follows edits: old words disappear, new words appear', () => {
        digests.edit(conn, 'daily', '2026-11-06', { body: 'Only a museum visit.', actor: 'admin' });
        expect(digests.search(conn, 'seminar')).toEqual([]);
        expect(digests.search(conn, 'museum').map((r) => r.period)).toEqual(['2026-11-06']);
    });

    test('stats count digests', () => {
        expect(digests.stats(conn)).toMatchObject({ records: 4, label: 'digests' });
    });
});

describe('domains', () => {
    test('digests, places, portfolio and flights are registered, on by default', () => {
        const list = domains.list(conn);
        expect(list.map((d) => d.name).sort()).toEqual(['digests', 'flights', 'places', 'portfolio']);
        expect(list.find((d) => d.name === 'digests')).toMatchObject({ sensitivity: 'private', storage: 'db', enabled: true });
        expect(list.find((d) => d.name === 'portfolio')).toMatchObject({ sensitivity: 'public', storage: 'files', enabled: true });
        expect(list.find((d) => d.name === 'portfolio').confirmOff).toMatch(/public portfolio/);
    });

    test('switching off sticks, survives a re-sync, and keeps the data', () => {
        put('2026-11-08', 'kept');
        domains.setEnabled(conn, 'digests', false, 'admin');
        expect(domains.isEnabled(conn, 'digests')).toBe(false);
        domains.sync(conn);
        expect(domains.isEnabled(conn, 'digests')).toBe(false);
        expect(digests.get(conn, 'daily', '2026-11-08').body).toBe('kept');
        domains.setEnabled(conn, 'digests', true, 'admin');
        expect(domains.isEnabled(conn, 'digests')).toBe(true);
    });

    test('unknown domains cannot be toggled and are never enabled', () => {
        expect(() => domains.setEnabled(conn, 'nope', true, 'admin')).toThrow(/Unknown domain/);
        expect(domains.isEnabled(conn, 'nope')).toBe(false);
    });

    test('an unreadable database falls back to the declared default', () => {
        const broken = { prepare() { throw new Error('disk gone'); } };
        expect(domains.isEnabled(broken, 'portfolio')).toBe(true);
    });
});

describe('missing-digest watch', () => {
    const noon = new Date('2026-11-09T18:00:00Z'); // 12:00 in Chicago, so 2026-11-08 is expected
    const night = new Date('2026-11-09T08:00:00Z'); // 02:00 in Chicago, too early to expect anything

    test('quiet before any digest has ever arrived', () => {
        expect(digestWatch(conn, noon)).toMatchObject({ missing: false, dailyCount: 0, expectedDaily: '2026-11-08' });
    });

    test('warns when yesterday is missing, quiet once it exists or when it is too early', () => {
        put('2026-11-01', 'older');
        expect(digestWatch(conn, noon)).toMatchObject({ missing: true, latestDaily: '2026-11-01' });
        expect(digestWatch(conn, night)).toMatchObject({ missing: false, expectedDaily: null });
        put('2026-11-08', 'yesterday');
        expect(digestWatch(conn, noon).missing).toBe(false);
    });

    test('does not warn while the domain is switched off', () => {
        put('2026-11-01', 'older');
        domains.setEnabled(conn, 'digests', false, 'admin');
        expect(digestWatch(conn, noon).missing).toBe(false);
    });
});
