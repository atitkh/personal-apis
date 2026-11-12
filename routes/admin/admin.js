// The admin dashboard: static page at /admin and its JSON API at /admin/api.
// Sign in with ADMIN_KEY (from .env) -> a 12 hour cookie session. If ADMIN_KEY is unset or shorter than
// 32 characters the whole section answers 404, so it is off by default.
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('../../db');
const adminAuth = require('../../services/adminAuth');
const audit = require('../../services/audit');

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

    // Only API calls count: one page load fetches about 30 static files, which would use the budget up fast.
    router.use(rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 600,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => !req.path.startsWith('/api'),
    }));

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

    // The routes, one module per domain. The order is the order they were registered in before the split: fixed words
    // come before params inside a module (/flights/sources before /flights/:id), and modules do not share paths.
    const ctx = { db, audit };
    require('./api/overview')(api, ctx);
    require('./api/backups')(api, ctx);
    require('./api/activity')(api, ctx);
    require('./api/keys')(api, ctx);
    require('./api/domains')(api, ctx);
    require('./api/agents')(api, ctx);
    require('./api/digests')(api, ctx);
    require('./api/places')(api, ctx);
    require('./api/flights')(api, ctx);
    require('./api/deadlines')(api, ctx);
    require('./api/preferences')(api, ctx);

    api.use((req, res) => res.status(404).json({ error: 'Not found' }));
    return router;
}

module.exports = { createAdminRouter, COOKIE };
