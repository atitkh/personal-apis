// /hub/notes: the notes domain over REST. Mounted by hub.js, which supplies the rate limit, the JSON body parser,
// no-store and `handle` (turns a NoteError into a JSON error).
//   notes:read       list, get (body, the records it links to and is linked from, only domains the key can read), history, missing
//   notes:api-write  create, update, restore a revision (also needs notes:read: the answer is the note)
// There is no DELETE and no trash: removing a note is done by a person at the dashboard. [[wikilinks]] in a saved body are
// synced to links as the key (see services/notes.js). Changes are audited with notes.auditDetail: id, kind, rev and field
// names, never the title, body or tags.
const express = require('express');
const notes = require('../../services/notes');
const links = require('../../services/links');
const briefing = require('../../services/briefing');
const { keyChanged } = require('../lib/changed');
const apiKeys = require('../../services/apiKeys');
const { requireScope } = require('../../middleware/apiKey');
const { requireDomain } = require('../../middleware/domain');

module.exports = (handle) => {
    const router = express.Router();
    const read = [requireScope('notes:read'), requireDomain('notes')];
    // One requireScope only: each one counts the call against the key's limit.
    const alsoRead = (req, res, next) => (apiKeys.hasScope(req.apiKey.scopes, 'notes:read') ? next()
        : res.status(403).json({ error: 'Forbidden', message: 'This key lacks the "notes:read" scope' }));
    const write = [requireScope('notes:api-write'), alsoRead, requireDomain('notes')];
    const changed = keyChanged(notes.auditDetail);
    const visible = (req, conn) => briefing.visibleDomainsFor(conn, req.apiKey);

    router.get('/', read, handle((req, res, conn) => {
        const { kind, tag, q, pinned, limit, offset } = req.query;
        res.json(notes.list(conn, { kind, tag, q, pinned, limit, offset }));
    }));

    router.get('/missing', read, handle((req, res, conn) => {
        res.json(notes.missing(conn, { limit: req.query.limit }));
    }));

    router.post('/', write, handle((req, res, conn) => {
        changed(req, res, conn, 'note_created', notes.create(conn, req.body, req.apiKey.name, { visible: visible(req, conn) }), 201);
    }));

    router.get('/:id', read, handle((req, res, conn) => {
        const vis = visible(req, conn);
        const n = notes.get(conn, req.params.id, { rev: req.query.rev, visible: vis });
        res.json({ ...n, ...links.listFor(conn, 'notes', String(n.id), { visible: vis }) });
    }));

    router.get('/:id/history', read, handle((req, res, conn) => {
        res.json({ revisions: notes.history(conn, req.params.id, { removed: false }) });
    }));

    router.patch('/:id', write, handle((req, res, conn) => {
        changed(req, res, conn, 'note_updated', notes.update(conn, req.params.id, req.body, req.apiKey.name, { visible: visible(req, conn) }));
    }));

    router.post('/:id/restore', write, handle((req, res, conn) => {
        changed(req, res, conn, 'note_restored', notes.restore(conn, req.params.id, (req.body || {}).rev, req.apiKey.name, { visible: visible(req, conn) }));
    }));

    return router;
};
