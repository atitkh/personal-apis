const notes = require('../../../services/notes');
const { adminHandler } = require('../../lib/handle');
const { adminChanged } = require('../../lib/changed');
const { removal } = require('../../lib/remove');
const { needConfirm } = require('../../../services/lib/remove');

module.exports = (api) => {
    // ---- notes: the dashboard's API. Works while the domain is switched off. Changes are audited as `admin` with id, kind,
    // rev and field names (notes.auditDetail), never the title, body or tags. The editor's autosave sends autosave: true
    // (a revision only when the title or body changed and the last revision is 5 minutes old); an explicit Save does not. ----
    const noteHandler = adminHandler(notes.NoteError, 'admin notes error:', { extra: true, async: true });
    const noteChanged = adminChanged(notes.auditDetail);

    api.get('/notes', noteHandler((req, res, conn) => {
        const { kind, tag, q, pinned, removed, limit, offset } = req.query;
        res.json(notes.list(conn, { kind, tag, q, pinned, removed, limit: limit || 200, offset }));
    }));

    // Kinds and tags in use with counts (before /:id).
    api.get('/notes/facets', noteHandler((req, res, conn) => res.json(notes.facets(conn))));

    // Titles used in [[wikilinks]] that nothing answers to, with how many notes use each.
    api.get('/notes/missing', noteHandler((req, res, conn) => res.json(notes.missing(conn, { limit: req.query.limit }))));

    // How typed [[targets]] resolve right now, for the editor's live preview. Body { targets: [...], id? }.
    api.post('/notes/resolve', noteHandler((req, res, conn) => {
        const b = req.body || {};
        res.json(notes.resolveTargets(conn, b.targets, { selfId: Number(b.id) || 0 }));
    }));

    api.post('/notes', noteHandler((req, res, conn) => {
        noteChanged(req, res, conn, 'note_created', notes.create(conn, req.body, 'admin'), 201);
    }));

    api.get('/notes/:id', noteHandler((req, res, conn) => {
        res.json({ ...notes.get(conn, req.params.id, { rev: req.query.rev, removed: true }), history: notes.history(conn, req.params.id) });
    }));

    api.get('/notes/:id/history', noteHandler((req, res, conn) => {
        res.json({ revisions: notes.history(conn, req.params.id) });
    }));

    api.patch('/notes/:id', noteHandler((req, res, conn) => {
        const { autosave, ...input } = req.body || {};
        noteChanged(req, res, conn, 'note_updated', notes.update(conn, req.params.id, input, 'admin', { autosave: autosave === true, source: 'save', sync: true }));
    }));

    api.post('/notes/:id/restore', noteHandler((req, res, conn) => {
        noteChanged(req, res, conn, 'note_restored', notes.restore(conn, req.params.id, (req.body || {}).rev, 'admin'));
    }));

    // The trash: out of lists and links, kept with its history, put back with untrash.
    api.post('/notes/:id/trash', noteHandler((req, res, conn) => {
        noteChanged(req, res, conn, 'note_trashed', notes.trash(conn, req.params.id, 'admin'));
    }));
    api.post('/notes/:id/untrash', noteHandler((req, res, conn) => {
        noteChanged(req, res, conn, 'note_untrashed', notes.untrash(conn, req.params.id, 'admin'));
    }));

    // Permanent delete (admin only). Body { confirm: true, backup?: true }. The note's links go with it.
    const bad = (code, message, status) => new notes.NoteError(status || 400, code, message);

    api.get('/notes/:id/delete-preview', noteHandler((req, res, conn) => {
        res.json(notes.removalPreview(conn, req.params.id));
    }));

    api.delete('/notes/:id', noteHandler((req, res, conn) => removal(req, res, conn, 'note_deleted', {
        plan: () => { needConfirm(bad, req.body); notes.removalPreview(conn, req.params.id); },
        run: () => notes.remove(conn, req.params.id, req.body),
        detail: notes.removedAuditDetail,
    })));
};
