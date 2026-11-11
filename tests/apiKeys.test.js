process.env.HUB_DB_FILE = ':memory:';

const express = require('express');
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const { requireScope } = require('../middleware/apiKey');

describe('scopes', () => {
    test('parseScopes accepts domain:action, domain:* and *', () => {
        expect(apiKeys.parseScopes('attendance:read, flights:*')).toEqual(['attendance:read', 'flights:*']);
        expect(apiKeys.parseScopes(['*'])).toEqual(['*']);
    });

    test('parseScopes rejects empty and malformed scopes', () => {
        expect(() => apiKeys.parseScopes('')).toThrow();
        expect(() => apiKeys.parseScopes('attendance')).toThrow(/Invalid scope/);
        expect(() => apiKeys.parseScopes('Attendance:Read')).toThrow(/Invalid scope/);
    });

    test('hasScope matches exact, domain wildcard and global', () => {
        expect(apiKeys.hasScope(['attendance:read'], 'attendance:read')).toBe(true);
        expect(apiKeys.hasScope(['attendance:read'], 'attendance:write')).toBe(false);
        expect(apiKeys.hasScope(['attendance:*'], 'attendance:write')).toBe(true);
        expect(apiKeys.hasScope(['attendance:*'], 'flights:read')).toBe(false);
        expect(apiKeys.hasScope(['*'], 'anything:at-all')).toBe(true);
    });
});

describe('key lifecycle', () => {
    let conn;
    beforeEach(() => {
        conn = db.open(':memory:');
    });
    afterEach(() => conn.close());

    test('create stores only a hash and verify finds the key', () => {
        const k = apiKeys.create(conn, { name: 'ha', scopes: 'attendance:read' });
        expect(k.key).toMatch(/^pak_/);
        const stored = conn.prepare('SELECT * FROM api_keys WHERE id = ?').get(k.id);
        expect(JSON.stringify(stored)).not.toContain(k.key);
        expect(apiKeys.verify(conn, k.key)).toMatchObject({ id: k.id, name: 'ha', scopes: ['attendance:read'] });
    });

    test('unknown and malformed keys do not verify', () => {
        expect(apiKeys.verify(conn, 'pak_nope')).toBeNull();
        expect(apiKeys.verify(conn, 'nope')).toBeNull();
        expect(apiKeys.verify(conn, undefined)).toBeNull();
    });

    test('revoked keys stop working and the name can be reused', () => {
        const k = apiKeys.create(conn, { name: 'axis', scopes: '*' });
        expect(apiKeys.revoke(conn, 'axis')).toBe(true);
        expect(apiKeys.verify(conn, k.key)).toBeNull();
        expect(apiKeys.revoke(conn, 'axis')).toBe(false);
        expect(() => apiKeys.create(conn, { name: 'axis', scopes: '*' })).not.toThrow();
    });

    test('an active name cannot be duplicated', () => {
        apiKeys.create(conn, { name: 'digest', scopes: 'digest:write' });
        expect(() => apiKeys.create(conn, { name: 'digest', scopes: 'digest:write' })).toThrow();
    });

    test('list never exposes hashes or keys', () => {
        const k = apiKeys.create(conn, { name: 'a', scopes: '*' });
        const rows = apiKeys.list(conn);
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toContain(k.key);
        expect(rows[0]).not.toHaveProperty('key_hash');
    });

    test('migrations are idempotent', () => {
        expect(() => db.migrate(conn)).not.toThrow();
        expect(conn.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n).toBeGreaterThan(0);
    });
});

describe('requireScope middleware', () => {
    const app = express();
    app.get('/read', requireScope('attendance:read'), (req, res) => res.json({ who: req.apiKey.name }));
    let keys;

    beforeAll(() => {
        const shared = db.get();
        keys = {
            reader: apiKeys.create(shared, { name: 'reader', scopes: 'attendance:read' }).key,
            other: apiKeys.create(shared, { name: 'other', scopes: 'flights:read' }).key,
        };
    });
    afterAll(() => db.close());

    test('401 without a key', async () => {
        await request(app).get('/read').expect(401);
    });

    test('401 with a wrong key', async () => {
        await request(app).get('/read').set('x-api-key', 'pak_wrong').expect(401);
    });

    test('403 when the scope is missing', async () => {
        await request(app).get('/read').set('Authorization', `Bearer ${keys.other}`).expect(403);
    });

    test('200 with a Bearer key or x-api-key that has the scope', async () => {
        await request(app).get('/read').set('Authorization', `Bearer ${keys.reader}`).expect(200, { who: 'reader' });
        await request(app).get('/read').set('x-api-key', keys.reader).expect(200, { who: 'reader' });
    });
});

describe('editing a key in place', () => {
    let conn;
    beforeEach(() => { conn = db.open(':memory:'); });
    afterEach(() => conn.close());
    const status = (fn) => { try { fn(); } catch (err) { return err.status; } return null; };

    test('changes scopes and name, keeps the secret, reports added and removed names', () => {
        const k = apiKeys.create(conn, { name: 'agent', scopes: 'places:read, places:edit' });
        const out = apiKeys.update(conn, k.id, { name: 'agent-2', scopes: ['places:read', 'flights:observe'] });
        expect(out.key).toMatchObject({ id: k.id, name: 'agent-2', scopes: ['places:read', 'flights:observe'] });
        expect(out.added).toEqual(['flights:observe']);
        expect(out.removed).toEqual(['places:edit']);
        expect(out.renamedFrom).toBe('agent');
        expect(JSON.stringify(out)).not.toContain(k.key);
        expect(apiKeys.verify(conn, k.key)).toMatchObject({ id: k.id, name: 'agent-2', scopes: ['places:read', 'flights:observe'] });
    });

    test('name alone or scopes alone leaves the other as it was', () => {
        const k = apiKeys.create(conn, { name: 'a', scopes: 'places:read' });
        expect(apiKeys.update(conn, k.id, { name: 'b' }).key).toMatchObject({ name: 'b', scopes: ['places:read'] });
        const out = apiKeys.update(conn, k.id, { scopes: 'digests:read' });
        expect(out.key).toMatchObject({ name: 'b', scopes: ['digests:read'] });
        expect(out.renamedFrom).toBeNull();
    });

    test('rejects empty or malformed scopes, bad names, nothing to change (400)', () => {
        const k = apiKeys.create(conn, { name: 'a', scopes: 'places:read' });
        expect(status(() => apiKeys.update(conn, k.id, { scopes: [] }))).toBe(400);
        expect(status(() => apiKeys.update(conn, k.id, { scopes: '' }))).toBe(400);
        expect(status(() => apiKeys.update(conn, k.id, { scopes: ['nope'] }))).toBe(400);
        expect(status(() => apiKeys.update(conn, k.id, { name: '   ' }))).toBe(400);
        expect(status(() => apiKeys.update(conn, k.id, { name: 'x'.repeat(61) }))).toBe(400);
        expect(status(() => apiKeys.update(conn, k.id, {}))).toBe(400);
        expect(apiKeys.get(conn, k.id).scopes).toEqual(['places:read']);
    });

    test('a revoked key cannot be edited (409), an unknown id is 404', () => {
        const k = apiKeys.create(conn, { name: 'gone', scopes: 'places:read' });
        apiKeys.revoke(conn, k.id);
        expect(status(() => apiKeys.update(conn, k.id, { scopes: 'digests:read' }))).toBe(409);
        expect(status(() => apiKeys.update(conn, 9999, { name: 'x' }))).toBe(404);
        expect(status(() => apiKeys.update(conn, NaN, { name: 'x' }))).toBe(404);
    });

    test('the name stays unique among live keys (409) but may reuse a revoked one', () => {
        const a = apiKeys.create(conn, { name: 'a', scopes: 'places:read' });
        const b = apiKeys.create(conn, { name: 'b', scopes: 'places:read' });
        expect(status(() => apiKeys.update(conn, b.id, { name: 'a' }))).toBe(409);
        apiKeys.revoke(conn, a.id);
        expect(apiKeys.update(conn, b.id, { name: 'a' }).key.name).toBe('a');
        expect(apiKeys.update(conn, b.id, { name: 'a', scopes: 'places:read' }).key.name).toBe('a'); // its own name is fine
    });

    test('granting "*" needs confirmAll; a key that already has it can be renamed without', () => {
        const k = apiKeys.create(conn, { name: 'a', scopes: 'places:read' });
        expect(status(() => apiKeys.update(conn, k.id, { scopes: ['*'] }))).toBe(400);
        expect(status(() => apiKeys.update(conn, k.id, { scopes: ['*'], confirmAll: 'yes' }))).toBe(400);
        expect(apiKeys.update(conn, k.id, { scopes: ['*'], confirmAll: true }).key.scopes).toEqual(['*']);
        expect(apiKeys.update(conn, k.id, { name: 'renamed', scopes: ['*'] }).key.name).toBe('renamed');
        expect(apiKeys.update(conn, k.id, { scopes: ['places:read'] }).removed).toEqual(['*']); // narrowing never needs it
    });

    test('keeps scopes that are not in the catalogue as they are', () => {
        const k = apiKeys.create(conn, { name: 'old', scopes: 'attendance:read, notes:*' });
        const out = apiKeys.update(conn, k.id, { scopes: ['attendance:read', 'notes:*', 'places:read'] });
        expect(out.added).toEqual(['places:read']);
        expect(out.removed).toEqual([]);
    });
});

describe('a scope change applies to the key\'s very next request', () => {
    const app = require('../app');
    test('same secret: 200 before, 403 after, 200 again', async () => {
        const conn = db.get();
        const k = apiKeys.create(conn, { name: 'live-edit', scopes: 'places:read' });
        const get = (path) => request(app).get(path).set('Authorization', `Bearer ${k.key}`);
        await get('/hub/places').expect(200);
        await get('/hub/digests/recent').expect(403);
        apiKeys.update(conn, k.id, { scopes: 'digests:read' });
        await get('/hub/places').expect(403);
        await get('/hub/digests/recent').expect(200);
        apiKeys.update(conn, k.id, { scopes: ['places:read', 'digests:read'] });
        await get('/hub/places').expect(200);
        apiKeys.revoke(conn, k.id);
        await get('/hub/places').expect(401);
        db.close();
    });
});
