// Unit tests for the shared helpers in services/lib and routes/lib.
const Database = require('better-sqlite3');
const { toId, text, oneOf } = require('../services/lib/validate');
const { clampLimit, limitOrDefault, clampOffset } = require('../services/lib/listing');
const { needRow, commitRevision, findRevision } = require('../services/lib/revisions');
const { adminHandler, hubHandle } = require('../routes/lib/handle');
const { adminChanged, keyChanged } = require('../routes/lib/changed');
const { HubError } = require('../services/errors');

class TestError extends HubError {
    constructor(status, code, message, extra) { super(status, code, message); if (extra) this.extra = extra; }
}
const bad = (code, message, status = 400, extra) => new TestError(status, code, message, extra);

describe('validate', () => {
    test('toId takes positive safe integers and digit strings only', () => {
        expect(toId(5)).toBe(5);
        expect(toId('12')).toBe(12);
        for (const v of [0, '0', -1, '-1', 1.5, '1.5', 'x', null, undefined, '', Number.MAX_SAFE_INTEGER + 2]) expect(toId(v)).toBeNull();
    });

    test('text: missing and blank are null, numbers are text, normalised and trimmed', () => {
        expect(text(bad, undefined, 'a', 5)).toBeNull();
        expect(text(bad, null, 'a', 5)).toBeNull();
        expect(text(bad, '   ', 'a', 5)).toBeNull();
        expect(text(bad, 42, 'a', 5)).toBe('42');
        expect(text(bad, '  ab  c ', 'a', 10)).toBe('ab  c');
        expect(text(bad, 'ａｂ', 'a', 10)).toBe('ab');
    });

    test('text: upper and collapse options', () => {
        expect(text(bad, 'aa', 'a', 5, { upper: true })).toBe('AA');
        expect(text(bad, ' a \n  b ', 'a', 5, { collapse: true })).toBe('a b');
    });

    test('text errors: message, code, status and the optional field extra', () => {
        expect(() => text(bad, {}, 'name', 5)).toThrow('name must be text.');
        expect(() => text(bad, 'abcdef', 'name', 5)).toThrow('name is longer than 5 characters.');
        try { text(bad, {}, 'name', 5); } catch (e) { expect([e.status, e.code, e.extra]).toEqual([400, 'bad_request', undefined]); }
        try { text(bad, 'abcdef', 'name', 5, { field: true }); } catch (e) { expect(e.extra).toEqual({ field: 'name' }); }
    });

    test('oneOf returns the value or throws bad_<name>', () => {
        expect(oneOf(bad, 'a', 'kind', ['a', 'b'])).toBe('a');
        try { oneOf(bad, 'c', 'kind', ['a', 'b']); throw new Error('no throw'); } catch (e) {
            expect(e.code).toBe('bad_kind');
            expect(e.message).toBe('kind must be one of: a, b.');
        }
    });
});

describe('listing', () => {
    test('clampLimit: junk and 0 mean the default; the rest is clamped', () => {
        expect(clampLimit(undefined, 50, 500)).toBe(50);
        expect(clampLimit('abc', 50, 500)).toBe(50);
        expect(clampLimit(0, 50, 500)).toBe(50);
        expect(clampLimit(-5, 50, 500)).toBe(1);
        expect(clampLimit('7', 50, 500)).toBe(7);
        expect(clampLimit(9999, 50, 500)).toBe(500);
    });

    test('limitOrDefault: only junk means the default, and 0 clamps to 1', () => {
        expect(limitOrDefault(undefined, 50, 200)).toBe(50);
        expect(limitOrDefault('x', 50, 200)).toBe(50);
        expect(limitOrDefault(0, 50, 200)).toBe(1);
        expect(limitOrDefault(9999, 50, 200)).toBe(200);
    });

    test('clampOffset', () => {
        expect(clampOffset(undefined)).toBe(0);
        expect(clampOffset('-3')).toBe(0);
        expect(clampOffset('8')).toBe(8);
    });
});

describe('revisions', () => {
    const spec = { table: 'things', revTable: 'thing_revisions', fk: 'thing_id' };
    let conn;
    beforeEach(() => {
        conn = new Database(':memory:');
        conn.exec(`CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, current_rev INTEGER DEFAULT 0, updated_at TEXT, updated_by TEXT);
            CREATE TABLE thing_revisions (thing_id INTEGER, rev INTEGER, snapshot TEXT, source TEXT, actor TEXT, note TEXT, at TEXT);
            INSERT INTO things (id, name) VALUES (1, 'one');`);
    });
    afterEach(() => conn.close());

    test('needRow finds a row by id or throws the caller\'s error', () => {
        const fail = () => bad('not_found', 'nope', 404);
        expect(needRow(conn, 'things', '1', fail).name).toBe('one');
        expect(() => needRow(conn, 'things', 2, fail)).toThrow('nope');
        expect(() => needRow(conn, 'things', 'x', fail)).toThrow('nope');
    });

    test('commitRevision stores the snapshot, bumps current_rev and names the actor', () => {
        const snap = (row) => ({ name: row.name });
        expect(commitRevision(conn, spec, 1, { source: 'create', actor: 'admin' }, snap)).toBe(1);
        conn.prepare('UPDATE things SET name = ? WHERE id = 1').run('two');
        expect(commitRevision(conn, spec, 1, { source: 'edit', actor: '', note: 'n' }, snap)).toBe(2);
        const row = conn.prepare('SELECT * FROM things WHERE id = 1').get();
        expect([row.current_rev, row.updated_by]).toEqual([2, 'unknown']);
        const revs = conn.prepare('SELECT * FROM thing_revisions ORDER BY rev').all();
        expect(revs.map((r) => [r.rev, r.snapshot, r.source, r.actor, r.note])).toEqual([
            [1, '{"name":"one"}', 'create', 'admin', null],
            [2, '{"name":"two"}', 'edit', 'unknown', 'n'],
        ]);
    });

    test('findRevision by number or digits; unknown or junk gives undefined', () => {
        commitRevision(conn, spec, 1, { source: 'create', actor: 'a' }, () => ({}));
        expect(findRevision(conn, spec, 1, 1).rev).toBe(1);
        expect(findRevision(conn, spec, 1, '1').rev).toBe(1);
        expect(findRevision(conn, spec, 1, 2)).toBeUndefined();
        expect(findRevision(conn, spec, 1, 'x')).toBeUndefined();
    });
});

function fakeRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

describe('handle', () => {
    let errSpy;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => errSpy.mockRestore());

    test('adminHandler answers a domain error with its status, message and optional code and extra', () => {
        const err = new TestError(409, 'exists', 'already there', { id: 3 });
        const run = (opts) => { const res = fakeRes(); adminHandler(TestError, 'x:', opts)(() => { throw err; })({}, res); return res; };
        expect(run({ code: false })).toMatchObject({ statusCode: 409, body: { error: 'already there' } });
        expect(run({ code: false }).body).toEqual({ error: 'already there' });
        expect(run({}).body).toEqual({ error: 'already there', code: 'exists' });
        expect(run({ extra: true }).body).toEqual({ error: 'already there', code: 'exists', id: 3 });
    });

    test('adminHandler turns other errors into a logged 500, and handles async rejections only when asked', async () => {
        const res = fakeRes();
        adminHandler(TestError, 'admin test error:')(() => { throw new Error('boom'); })({}, res);
        expect([res.statusCode, res.body]).toEqual([500, { error: 'Something went wrong.' }]);
        expect(errSpy).toHaveBeenCalledWith('admin test error:', expect.any(Error));

        const res2 = fakeRes();
        adminHandler(TestError, 'x:', { async: true })(async () => { throw new TestError(404, 'nf', 'missing'); })({}, res2);
        await new Promise((r) => setImmediate(r));
        expect([res2.statusCode, res2.body]).toEqual([404, { error: 'missing', code: 'nf' }]);
    });

    test('hubHandle: HubError becomes { error: code, message, ...extra }, anything else a 500', async () => {
        const res = fakeRes();
        hubHandle(() => { throw new TestError(409, 'exists', 'dup', { id: 7 }); })({}, res);
        expect([res.statusCode, res.body]).toEqual([409, { error: 'exists', message: 'dup', id: 7 }]);
        const res2 = fakeRes();
        hubHandle(async () => { throw new Error('boom'); })({}, res2);
        await new Promise((r) => setImmediate(r));
        expect([res2.statusCode, res2.body]).toEqual([500, { error: 'server_error', message: 'Something went wrong.' }]);
    });
});

describe('changed', () => {
    const detail = (r) => ({ id: r.id });
    const db = require('../db');

    test('adminChanged audits as admin unless unchanged, and always answers', () => {
        const conn = db.get();
        const before = conn.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get('thing_made').n;
        const res = fakeRes();
        adminChanged(detail)({ ip: '1.2.3.4' }, res, conn, 'thing_made', { status: 'created', id: 9 }, 201);
        expect([res.statusCode, res.body]).toEqual([201, { status: 'created', id: 9 }]);
        const row = conn.prepare('SELECT actor, detail, ip FROM audit_log WHERE action = ? ORDER BY id DESC').get('thing_made');
        expect([row.actor, JSON.parse(row.detail), row.ip]).toEqual(['admin', { id: 9 }, '1.2.3.4']);
        const res2 = fakeRes();
        adminChanged(detail)({ ip: 'x' }, res2, conn, 'thing_made', { status: 'unchanged', id: 9 });
        expect(res2.statusCode).toBe(200);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get('thing_made').n).toBe(before + 1);
    });

    test('keyChanged audits under the key name with key_id', () => {
        const conn = db.get();
        keyChanged(detail)({ ip: null, apiKey: { id: 4, name: 'job' } }, fakeRes(), conn, 'thing_keyed', { status: 'updated', id: 2 });
        const row = conn.prepare('SELECT actor, detail FROM audit_log WHERE action = ?').get('thing_keyed');
        expect([row.actor, JSON.parse(row.detail)]).toEqual(['job', { id: 2, key_id: 4 }]);
    });
});
