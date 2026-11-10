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

    test('the CSP allows self-hosted fonts and nothing from elsewhere', async () => {
        const csp = (await request(app).get('/admin/').expect(200)).headers['content-security-policy'];
        expect(csp).toMatch(/default-src 'none'/);
        expect(csp).toMatch(/font-src 'self'(;|$)/);
        expect(csp).not.toMatch(/https?:|\*|unsafe-inline|unsafe-eval/);
    });

    test('serves fonts and ES modules with the right types', async () => {
        const font = await request(app).get('/admin/fonts/instrument-sans-latin-wght-normal.woff2').expect(200);
        expect(font.headers['content-type']).toMatch(/font\/woff2/);
        await request(app).get('/admin/fonts/source-serif-4-latin-wght-normal.woff2').expect(200);
        for (const file of ['app.js', 'router.js', 'ui.js', 'views/overview.js']) {
            const res = await request(app).get(`/admin/${file}`).expect(200);
            expect(res.headers['content-type']).toMatch(/javascript/);
        }
        const page = await request(app).get('/admin/').expect(200);
        expect(page.text).toMatch(/<script type="module" src="app.js">/);
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

describe('dashboard: domains and digests', () => {
    const app = buildApp({ loginMax: 1000 });
    const digests = require('../services/digests');
    const domains = require('../services/domains');

    beforeAll(() => {
        digests.put(db.get(), 'daily', '2026-11-08', { body: 'Generated text about the hub.', actor: 'digest-job' });
    });

    test('overview carries the domain list and the digest watch', async () => {
        const agent = await signedIn(app);
        const o = (await agent.get('/admin/api/overview').expect(200)).body;
        expect(o.domains.map((d) => d.name).sort()).toEqual(['digests', 'portfolio']);
        expect(o.digests).toHaveProperty('missing');
        expect(o.digests.dailyCount).toBeGreaterThan(0);
    });

    test('domains can be switched off and on, and it is audited', async () => {
        const agent = await signedIn(app);
        await agent.put('/admin/api/domains/digests').send({ enabled: false }).expect(403); // needs the header
        await agent.put('/admin/api/domains/digests').set(H).send({ enabled: false }).expect(200);
        expect((await agent.get('/admin/api/domains').expect(200)).body.domains.find((d) => d.name === 'digests').enabled).toBe(false);

        // the dashboard still reaches the data while the domain is off
        await agent.get('/admin/api/digests/daily/2026-11-08').expect(200);

        await agent.put('/admin/api/domains/digests').set(H).send({ enabled: true }).expect(200);
        await agent.put('/admin/api/domains/nope').set(H).send({ enabled: true }).expect(404);
        await agent.put('/admin/api/domains/digests').set(H).send({ enabled: 'yes' }).expect(400);
        expect(domains.isEnabled(db.get(), 'digests')).toBe(true);
        expect(audit.recent(db.get(), 10).map((e) => e.action)).toEqual(expect.arrayContaining(['domain_disabled', 'domain_enabled']));
    });

    test('digests can be listed, searched, read with history, edited and restored', async () => {
        const agent = await signedIn(app);

        const list = (await agent.get('/admin/api/digests?kind=daily').expect(200)).body.digests;
        expect(list[0]).toMatchObject({ kind: 'daily', period: '2026-11-08' });
        expect((await agent.get('/admin/api/digests?q=hub').expect(200)).body.results[0].period).toBe('2026-11-08');

        const one = (await agent.get('/admin/api/digests/daily/2026-11-08').expect(200)).body;
        expect(one).toMatchObject({ rev: 1, body: 'Generated text about the hub.' });
        expect(one.history).toHaveLength(1);

        await agent.patch('/admin/api/digests/daily/2026-11-08').send({ body: 'x' }).expect(403);
        const edited = (await agent.patch('/admin/api/digests/daily/2026-11-08').set(H).send({ body: 'Corrected text.', note: 'fix' }).expect(200)).body;
        expect(edited).toEqual({ status: 'updated', rev: 2 });
        const after = (await agent.get('/admin/api/digests/daily/2026-11-08').expect(200)).body;
        expect(after.history.map((r) => [r.rev, r.actor])).toEqual([[2, 'admin'], [1, 'digest-job']]);

        await agent.post('/admin/api/digests/daily/2026-11-08/restore').set(H).send({ rev: 1 }).expect(200);
        expect((await agent.get('/admin/api/digests/daily/2026-11-08').expect(200)).body.body).toBe('Generated text about the hub.');
        await agent.get('/admin/api/digests/daily/2020-01-01').expect(404);
        expect(audit.recent(db.get(), 10).map((e) => e.action)).toEqual(expect.arrayContaining(['digest_edited', 'digest_restored']));
    });
});

describe('dashboard: coverage, manual backup, activity', () => {
    test('overview reports which of the last 30 days have a daily digest', async () => {
        const app = buildApp();
        const agent = await signedIn(app);
        const cov = (await agent.get('/admin/api/overview').expect(200)).body.digests.coverage;
        expect(cov.total).toBe(30);
        expect(cov.days).toHaveLength(30);
        expect(cov.present).toBe(cov.days.filter((d) => d.present).length);
        expect(cov.days[0].day < cov.days[29].day).toBe(true);
    });

    test('digestCoverage marks only the days that have a digest', () => {
        const stats = require('../services/adminStats');
        const conn = db.get();
        const now = new Date('2026-11-09T18:00:00Z');
        const digests = require('../services/digests');
        conn.prepare("DELETE FROM digests WHERE period IN ('2026-11-08', '2026-11-06')").run();
        const before = stats.digestWatch(conn, now).coverage.present;
        digests.put(conn, 'daily', '2026-11-08', { body: 'x', source: 'import', actor: 'test' });
        const cov = stats.digestWatch(conn, now).coverage;
        expect(cov.present).toBe(before + 1);
        expect(cov.days[cov.days.length - 1]).toEqual({ day: '2026-11-08', present: true });
        expect(cov.days.find((d) => d.day === '2026-11-06').present).toBe(false);
        conn.prepare("DELETE FROM digests WHERE period = '2026-11-08'").run();
    });

    test('a manual backup is audited and needs the header', async () => {
        const app = buildApp();
        const agent = await signedIn(app);
        await agent.post('/admin/api/backups').expect(403);
        const res = await agent.post('/admin/api/backups').set(H).expect(200);
        expect(res.body.ok).toBe(true);
        const events = (await agent.get('/admin/api/activity').expect(200)).body.events;
        expect(events.some((e) => e.action === 'backup_run')).toBe(true);
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
