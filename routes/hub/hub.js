// The hub's private API: /hub/*. Every route needs an API key with the right scope, and a domain the
// operator has switched off answers 503 even to a valid key. Not listed in /api, not public.
const express = require('express');
const db = require('../../db');
const digests = require('../../services/digests');
const { hubHandle } = require('../lib/handle');
const briefing = require('../../services/briefing');
const { requireKey, requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

const rateLimit = require('express-rate-limit');

const router = express.Router();
// Callers are machines with keys, so the global per-IP limit is skipped and this one is generous.
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false }));
router.use(express.json({ limit: '256kb' }));
router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

const read = [requireScope('digests:read'), requireDomain('digests')];
const write = [requireScope('digests:api-write'), requireDomain('digests')];

const handle = hubHandle;

// Fixed words first, so "search" is never read as a kind.
router.get('/digests', read, handle((req, res, conn) => {
    const { kind, from, to, limit, offset } = req.query;
    res.json({ digests: digests.list(conn, { kind, from, to, limit, offset }) });
}));

router.get('/digests/search', read, handle((req, res, conn) => {
    res.json({ results: digests.search(conn, req.query.q, { kind: req.query.kind, limit: req.query.limit }) });
}));

router.get('/digests/recent', read, handle((req, res, conn) => {
    res.json({ digests: digests.recent(conn, req.query.kind || 'daily', req.query.days || req.query.count) });
}));

router.get('/digests/:kind/latest', read, handle((req, res, conn) => {
    res.json(digests.latest(conn, req.params.kind));
}));

router.get('/digests/:kind/:period/revisions', read, handle((req, res, conn) => {
    res.json({ revisions: digests.revisions(conn, req.params.kind, req.params.period) });
}));

router.get('/digests/:kind/:period', read, handle((req, res, conn) => {
    res.json(digests.get(conn, req.params.kind, req.params.period, { rev: req.query.rev }));
}));

// The nightly job, the weekly review and the importer write here.
router.put('/digests/:kind/:period', write, handle((req, res, conn) => {
    const { body, source, model, meta, force, at } = req.body || {};
    const result = digests.put(conn, req.params.kind, req.params.period, {
        body, source, model, meta, at, force: force === true, actor: req.apiKey.name,
    });
    res.status(result.status === 'created' ? 201 : 200).json(result);
}));

router.patch('/digests/:kind/:period', write, handle((req, res, conn) => {
    const { body, note } = req.body || {};
    res.json(digests.edit(conn, req.params.kind, req.params.period, { body, note, actor: req.apiKey.name }));
}));

router.post('/digests/:kind/:period/restore', write, handle((req, res, conn) => {
    res.json(digests.restore(conn, req.params.kind, req.params.period, (req.body || {}).rev, req.apiKey.name));
}));

// Any live key; what it sees follows its scopes and each domain's MCP mode, exactly as hub_overview does.
router.get('/briefing', requireKey(), handle((req, res, conn) => {
    const only = typeof req.query.domains === 'string' ? req.query.domains.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
    res.json(briefing.collect(conn, { days: req.query.days, domains: only, visibleDomains: briefing.visibleDomainsFor(conn, req.apiKey) }));
}));

// Other domains keep their routes in their own file.
router.use('/places', require('./places')(handle));
router.use('/flights', require('./flights')(handle));
router.use('/deadlines', require('./deadlines')(handle));
router.use('/preferences', require('./preferences')(handle));

router.use((req, res) => res.status(404).json({ error: 'not_found', message: 'No such hub route.' }));

module.exports = router;
