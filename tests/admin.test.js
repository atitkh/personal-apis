const KEY = 'k'.repeat(40);
process.env.ADMIN_KEY = KEY;

const express = require('express');
const request = require('supertest');
const db = require('../db');
const adminAuth = require('../services/adminAuth');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');
const { createAdminRouter } = require('../routes/admin/admin');

const H = { 'X-Requested-With': 'hub-admin' };

function buildApp(opts) {
    const app = express();
    app.use('/admin', createAdminRouter(opts));
    return app;
}

// Signs in and returns a supertest agent that carries the session cookie.
async function signedIn(app) {
    const agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
    return agent;
}

afterAll(() => db.close());

describe('adminAuth service', () => {
    test('only a long enough ADMIN_KEY enables the dashboard', () => {
        expect(adminAuth.isEnabled()).toBe(true);
        process.env.ADMIN_KEY = 'short';
        expect(adminAuth.isEnabled()).toBe(false);
        delete process.env.ADMIN_KEY;
        expect(adminAuth.isEnabled()).toBe(false);
        process.env.ADMIN_KEY = KEY;
    });

    test('checkKey accepts the right key and nothing else', () => {
        expect(adminAuth.checkKey(KEY)).toBe(true);
        expect(adminAuth.checkKey(KEY + 'x')).toBe(false);
        expect(adminAuth.checkKey('')).toBe(false);
        expect(adminAuth.checkKey(undefined)).toBe(false);
        expect(adminAuth.checkKey({ toString: () => KEY })).toBe(false);
    });

    test('sessions store only a hash and expire', () => {
        const conn = db.get();
        const s = adminAuth.createSession(conn, { ip: '1.2.3.4' });
        expect(JSON.stringify(conn.prepare('SELECT * FROM admin_sessions').all())).not.toContain(s.token);
        expect(adminAuth.getSession(conn, s.token)).toMatchObject({ expiresAt: s.expiresAt });

        conn.prepare('UPDATE admin_sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
        expect(adminAuth.getSession(conn, s.token)).toBeNull();
        expect(adminAuth.getSession(conn, 'nope')).toBeNull();
    });

    test('destroySession ends a session', () => {
        const conn = db.get();
        const s = adminAuth.createSession(conn);
        adminAuth.destroySession(conn, s.token);
        expect(adminAuth.getSession(conn, s.token)).toBeNull();
    });
});

describe('dashboard API', () => {
    const app = buildApp({ loginMax: 1000 });

    test('is invisible when ADMIN_KEY is not set', async () => {
        delete process.env.ADMIN_KEY;
        await request(app).get('/admin/').expect(404);
        await request(app).get('/admin/api/session').expect(404);
        process.env.ADMIN_KEY = KEY;
    });

    test('serves the page with a strict CSP and no caching', async () => {
        const res = await request(app).get('/admin/').expect(200);
        expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
        expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-frame-options']).toBe('DENY');
    });

    test('data needs a session', async () => {
        for (const url of ['overview', 'keys', 'backups', 'portfolio', 'activity']) {
            await request(app).get(`/admin/api/${url}`).expect(401);
        }
    });

    test('a wrong key is refused and logged, the right key opens a session', async () => {
        await request(app).post('/admin/api/login').set(H).send({ key: 'wrong' }).expect(401);
        expect(audit.recent(db.get(), 5).map((e) => e.action)).toContain('login_failed');

        const res = await request(app).post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
        const cookie = res.headers['set-cookie'][0];
        expect(cookie).toMatch(/^hub_admin=/);
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/SameSite=Strict/);
        expect(cookie).toMatch(/Path=\/admin/);
    });

    test('changes need the X-Requested-With header', async () => {
        await request(app).post('/admin/api/login').send({ key: KEY }).expect(403);
        const agent = await signedIn(app);
        await agent.post('/admin/api/keys').send({ name: 'x', scopes: '*' }).expect(403);
    });

    test('session endpoint reports state, logout ends it', async () => {
        await request(app).get('/admin/api/session').expect(200, { authenticated: false });
        const agent = await signedIn(app);
        const me = await agent.get('/admin/api/session').expect(200);
        expect(me.body.authenticated).toBe(true);

        await agent.post('/admin/api/logout').set(H).expect(200);
        await agent.get('/admin/api/overview').expect(401);
    });

    test('overview, backups, portfolio and activity answer with data', async () => {
        const agent = await signedIn(app);

        const overview = (await agent.get('/admin/api/overview').expect(200)).body;
        expect(overview.database.status).toBe('healthy');
        expect(overview.keys).toHaveProperty('active');
        expect(overview.portfolio.entryCount).toBeGreaterThan(0);
        expect(overview.app).toHaveProperty('version');

        expect((await agent.get('/admin/api/backups').expect(200)).body).toHaveProperty('backups');

        const portfolio = (await agent.get('/admin/api/portfolio').expect(200)).body;
        expect(portfolio.rows.length).toBe(portfolio.entryCount);
        expect(portfolio.files.pages.count).toBeGreaterThan(0);

        const activity = (await agent.get('/admin/api/activity').expect(200)).body;
        expect(activity.events.some((e) => e.action === 'login')).toBe(true);
    });

    test('keys can be created (shown once), listed without the secret, and revoked', async () => {
        const agent = await signedIn(app);

        const created = (await agent.post('/admin/api/keys').set(H).send({ name: 'digest', scopes: 'digest:write' }).expect(201)).body;
        expect(created.key).toMatch(/^pak_/);

        const listed = (await agent.get('/admin/api/keys').expect(200)).body.keys;
        expect(JSON.stringify(listed)).not.toContain(created.key);
        expect(listed.find((k) => k.id === created.id)).toMatchObject({ name: 'digest', scopes: ['digest:write'] });
        expect(apiKeys.verify(db.get(), created.key)).not.toBeNull();

        await agent.post('/admin/api/keys').set(H).send({ name: 'digest', scopes: '*' }).expect(409);
        await agent.post('/admin/api/keys').set(H).send({ name: 'bad', scopes: 'nope' }).expect(400);

        await agent.delete(`/admin/api/keys/${created.id}`).set(H).expect(200);
        expect(apiKeys.verify(db.get(), created.key)).toBeNull();
        await agent.delete(`/admin/api/keys/${created.id}`).set(H).expect(404);

        const actions = audit.recent(db.get(), 20).map((e) => e.action);
        expect(actions).toEqual(expect.arrayContaining(['key_created', 'key_revoked']));
    });
});

describe('mounted in the real app', () => {
    const realApp = require('../app');

    test('/admin redirects to /admin/, which serves the page without CORS headers', async () => {
        await request(realApp).get('/admin').expect(302).expect('Location', '/admin/');
        const res = await request(realApp).get('/admin/').set('Origin', 'https://evil.example').expect(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.text).toMatch(/Personal hub/);
    });

    test('the page, script and styles are all served', async () => {
        await request(realApp).get('/admin/app.js').expect(200);
        await request(realApp).get('/admin/style.css').expect(200);
    });
});

describe('sign-in rate limit', () => {
    test('locks sign-in after a few wrong keys', async () => {
        const app = buildApp({ loginMax: 3 });
        for (let i = 0; i < 3; i++) {
            await request(app).post('/admin/api/login').set(H).send({ key: 'wrong' }).expect(401);
        }
        await request(app).post('/admin/api/login').set(H).send({ key: 'wrong' }).expect(429);
    });
});
