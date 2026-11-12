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
const briefing = require('../../services/briefing');
const domains = require('../../services/domains');
const digests = require('../../services/digests');
const places = require('../../services/places');
const flights = require('../../services/flights');
const deadlines = require('../../services/deadlines');
const enrich = require('../../services/enrich');
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
    keys: ['key_created', 'key_updated', 'key_revoked'],
    agents: ['mcp_call', 'domain_mcp_changed'],
    backups: ['backup_run'],
    domains: ['domain_enabled', 'domain_disabled', 'domain_mcp_changed'],
    digests: ['digest_edited', 'digest_restored'],
    places: ['place_created', 'place_updated', 'place_restored', 'place_deleted', 'place_rule_added', 'place_rule_updated', 'place_rule_removed',
        'place_suggestion_accepted', 'place_suggestion_dismissed'],
    flights: ['flight_created', 'flight_updated', 'flight_restored', 'trip_created', 'trip_updated', 'flight_settings_changed',
        'flight_candidate_filed', 'flight_candidate_accepted', 'flight_candidate_dismissed', 'flight_refreshed', 'flight_observed', 'flight_sources_changed'],
    deadlines: ['deadline_created', 'deadline_updated', 'deadline_done', 'deadline_ended', 'deadline_restored'],
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

    api.get('/overview', (req, res) => res.json(stats.overview()));
    // The Today card: every domain (the admin sees them all), `days` clamped 1..90.
    api.get('/briefing', (req, res) => res.json(briefing.collect(db.get(), { days: req.query.days })));
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

    // Edit a live key in place: name and/or scopes. The secret never changes and is never returned.
    api.patch('/keys/:id', (req, res) => {
        const conn = db.get();
        const id = Number(req.params.id);
        const { name, scopes, confirm_all: confirmAll } = req.body || {};
        try {
            const out = apiKeys.update(conn, id, { name, scopes, confirmAll });
            if (out.added.length || out.removed.length || out.renamedFrom) {
                audit.record(conn, 'admin', 'key_updated', {
                    id, name: out.key.name, ...(out.renamedFrom ? { renamed_from: out.renamedFrom } : {}), added: out.added, removed: out.removed,
                }, req.ip);
            }
            res.json(out.key);
        } catch (err) {
            res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not update the key.' });
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

    // ---- places (works while the domain is switched off, like digests). Changes are audited as by
    // `admin` with ids, labels and rule types only, never rule values or streets. ----
    const placeHandler = (fn) => (req, res) => {
        try {
            fn(req, res, db.get());
        } catch (err) {
            if (err instanceof places.PlaceError) return res.status(err.status).json({ error: err.message, code: err.code });
            console.error('admin places error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        }
    };
    const placeChanged = (req, res, conn, action, result, status = 200) => {
        if (result.status !== 'unchanged') audit.record(conn, 'admin', action, places.auditDetail(result), req.ip);
        res.status(status).json(result);
    };

    api.get('/places', placeHandler((req, res, conn) => {
        const list = places.list(conn, { kind: req.query.kind }).map((p) => ({
            ...p, ruleCount: p.rules.length, revisions: p.rev, lastChange: { at: p.updated_at, by: p.updated_by },
        }));
        res.json({ places: list, kinds: places.KINDS, ruleTypes: places.RULE_TYPES, suggestions: places.suggestionCounts(conn) });
    }));

    // Fixed words before /places/:id.
    api.post('/places/resolve', placeHandler((req, res, conn) => {
        res.json(places.resolve(conn, { ...(req.body || {}), suggest: false })); // the resolve box never files suggestions
    }));

    api.get('/places/suggestions', placeHandler((req, res, conn) => {
        const status = req.query.status || 'pending';
        res.json({ status, suggestions: places.suggestions(conn, { status, limit: req.query.limit }), counts: places.suggestionCounts(conn) });
    }));

    api.post('/places/suggestions/:id/accept', placeHandler((req, res, conn) => {
        const result = places.acceptSuggestion(conn, req.params.id, req.body, 'admin');
        audit.record(conn, 'admin', 'place_suggestion_accepted', places.suggestionAuditDetail(result), req.ip);
        res.json(result);
    }));

    api.post('/places/suggestions/:id/dismiss', placeHandler((req, res, conn) => {
        const result = places.dismissSuggestion(conn, req.params.id, 'admin');
        if (result.status !== 'unchanged') audit.record(conn, 'admin', 'place_suggestion_dismissed', places.suggestionAuditDetail(result), req.ip);
        res.json(result);
    }));

    api.post('/places', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_created', places.create(conn, req.body, 'admin'), 201);
    }));

    // One place (?rev= for an old revision) with its whole history.
    api.get('/places/:id', placeHandler((req, res, conn) => {
        res.json({ ...places.get(conn, req.params.id, { rev: req.query.rev }), history: places.history(conn, req.params.id) });
    }));

    api.patch('/places/:id', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_updated', places.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.delete('/places/:id', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_deleted', places.remove(conn, req.params.id));
    }));

    api.post('/places/:id/restore', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_restored', places.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    api.post('/places/:id/rules', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_rule_added', places.addRule(conn, req.params.id, req.body, 'admin'), 201);
    }));

    api.patch('/places/:id/rules/:ruleId', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_rule_updated', places.updateRule(conn, req.params.id, req.params.ruleId, req.body, 'admin'));
    }));

    api.delete('/places/:id/rules/:ruleId', placeHandler((req, res, conn) => {
        placeChanged(req, res, conn, 'place_rule_removed', places.removeRule(conn, req.params.id, req.params.ruleId, 'admin'));
    }));

    // ---- flights: the found-flights queue (works while the domain is switched off). Accepting and dismissing
    // are for a person only, so they live here and not on /hub. Audited as `admin` with the candidate id, the
    // flight label and the flight it became; never the booking reference. ----
    const flightHandler = (fn) => (req, res) => {
        const fail = (err) => {
            if (err instanceof flights.FlightError) {
                return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
            }
            console.error('admin flights error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        };
        try {
            const out = fn(req, res, db.get());
            if (out && typeof out.then === 'function') out.catch(fail);
        } catch (err) {
            fail(err);
        }
    };

    api.get('/flights/candidates', flightHandler((req, res, conn) => {
        const status = req.query.status || 'pending';
        res.json({ status, candidates: flights.listCandidates(conn, { status, limit: req.query.limit }), counts: flights.candidateCounts(conn) });
    }));

    // Body: { ids: [..] }. Each id is accepted on its own; the answer lists what happened to each.
    api.post('/flights/candidates/accept-all', flightHandler((req, res, conn) => {
        const result = flights.acceptAll(conn, (req.body || {}).ids, 'admin');
        for (const r of result.results.filter((x) => x.status === 'accepted')) {
            audit.record(conn, 'admin', 'flight_candidate_accepted', { id: r.id, flight: r.label, flight_id: r.flight_id, rev: r.rev }, req.ip);
        }
        res.json(result);
    }));

    // Body: optional flight fields that replace the found ones before the flight is created.
    api.post('/flights/candidates/:id/accept', flightHandler((req, res, conn) => {
        const result = flights.acceptCandidate(conn, req.params.id, req.body, 'admin');
        audit.record(conn, 'admin', 'flight_candidate_accepted', flights.candidateAuditDetail(result.candidate, result.flight), req.ip);
        res.json(result);
    }));

    api.post('/flights/candidates/:id/dismiss', flightHandler((req, res, conn) => {
        const result = flights.dismissCandidate(conn, req.params.id, 'admin');
        if (result.status !== 'unchanged') audit.record(conn, 'admin', 'flight_candidate_dismissed', flights.candidateAuditDetail(result.candidate), req.ip);
        res.json(result);
    }));

    // ---- flights: the list, one flight, the Passport, airports, trips and settings for the dashboard. Fixed words
    // come before /flights/:id. The list leaves booking references out (has_booking_ref instead); one flight
    // carries it. Changes are audited as `admin` with id, flight label and revision only. ----
    const flightChanged = (req, res, conn, action, result, status = 200) => {
        if (result.status !== 'unchanged') audit.record(conn, 'admin', action, flights.auditDetail(result), req.ip);
        res.status(status).json(result);
    };

    api.get('/flights', flightHandler((req, res, conn) => {
        const { year, airport, airline, trip, status, limit, offset } = req.query;
        const out = flights.list(conn, { year, airport, airline, trip, status, limit: limit || 500, offset });
        out.flights = out.flights.map(({ booking_ref: ref, ...rest }) => ({ ...rest, has_booking_ref: Boolean(ref) }));
        res.json(out);
    }));

    // The Passport numbers plus what the map draws (airports with coordinates, routes with counts).
    api.get('/flights/stats', flightHandler((req, res, conn) => {
        res.json({ ...flights.stats(conn, { year: req.query.year }), map: flights.mapData(conn, { year: req.query.year }), settings: flights.getSettings(conn) });
    }));

    api.get('/flights/upcoming', flightHandler((req, res, conn) => {
        res.json({ flights: flights.upcoming(conn, { limit: req.query.limit }).map(({ booking_ref: ref, ...rest }) => ({ ...rest, has_booking_ref: Boolean(ref) })) });
    }));

    api.get('/flights/airports', flightHandler((req, res, conn) => {
        res.json({ airports: flights.searchAirports(conn, req.query.q) });
    }));

    api.get('/flights/trips', flightHandler((req, res, conn) => {
        res.json({ trips: flights.listTrips(conn) });
    }));

    api.post('/flights/trips', flightHandler((req, res, conn) => {
        const result = flights.createTrip(conn, req.body, 'admin');
        audit.record(conn, 'admin', 'trip_created', { id: result.id, title: result.title }, req.ip);
        res.status(201).json(result);
    }));

    api.get('/flights/settings', flightHandler((req, res, conn) => {
        res.json(flights.getSettings(conn));
    }));

    api.put('/flights/settings', flightHandler((req, res, conn) => {
        const result = flights.putSettings(conn, req.body, 'admin');
        audit.record(conn, 'admin', 'flight_settings_changed', { keys: Object.keys(req.body || {}) }, req.ip);
        res.json(result);
    }));

    api.post('/flights', flightHandler((req, res, conn) => {
        flightChanged(req, res, conn, 'flight_created', flights.create(conn, req.body, 'admin'), 201);
    }));

    // ---- flights: data sources (enrichment). Settings and calls this month; keys are only "configured". ----
    api.get('/flights/sources', flightHandler((req, res, conn) => {
        res.json(enrich.listSources(conn));
    }));

    api.put('/flights/sources', flightHandler((req, res, conn) => {
        const names = enrich.putSources(conn, req.body);
        audit.record(conn, 'admin', 'flight_sources_changed', { sources: names }, req.ip);
        res.json(enrich.listSources(conn));
    }));

    api.post('/flights/:id/refresh', flightHandler(async (req, res, conn) => {
        const result = await enrich.refresh(conn, req.params.id, { force: (req.body || {}).force === true, actor: 'admin' });
        if (result.looked_up || result.status === 'updated') {
            audit.record(conn, 'admin', 'flight_refreshed', { ...flights.auditDetail(result), results: result.results.map((r) => `${r.source}:${r.result}`) }, req.ip);
        }
        res.json(result);
    }));

    api.get('/flights/:id', flightHandler((req, res, conn) => {
        res.json({ ...flights.get(conn, req.params.id, { rev: req.query.rev }), history: flights.history(conn, req.params.id) });
    }));

    api.patch('/flights/:id', flightHandler((req, res, conn) => {
        flightChanged(req, res, conn, 'flight_updated', flights.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.post('/flights/:id/restore', flightHandler((req, res, conn) => {
        flightChanged(req, res, conn, 'flight_restored', flights.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    // ---- deadlines: everything the dashboard needs. The admin sees every field, the private reference included.
    // Works while the domain is switched off. Changes are audited as `admin` with id, title, revision and field
    // names (deadlines.auditDetail), never values. Fixed words come before /deadlines/:id. ----
    const deadlineHandler = (fn) => (req, res) => {
        try {
            fn(req, res, db.get());
        } catch (err) {
            if (err instanceof deadlines.DeadlineError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
            console.error('admin deadlines error:', err);
            res.status(500).json({ error: 'Something went wrong.' });
        }
    };
    const deadlineChanged = (req, res, conn, action, result, status = 200) => {
        if (result.status !== 'unchanged') audit.record(conn, 'admin', action, deadlines.auditDetail(result), req.ip);
        res.status(status).json(result);
    };

    api.get('/deadlines', deadlineHandler((req, res, conn) => {
        const { kind, status, due_before: before, due_after: after, overdue, q, limit, offset } = req.query;
        res.json(deadlines.list(conn, { kind, status, due_before: before, due_after: after, overdue, q, limit: limit || 500, offset, reference: true }));
    }));

    api.get('/deadlines/upcoming', deadlineHandler((req, res, conn) => {
        res.json({ deadlines: deadlines.upcoming(conn, { days: req.query.days, limit: req.query.limit, reference: true }) });
    }));

    api.post('/deadlines', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_created', deadlines.create(conn, req.body, 'admin'), 201);
    }));

    api.get('/deadlines/:id', deadlineHandler((req, res, conn) => {
        res.json({ ...deadlines.get(conn, req.params.id, { rev: req.query.rev }), history: deadlines.history(conn, req.params.id) });
    }));

    api.patch('/deadlines/:id', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_updated', deadlines.update(conn, req.params.id, req.body, 'admin'));
    }));

    api.post('/deadlines/:id/done', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_done', deadlines.done(conn, req.params.id, 'admin'));
    }));

    api.post('/deadlines/:id/end', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_ended', deadlines.end(conn, req.params.id, 'admin'));
    }));

    api.post('/deadlines/:id/restore', deadlineHandler((req, res, conn) => {
        deadlineChanged(req, res, conn, 'deadline_restored', deadlines.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    api.use((req, res) => res.status(404).json({ error: 'Not found' }));
    return router;
}

module.exports = { createAdminRouter, COOKIE };
