// The admin dashboard: static page at /admin and its JSON API at /admin/api.
// Sign in with ADMIN_KEY (from .env) -> a 12 hour cookie session. If ADMIN_KEY is unset or shorter than
// 32 characters the whole section answers 404, so it is off by default.
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('../../db');
const adminAuth = require('../../services/adminAuth');
const apiKeys = require('../../services/apiKeys');
const audit = require('../../services/audit');
const stats = require('../../services/adminStats');
const domains = require('../../services/domains');
const digests = require('../../services/digests');
const backup = require('../../services/backup');
const agents = require('../../services/mcp/agents');

const COOKIE = 'hub_admin';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "manifest-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

// Activity filters: which audit actions each chip shows.
const ACTIVITY_TYPES = {
    all: null,
    keys: ['key_created', 'key_revoked'],
    agents: ['mcp_call', 'domain_mcp_changed'],
    backups: ['backup_run'],
    domains: ['domain_enabled', 'domain_disabled', 'domain_mcp_changed'],
    digests: ['digest_edited', 'digest_restored'],
    signins: ['login', 'logout', 'login_failed'],
};

function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
        }
    }
    return null;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
    const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (req.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function createAdminRouter({ loginMax = 5, loginWindowMs = 15 * 60 * 1000 } = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!adminAuth.isEnabled()) return res.status(404).json({ error: 'Not found' });
        res.removeHeader('Access-Control-Allow-Origin'); // the global CORS rule must not apply here
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', CSP);
        next();
    });

    router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));

    // The page uses relative URLs, so /admin must become /admin/ first.
    router.use((req, res, next) => {
        if (req.path === '/' && !req.originalUrl.split('?')[0].endsWith('/')) {
            return res.redirect(302, `${req.baseUrl}/`);
        }
        next();
    });
    router.use(express.static(PUBLIC_DIR, {
        index: 'index.html',
        setHeaders: (res, file) => {
            if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        },
    }));

    const api = express.Router();
    router.use('/api', api);
    api.use(express.json({ limit: '20kb' }));

    // Cookies are SameSite=Strict already; requiring a custom header on every change adds a second lock.
    api.use((req, res, next) => {
        if (['GET', 'HEAD'].includes(req.method)) return next();
        if (req.get('x-requested-with') !== 'hub-admin') {
            return res.status(403).json({ error: 'Missing X-Requested-With header' });
        }
        next();
    });

    const loginLimiter = rateLimit({
        windowMs: loginWindowMs,
        max: loginMax,
        skipSuccessfulRequests: true, // only wrong keys count
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many wrong keys. Try again in a few minutes.' },
    });

    api.post('/login', loginLimiter, (req, res) => {
        const conn = db.get();
        if (!adminAuth.checkKey(req.body && req.body.key)) {
            audit.record(conn, 'anonymous', 'login_failed', null, req.ip);
            return res.status(401).json({ error: 'That key is not right.' });
        }
        const session = adminAuth.createSession(conn, { ip: req.ip, userAgent: req.get('user-agent') });
        audit.record(conn, 'admin', 'login', null, req.ip);
        setSessionCookie(req, res, session.token, session.maxAgeSeconds);
        res.json({ ok: true, expiresAt: session.expiresAt });
    });

    api.get('/session', (req, res) => {
        const session = adminAuth.getSession(db.get(), readCookie(req, COOKIE));
        res.json(session ? { authenticated: true, expiresAt: session.expiresAt } : { authenticated: false });
    });

    api.post('/logout', (req, res) => {
        const conn = db.get();
        const token = readCookie(req, COOKIE);
        if (adminAuth.getSession(conn, token)) audit.record(conn, 'admin', 'logout', null, req.ip);
        adminAuth.destroySession(conn, token);
        setSessionCookie(req, res, '', 0);
        res.json({ ok: true });
    });

    // Everything below needs a live session.
    api.use((req, res, next) => {
        if (!adminAuth.getSession(db.get(), readCookie(req, COOKIE))) {
            return res.status(401).json({ error: 'Sign in first.' });
        }
        next();
    });

    api.get('/overview', (req, res) => res.json(stats.overview()));
    api.get('/series', (req, res) => res.json(stats.series(db.get(), { days: req.query.days })));
    api.get('/backups', (req, res) => res.json({ backups: stats.backups() }));
    api.post('/backups', async (req, res) => {
        const conn = db.get();
        try {
            const file = await backup.runOnce(conn, { force: true });
            audit.record(conn, 'admin', 'backup_run', null, req.ip);
            res.json({ ok: true, created: Boolean(file), backups: stats.backups() });
        } catch (err) {
            res.status(500).json({ error: `The backup failed: ${err.message}` });
        }
    });
    api.get('/portfolio', (req, res) => res.json(stats.portfolio()));
    // ?type= one of ACTIVITY_TYPES, ?before=<id> for older events. `more` says whether older ones exist.
    api.get('/activity', (req, res) => {
        const type = req.query.type || 'all';
        if (!Object.prototype.hasOwnProperty.call(ACTIVITY_TYPES, type)) {
            return res.status(400).json({ error: `type must be one of: ${Object.keys(ACTIVITY_TYPES).join(', ')}.` });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 199);
        const rows = audit.recent(db.get(), limit + 1, { before: req.query.before, actions: ACTIVITY_TYPES[type] });
        res.json({ events: rows.slice(0, limit), more: rows.length > limit });
    });

    api.get('/keys', (req, res) => res.json({ keys: apiKeys.list(db.get()) }));

    api.post('/keys', (req, res) => {
        const conn = db.get();
        const { name, scopes } = req.body || {};
        try {
            const key = apiKeys.create(conn, { name, scopes });
            audit.record(conn, 'admin', 'key_created', { id: key.id, name: key.name, scopes: key.scopes }, req.ip);
            res.status(201).json(key); // the only time the key itself is returned
        } catch (err) {
            const dup = /UNIQUE/i.test(err.message);
            res.status(dup ? 409 : 400).json({ error: dup ? `A key named "${name}" is already active.` : err.message });
        }
    });

    // A key's latest agent calls for its detail drawer: tool, action, outcome and time, never content.
    api.get('/keys/:id/calls', (req, res) => {
        const conn = db.get();
        const id = Number(req.params.id);
        const key = Number.isInteger(id) ? apiKeys.list(conn).find((k) => k.id === id) : null;
        if (!key) return res.status(404).json({ error: 'No key with that id.' });
        res.json({ calls: agents.callsFor(conn, key, req.query.limit) });
    });

    api.delete('/keys/:id', (req, res) => {
        const conn = db.get();
        const id = Number(req.params.id);
        const row = Number.isInteger(id) ? conn.prepare('SELECT name FROM api_keys WHERE id = ?').get(id) : null;
        if (!row || !apiKeys.revoke(conn, id)) return res.status(404).json({ error: 'No active key with that id.' });
        audit.record(conn, 'admin', 'key_revoked', { id, name: row.name }, req.ip);
        res.json({ ok: true });
    });

    // ---- domains ----
    api.get('/domains', (req, res) => res.json({ domains: agents.domainsWithTools(db.get()) }));

    api.put('/domains/:name', (req, res) => {
        const conn = db.get();
        const { name } = req.params;
        if (!domains.exists(name)) return res.status(404).json({ error: 'No such domain.' });
        if (typeof (req.body || {}).enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
        const enabled = req.body.enabled;
        domains.setEnabled(conn, name, enabled, 'admin');
        audit.record(conn, 'admin', enabled ? 'domain_enabled' : 'domain_disabled', { name }, req.ip);
        res.json({ ok: true, enabled });
    });

    // How agents may reach a domain through /hub/mcp. Only domains that have an agent tool have a mode.
    api.put('/domains/:name/mcp', (req, res) => {
        const conn = db.get();
        const { name } = req.params;
        if (!domains.exists(name)) return res.status(404).json({ error: 'No such domain.' });
        if (!agents.hasTool(name)) return res.status(400).json({ error: 'This domain has no agent tool.' });
        const mode = (req.body || {}).mode;
        if (!domains.MCP_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${domains.MCP_MODES.join(', ')}.` });
        const from = domains.mcpMode(conn, name);
        domains.setMcpMode(conn, name, mode, 'admin');
        audit.record(conn, 'admin', 'domain_mcp_changed', { name, from, to: mode }, req.ip);
        res.json({ ok: true, mode });
    });

    // ---- agent access (/hub/mcp): tools, what each key sees now, recent calls ----
    api.get('/agents', (req, res) => res.json(agents.summary(db.get())));

    // ---- digests (the dashboard may read and edit them even while the domain is switched off) ----
    const digestHandler = (fn) => (req, res) => {
        try {
            fn(req, res, db.get());
        } catch (err) {
            if (err instanceof digests.DigestError) return res.status(err.status).json({ error: err.message });
            console.error('admin digest error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        }
    };

    api.get('/digests', digestHandler((req, res, conn) => {
        const { kind, q, limit, offset, from, to } = req.query;
        if (q) return res.json({ results: digests.search(conn, q, { kind, limit }) });
        const out = { digests: digests.list(conn, { kind, limit, offset, from, to }) };
        if (kind) out.bounds = digests.bounds(conn, kind);
        res.json(out);
    }));

    api.get('/digests/:kind/:period', digestHandler((req, res, conn) => {
        const d = digests.get(conn, req.params.kind, req.params.period, { rev: req.query.rev });
        res.json({ ...d, history: digests.revisions(conn, req.params.kind, req.params.period) });
    }));

    api.patch('/digests/:kind/:period', digestHandler((req, res, conn) => {
        const { kind, period } = req.params;
        const result = digests.edit(conn, kind, period, { body: (req.body || {}).body, note: (req.body || {}).note, actor: 'admin' });
        if (result.status === 'updated') audit.record(conn, 'admin', 'digest_edited', { kind, period, rev: result.rev }, req.ip);
        res.json(result);
    }));

    api.post('/digests/:kind/:period/restore', digestHandler((req, res, conn) => {
        const { kind, period } = req.params;
        const result = digests.restore(conn, kind, period, (req.body || {}).rev, 'admin');
        if (result.status === 'updated') audit.record(conn, 'admin', 'digest_restored', { kind, period, rev: result.rev }, req.ip);
        res.json(result);
    }));

    api.use((req, res) => res.status(404).json({ error: 'Not found' }));
    return router;
}

module.exports = { createAdminRouter, COOKIE };
