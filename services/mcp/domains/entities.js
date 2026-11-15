// MCP tool for the entities domain: people, projects, organizations and topics that links point at. Reuses
// services/entities.js, so validation and revisions behave exactly as through /hub/entities. Agents may read (list,
// get, find) and, in write mode with entities:agent-write, add and edit. There is no way to delete or restore over MCP
// (a person does that at the dashboard). The audit row (mcp_call) never holds arguments or results.
const entities = require('../../entities');
const links = require('../../links');
const briefing = require('../../briefing');
const { ToolError } = require('../util');

const LIST_MAX = 100;

const clean = ({ created_at: _c, updated_by: _u, ...out }) => out;

module.exports = {
    domain: 'entities',
    readScope: 'entities:read',
    // Names, aliases and notes are free text written by people and agents, so results are marked as data.
    untrusted: true,
    description: "Atit's entities: the people, projects, organizations and topics his records can point at (links). "
        + `Each has a kind (${entities.KINDS.join(', ')}), a name, optional aliases (other names it goes by) and notes. `
        + 'Use find to turn a name such as "Kunjal" into an id, then get to see what is linked to it.',
    actions: {
        list: { scope: 'entities:read', describe: `list: entities by kind then name (optional kind, q = part of the name, an alias or the notes; limit 1-${LIST_MAX})` },
        get: { scope: 'entities:read', describe: 'get: one entity by id, with the records linked to it (only domains you can read)' },
        find: { scope: 'entities:read', describe: 'find: entities whose name or alias equals name (any case); use it to resolve a name to an id' },
        add: { scope: 'entities:agent-write', write: true, describe: 'add: create an entity (kind and name required; aliases up to 10, notes up to 2000 characters). The same kind and name cannot exist twice' },
        edit: { scope: 'entities:agent-write', write: true, describe: 'edit: change an entity by id (any of kind, name, aliases, notes; null clears aliases or notes; optional note = why). Earlier versions are kept' },
    },

    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        if (has('list', 'add', 'edit', 'find')) shape.kind = z.string().max(20).optional().describe(`${entities.KINDS.join(', ')}`);
        if (has('list')) {
            shape.q = z.string().max(80).optional().describe('list: part of the name, an alias or the notes');
            shape.limit = z.number().int().min(1).max(LIST_MAX).optional().describe('list: how many');
        }
        if (has('get', 'edit')) shape.id = z.number().int().positive().optional().describe('get/edit: the entity id');
        if (has('find', 'add', 'edit')) shape.name = z.string().max(120).optional().describe('find: the name or alias to look for; add/edit: the entity name');
        if (has('add', 'edit')) {
            shape.aliases = z.array(z.string().max(60)).max(10).nullable().optional().describe('add/edit: other names it goes by');
            shape.notes = z.string().max(2000).nullable().optional().describe('add/edit: notes');
            shape.note = z.string().max(200).optional().describe('edit: why it changed');
        }
        return shape;
    },

    run(action, args, { db, key }) {
        const need = (v, what) => { if (v == null || v === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`); return v; };
        switch (action) {
        case 'list': {
            const r = entities.list(db, { kind: args.kind, q: args.q, limit: args.limit || LIST_MAX });
            return { count: r.entities.length, total: r.total, entities: r.entities.map(clean) };
        }
        case 'get': {
            const e = entities.get(db, need(args.id, 'an id'));
            return { ...clean(e), ...links.listFor(db, 'entities', String(e.id), { visible: briefing.visibleDomainsFor(db, key) }) };
        }
        case 'find': {
            const r = entities.find(db, need(args.name, 'a name'), { kind: args.kind });
            return { count: r.count, entities: r.entities.map(clean) };
        }
        case 'add': {
            need(args.kind, 'a kind');
            need(args.name, 'a name');
            const input = { kind: args.kind, name: args.name };
            if (args.aliases !== undefined) input.aliases = args.aliases;
            if (args.notes !== undefined) input.notes = args.notes;
            return entities.create(db, input, key.name);
        }
        case 'edit': {
            const input = {};
            for (const k of ['kind', 'name', 'aliases', 'notes', 'note']) if (args[k] !== undefined) input[k] = args[k];
            return entities.update(db, need(args.id, 'an id'), input, key.name);
        }
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
