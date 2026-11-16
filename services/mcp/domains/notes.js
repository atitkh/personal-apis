// MCP tool for the notes domain: Atit's markdown notes with [[wikilinks]]. Reuses services/notes.js, so validation, revisions
// and wikilink syncing behave exactly as through /hub/notes (a note saved by an agent links what its [[wikilinks]] name,
// as the key). Agents may read (list, get, search) and, in write mode with notes:agent-write, add, append and edit. There is
// no way to delete or restore over MCP (a person does that at the dashboard). The audit row (mcp_call) never holds arguments
// or results.
const notes = require('../../notes');
const search = require('../../search');
const links = require('../../links');
const briefing = require('../../briefing');
const { ToolError, clip } = require('../util');

const LIST_MAX = 50;
const BODY_CLIP = 8000;

module.exports = {
    domain: 'notes',
    readScope: 'notes:read',
    // Titles and bodies are free text written by people, agents and jobs, so results are marked as data.
    untrusted: true,
    description: "Atit's notes: markdown pages with [[wikilinks]] to other notes, entities and records (the links appear in `get` and in links/graph). "
        + 'Each has a title, a kind (note, daily, inbox, meeting, ...), tags and a body. A body is returned clipped (truncated: true says so); use search for a piece of text. '
        + 'In a body, [[Title]] links a note or entity by exact title or alias, [[trips:3]] links a record; unresolved titles come back as `unresolved`.',
    actions: {
        list: { scope: 'notes:read', describe: `list: notes pinned first then newest, with a preview line (optional kind, tag, q = words in the title, body or tags, pinned; limit 1-${LIST_MAX})` },
        get: { scope: 'notes:read', describe: `get: one note by id with its body (clipped to ${BODY_CLIP} characters) and the records linked to it (only domains you can read)` },
        search: { scope: 'notes:read', describe: 'search: notes whose title, body or tags contain every word of q, with a snippet around the match (limit 1-20)' },
        add: { scope: 'notes:agent-write', write: true, describe: 'add: create a note (title required; body markdown up to 100000 characters; kind slug, default note; tags up to 20; pinned)' },
        append: { scope: 'notes:agent-write', write: true, describe: 'append: add text at the end of a note by id (text required, up to 20000 characters); a blank line is put between; keeps the earlier version' },
        edit: { scope: 'notes:agent-write', write: true, describe: 'edit: change a note by id (any of title, body, kind, tags, pinned; the body is replaced whole; optional note = why). Earlier versions are kept' },
    },

    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        if (has('get', 'append', 'edit')) shape.id = z.number().int().positive().optional().describe('get/append/edit: the note id');
        if (has('list', 'add', 'edit')) shape.kind = z.string().max(20).optional().describe('list: only this kind; add/edit: the kind slug (note, daily, inbox, meeting, ...)');
        if (has('list')) {
            shape.tag = z.string().max(30).optional().describe('list: only notes with this tag');
            shape.pinned = z.boolean().optional().describe('list: only pinned notes');
        }
        if (has('list', 'search')) {
            shape.q = z.string().max(200).optional().describe('list/search: words to look for (all of them must appear)');
            shape.limit = z.number().int().min(1).max(LIST_MAX).optional().describe('list/search: how many');
        }
        if (has('add', 'edit')) {
            shape.title = z.string().max(160).optional().describe('add/edit: the title');
            shape.body = z.string().max(notes.BODY_MAX).optional().describe('add/edit: the markdown body (edit replaces the whole body)');
            shape.tags = z.array(z.string().max(30)).max(20).nullable().optional().describe('add/edit: tags');
        }
        if (has('add', 'edit')) shape.pin = z.boolean().optional().describe('add/edit: pin the note');
        if (has('append')) shape.text = z.string().max(notes.APPEND_MAX).optional().describe('append: the text to add');
        if (has('edit', 'append')) shape.note = z.string().max(200).optional().describe('edit/append: why it changed');
        return shape;
    },

    run(action, args, { db, key }) {
        const need = (v, what) => { if (v == null || v === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`); return v; };
        const visible = briefing.visibleDomainsFor(db, key);
        switch (action) {
        case 'list': {
            const r = notes.list(db, { kind: args.kind, tag: args.tag, q: args.q, pinned: args.pinned, limit: args.limit || LIST_MAX });
            return { count: r.notes.length, total: r.total, notes: r.notes.map(({ created_at: _c, created_by: _b, ...n }) => n) };
        }
        case 'get': {
            const n = notes.get(db, need(args.id, 'an id'), { visible });
            const body = clip(n.body, BODY_CLIP);
            const { revisions: _r, ...rest } = n;
            return { ...rest, body: body.text, truncated: body.truncated, ...links.listFor(db, 'notes', String(n.id), { visible }) };
        }
        case 'search': {
            const terms = search.termsOf(need(args.q, 'q'));
            const rows = search.ADAPTERS.notes(db, terms, args.limit || 10);
            return { count: rows.length, notes: rows };
        }
        case 'add': {
            need(args.title, 'a title');
            const input = { title: args.title };
            for (const k of ['body', 'kind', 'tags']) if (args[k] !== undefined) input[k] = args[k];
            if (args.pin !== undefined) input.pinned = args.pin;
            return notes.create(db, input, key.name, { visible });
        }
        case 'append':
            return notes.append(db, need(args.id, 'an id'), { text: need(args.text, 'text'), note: args.note }, key.name, { visible });
        case 'edit': {
            const input = {};
            for (const k of ['title', 'body', 'kind', 'tags', 'note']) if (args[k] !== undefined) input[k] = args[k];
            if (args.pin !== undefined) input.pinned = args.pin;
            return notes.update(db, need(args.id, 'an id'), input, key.name, { visible });
        }
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
