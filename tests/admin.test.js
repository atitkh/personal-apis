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

    test('every admin module parses, is served as JavaScript and imports only files that exist', async () => {
        const fs = require('fs');
        const path = require('path');
        const { spawnSync } = require('child_process');
        const root = path.join(__dirname, '../routes/admin/public');
        const files = ['.', 'views'].flatMap((dir) => fs.readdirSync(path.join(root, dir))
            .filter((f) => f.endsWith('.js')).map((f) => path.posix.join(dir, f).replace(/^\.\//, '')));
        expect(files).toEqual(expect.arrayContaining(['app.js', 'skeletons.js', 'shortcuts.js', 'views/settings.js', 'views/flights.js', 'passport.js', 'worldmap.js', 'mapviews.js', 'globedata.js', 'globe.js']));
        for (const file of files) {
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
            expect({ file, error: check.status === 0 ? '' : check.stderr.split('\n').slice(0, 5).join('\n') }).toEqual({ file, error: '' });
            for (const [, from, dynamic] of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+'(\.[^']+)'|import\('(\.[^'$`]+)'\)/g)) {
                const spec = from || dynamic;
                const target = path.join(path.dirname(path.join(root, file)), spec);
                expect({ file, spec, exists: fs.existsSync(target) }).toEqual({ file, spec, exists: true });
            }
            const res = await request(app).get(`/admin/${file}`).expect(200);
            expect(res.headers['content-type']).toMatch(/javascript/);
        }
    });

    test('the CSP adds only manifest-src for the web app manifest', async () => {
        const csp = (await request(app).get('/admin/').expect(200)).headers['content-security-policy'];
        expect(csp).toMatch(/manifest-src 'self'(;|$)/);
        const sources = csp.split(';').map((d) => d.trim().split(/\s+/)[0]).sort();
        expect(sources).toEqual(['base-uri', 'connect-src', 'default-src', 'font-src', 'form-action', 'frame-ancestors',
            'img-src', 'manifest-src', 'script-src', 'style-src']);
        expect(csp).toMatch(/script-src 'self'(;|$)/);
        expect(csp).toMatch(/style-src 'self'(;|$)/);
    });

    test('serves the web app manifest and its icons', async () => {
        const page = await request(app).get('/admin/').expect(200);
        expect(page.text).toMatch(/<link rel="manifest" href="manifest.webmanifest">/);
        expect(page.text).toMatch(/<meta name="theme-color" content="#[0-9A-F]{6}" media="\(prefers-color-scheme: light\)">/);
        expect(page.text).toMatch(/<meta name="theme-color" content="#[0-9A-F]{6}" media="\(prefers-color-scheme: dark\)">/);
        const res = await request(app).get('/admin/manifest.webmanifest').expect(200);
        expect(res.headers['content-type']).toMatch(/application\/manifest\+json/);
        expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
        const manifest = JSON.parse(res.text);
        expect(manifest.start_url).toBe('./#/overview');
        expect(manifest.scope).toBe('./');
        expect(manifest.display).toBe('standalone');
        for (const icon of manifest.icons) {
            expect(icon.src).not.toMatch(/^(https?:)?\/\//);
            const file = await request(app).get(`/admin/${icon.src}`).expect(200);
            expect(file.headers['content-type']).toMatch(icon.type === 'image/png' ? /image\/png/ : /image\/svg\+xml/);
        }
        expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true);
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

        const created = (await agent.post('/admin/api/keys').set(H).send({ name: 'digest', scopes: 'digest:api-write' }).expect(201)).body;
        expect(created.key).toMatch(/^pak_/);

        const listed = (await agent.get('/admin/api/keys').expect(200)).body.keys;
        expect(JSON.stringify(listed)).not.toContain(created.key);
        expect(listed.find((k) => k.id === created.id)).toMatchObject({ name: 'digest', scopes: ['digest:api-write'] });
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
        expect(o.domains.map((d) => d.name).sort()).toEqual(['deadlines', 'digests', 'flights', 'places', 'portfolio', 'preferences']);
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

describe('dashboard: calendar, activity paging, key calls', () => {
    const app = buildApp({ loginMax: 1000 });
    const digests = require('../services/digests');

    test('digests can be listed for a date range, with the bounds of the kind', async () => {
        const conn = db.get();
        for (const p of ['2026-09-30', '2026-10-01', '2026-10-15', '2026-10-31', '2026-11-01']) {
            digests.put(conn, 'daily', p, { body: `Day ${p}.`, actor: 'test' });
        }
        const agent = await signedIn(app);
        const res = (await agent.get('/admin/api/digests?kind=daily&from=2026-10-01&to=2026-10-31&limit=62').expect(200)).body;
        expect(res.digests.map((d) => d.period)).toEqual(['2026-10-31', '2026-10-15', '2026-10-01']);
        expect(res.bounds.first <= '2026-09-30').toBe(true);
        expect(res.bounds.last >= '2026-11-01').toBe(true);
        expect(res.bounds.count).toBeGreaterThanOrEqual(5);
        await agent.get('/admin/api/digests?kind=monthly').expect(400);
    });

    test('activity filters by type and pages back with before', async () => {
        const conn = db.get();
        for (let i = 0; i < 5; i++) audit.record(conn, 'admin', 'backup_run', null, '127.0.0.1');
        audit.record(conn, 'admin', 'key_created', { id: 99, name: 'pager', scopes: ['digests:read'] }, '127.0.0.1');
        const agent = await signedIn(app);

        const first = (await agent.get('/admin/api/activity?type=backups&limit=3').expect(200)).body;
        expect(first.events).toHaveLength(3);
        expect(first.events.every((e) => e.action === 'backup_run')).toBe(true);
        expect(first.more).toBe(true);

        const older = (await agent.get(`/admin/api/activity?type=backups&limit=3&before=${first.events[2].id}`).expect(200)).body;
        expect(older.events.every((e) => e.id < first.events[2].id && e.action === 'backup_run')).toBe(true);

        const keys = (await agent.get('/admin/api/activity?type=keys').expect(200)).body.events;
        expect(keys[0]).toMatchObject({ action: 'key_created', detail: { name: 'pager' } });
        await agent.get('/admin/api/activity?type=nope').expect(400);
    });

    test("a key's agent calls are listed without content, only from its own lifetime", async () => {
        const conn = db.get();
        audit.record(conn, 'callme', 'mcp_call', { key: 'callme', tool: 'digests', action: 'get', ok: true }, null);
        conn.prepare("UPDATE audit_log SET at = '2000-01-01T00:00:00.000Z' WHERE id = (SELECT MAX(id) FROM audit_log)").run();
        const agent = await signedIn(app);
        const key = (await agent.post('/admin/api/keys').set(H).send({ name: 'callme', scopes: 'digests:read' }).expect(201)).body;
        audit.record(conn, 'callme', 'mcp_call', { key: 'callme', tool: 'digests', action: 'search', ok: false }, null);
        audit.record(conn, 'other', 'mcp_call', { key: 'other', tool: 'digests', action: 'get', ok: true }, null);

        const calls = (await agent.get(`/admin/api/keys/${key.id}/calls`).expect(200)).body.calls;
        expect(calls).toEqual([expect.objectContaining({ key: 'callme', tool: 'digests', action: 'search', ok: false })]);
        await agent.get('/admin/api/keys/999999/calls').expect(404);
        await agent.get('/admin/api/keys/abc/calls').expect(404);
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

describe('dashboard: editing a key', () => {
    const app = buildApp({ loginMax: 1000 });
    const mk = (name, scopes) => apiKeys.create(db.get(), { name, scopes });

    test('needs a signed-in session', async () => {
        const k = mk('patch-auth', 'places:read');
        await request(app).patch(`/admin/api/keys/${k.id}`).set(H).send({ name: 'x' }).expect(401);
        expect(apiKeys.get(db.get(), k.id).name).toBe('patch-auth');
    });

    test('changes scopes in place, returns the key without a secret, and records added and removed names', async () => {
        const k = mk('patch-scopes', 'places:read, places:agent-write');
        const agent = await signedIn(app);
        const res = await agent.patch(`/admin/api/keys/${k.id}`).set(H).send({ scopes: ['places:read', 'flights:observe'] }).expect(200);
        expect(res.body).toMatchObject({ id: k.id, name: 'patch-scopes', scopes: ['places:read', 'flights:observe'], key_prefix: k.key.slice(0, 8) });
        expect(JSON.stringify(res.body)).not.toContain(k.key);
        expect(res.body).not.toHaveProperty('key');
        expect(res.body).not.toHaveProperty('key_hash');
        expect(apiKeys.verify(db.get(), k.key).scopes).toEqual(['places:read', 'flights:observe']);

        const row = audit.recent(db.get(), 1, { actions: ['key_updated'] })[0];
        expect(row).toMatchObject({ actor: 'admin', action: 'key_updated', detail: { id: k.id, name: 'patch-scopes', added: ['flights:observe'], removed: ['places:agent-write'] } });
        expect(row.detail).not.toHaveProperty('renamed_from');
        expect(JSON.stringify(row)).not.toContain(k.key);
    });

    test('renames, and records the old name', async () => {
        const k = mk('patch-old', 'places:read');
        const agent = await signedIn(app);
        await agent.patch(`/admin/api/keys/${k.id}`).set(H).send({ name: '  patch-new ' }).expect(200);
        const row = audit.recent(db.get(), 1, { actions: ['key_updated'] })[0];
        expect(row.detail).toMatchObject({ id: k.id, name: 'patch-new', renamed_from: 'patch-old', added: [], removed: [] });
    });

    test('a request that changes nothing writes no audit row', async () => {
        const k = mk('patch-same', 'places:read');
        const agent = await signedIn(app);
        const before = audit.recent(db.get(), 1)[0].id;
        await agent.patch(`/admin/api/keys/${k.id}`).set(H).send({ name: 'patch-same', scopes: ['places:read'] }).expect(200);
        expect(audit.recent(db.get(), 1)[0].id).toBe(before);
    });

    test('validates: empty scopes, bad scope, bad name, nothing to change are 400', async () => {
        const k = mk('patch-bad', 'places:read');
        const agent = await signedIn(app);
        const patch = (body) => agent.patch(`/admin/api/keys/${k.id}`).set(H).send(body);
        expect((await patch({ scopes: [] }).expect(400)).body.error).toMatch(/At least one scope/);
        await patch({ scopes: ['Nope'] }).expect(400);
        await patch({ name: '' }).expect(400);
        await patch({ name: 'y'.repeat(61) }).expect(400);
        await patch({}).expect(400);
        expect(apiKeys.get(db.get(), k.id)).toMatchObject({ name: 'patch-bad', scopes: ['places:read'] });
    });

    test('404 for an unknown key, 409 for a revoked key or a name in use', async () => {
        const a = mk('patch-a', 'places:read');
        const b = mk('patch-b', 'places:read');
        const agent = await signedIn(app);
        await agent.patch('/admin/api/keys/99999').set(H).send({ name: 'z' }).expect(404);
        await agent.patch('/admin/api/keys/abc').set(H).send({ name: 'z' }).expect(404);
        await agent.patch(`/admin/api/keys/${b.id}`).set(H).send({ name: 'patch-a' }).expect(409);
        apiKeys.revoke(db.get(), a.id);
        await agent.patch(`/admin/api/keys/${a.id}`).set(H).send({ scopes: ['digests:read'] }).expect(409);
    });

    test('granting "*" needs confirm_all: true', async () => {
        const k = mk('patch-star', 'places:read');
        const agent = await signedIn(app);
        const refused = await agent.patch(`/admin/api/keys/${k.id}`).set(H).send({ scopes: ['*'] }).expect(400);
        expect(refused.body.error).toMatch(/confirm_all/);
        expect(apiKeys.get(db.get(), k.id).scopes).toEqual(['places:read']);
        await agent.patch(`/admin/api/keys/${k.id}`).set(H).send({ scopes: ['*'], confirm_all: true }).expect(200);
        expect(apiKeys.get(db.get(), k.id).scopes).toEqual(['*']);
        expect(audit.recent(db.get(), 1, { actions: ['key_updated'] })[0].detail).toMatchObject({ added: ['*'], removed: ['places:read'] });
    });

    test('the activity "keys" filter includes key_updated', async () => {
        const k = mk('patch-act', 'places:read');
        const agent = await signedIn(app);
        await agent.patch(`/admin/api/keys/${k.id}`).set(H).send({ scopes: ['places:read', 'places:suggest'] }).expect(200);
        const events = (await agent.get('/admin/api/activity?type=keys').expect(200)).body.events;
        expect(events[0]).toMatchObject({ action: 'key_updated', detail: { name: 'patch-act', added: ['places:suggest'] } });
        const all = (await agent.get('/admin/api/activity').expect(200)).body.events;
        expect(all.map((e) => e.action)).toContain('key_updated');
    });

    test('the agent matrix reflects a scope change at once', async () => {
        const k = mk('patch-matrix', 'places:read');
        const agent = await signedIn(app);
        const seen = async () => (await agent.get('/admin/api/agents').expect(200)).body.keys.find((x) => x.id === k.id);
        expect((await seen()).visibleTools.map((t) => t.tool)).toContain('places');
        await agent.patch(`/admin/api/keys/${k.id}`).set(H).send({ scopes: ['digests:read'] }).expect(200);
        const after = await seen();
        expect(after.scopes).toEqual(['digests:read']);
        expect(after.visibleTools.map((t) => t.tool)).not.toContain('places');
    });
});
