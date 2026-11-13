// /hub/lifelog: the lifelog domain over REST. Mounted by hub.js (rate limit, 256 KB JSON body, no-store, `handle`).
// "*" keys do not reach these routes: lifelog scopes must be granted on purpose (services/apiKeys.js).
//   lifelog:push       POST /observations only (a batch of 1..100), under the key's own name as the source
//   lifelog:read       observations, day, episodes, one episode, its history
//   lifelog:api-write  POST /observations under any source; create, update, restore episodes; link and unlink
//                      observations (also needs lifelog:read: the answer is the episode)
// No DELETE here and no forget: forgetting a time range is for a person at the dashboard only. Unlinking is a POST.
// Audit: one lifelog_pushed row per batch (sources and counts); episodes by id, kind, revision and field NAMES.
// Never text, titles or detail.
const express = require('express');
const lifelog = require('../../services/lifelog');
const audit = require('../../services/audit');
const { keyChanged } = require('../lib/changed');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('lifelog:read'), requireDomain('lifelog')];
    // One requireScope only per route: each one counts the call against the key's limit.
    const scopeCheck = (scopes) => (req, res, next) => (scopes.some((s) => apiKeys.hasScope(req.apiKey.scopes, s)) ? next()
        : res.status(403).json({ error: 'Forbidden', message: `This key lacks the "${scopes[0]}" scope` }));
    const write = [requireScope('lifelog:api-write'), scopeCheck(['lifelog:read']), requireDomain('lifelog')];
    // Push: lifelog:push, or lifelog:api-write (which may also push under any source name).
    // requireScope(null) checks the key (and counts the call) without a scope; the check that follows needs one of the two.
    const pushScope = [requireScope(null), scopeCheck(['lifelog:push', 'lifelog:api-write'])];
    const changed = keyChanged(lifelog.auditDetail);

    // Body { observations: [...] } (or a bare list). 201 when at least one was stored.
    router.post('/observations', pushScope, requireDomain('lifelog'), handle((req, res, conn) => {
        const body = req.body;
        const items = Array.isArray(body) ? body : (body || {}).observations;
        const result = lifelog.push(conn, req.apiKey, items);
        audit.recordKey(conn, req.apiKey, 'lifelog_pushed', lifelog.pushAuditDetail(result), req.ip);
        res.status(result.accepted ? 201 : 200).json(result);
    }));

    router.get('/observations', read, handle((req, res, conn) => {
        const { source, kind, from, to, local_date, q, limit, offset, order } = req.query;
        res.json(lifelog.listObservations(conn, { source, kind, from, to, local_date, q, limit, offset, order }));
    }));

    router.get('/day/:date', read, handle((req, res, conn) => {
        res.json(lifelog.day(conn, req.params.date));
    }));

    router.get('/episodes', read, handle((req, res, conn) => {
        const { kind, status, source, from, to, local_date, q, limit, offset, order } = req.query;
        res.json(lifelog.listEpisodes(conn, { kind, status, source, from, to, local_date, q, limit, offset, order }));
    }));

    router.post('/episodes', write, handle((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_created', lifelog.createEpisode(conn, req.body, req.apiKey.name), 201);
    }));

    router.get('/episodes/:id', read, handle((req, res, conn) => {
        res.json(lifelog.getEpisode(conn, req.params.id, { rev: req.query.rev }));
    }));

    router.get('/episodes/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: lifelog.history(conn, req.params.id) });
    }));

    router.patch('/episodes/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_updated', lifelog.updateEpisode(conn, req.params.id, req.body, req.apiKey.name));
    }));

    router.post('/episodes/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_restored', lifelog.restoreEpisode(conn, req.params.id, (req.body || {}).rev, req.apiKey.name));
    }));

    // Body { observation_ids: [...] }.
    router.post('/episodes/:id/observations', write, handle((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_linked', lifelog.link(conn, req.params.id, (req.body || {}).observation_ids, req.apiKey.name));
    }));

    // A POST, not a DELETE (tests/noRemoteDelete.test.js). The observations stay.
    router.post('/episodes/:id/observations/unlink', write, handle((req, res, conn) => {
        changed(req, res, conn, 'lifelog_episode_unlinked', lifelog.unlink(conn, req.params.id, (req.body || {}).observation_ids, req.apiKey.name));
    }));

    return router;
};
