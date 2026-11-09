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
