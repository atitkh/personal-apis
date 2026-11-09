// MCP tool for the digests domain. Reuses services/digests.js, so revisions, the hand-edit guard and
// the search index behave exactly as through PUT/PATCH /hub/digests.
const digests = require('../../digests');
const { ToolError, clip, MAX_TEXT_CHARS } = require('../util');

const BRIEF_COUNT = 3;
const BRIEF_CHARS = 600;

function need(value, what, action) {
    if (value == null || value === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`);
    return value;
}

function shape(d, max) {
    const body = clip(d.body, max);
    return {
        kind: d.kind,
        period: d.period,
        rev: d.rev,
        revisions: d.revisions,
        source: d.source,
        actor: d.actor,
        model: d.model,
        meta: d.meta,
        revisedAt: d.revisedAt,
        truncated: body.truncated,
        body: body.text,
    };
}

module.exports = {
    domain: 'digests',
    readScope: 'digests:read',
    // Results carry text built from calendar and email, so they are marked as data (see util.DATA_NOTE).
    untrusted: true,
    description: "Atit's daily and weekly digests: dated narratives of his days (period 2026-11-08) and weeks (period 2026-W45).",
    actions: {
        recent: { scope: 'digests:read', describe: 'recent: the newest digests with their text (kind, count 1-7, default 3)' },
        get: { scope: 'digests:read', describe: 'get: one digest (kind, period, optional rev)' },
        search: { scope: 'digests:read', describe: 'search: full-text search, returns snippets (query, optional kind, limit 1-20)' },
        edit: { scope: 'digests:edit', write: true, describe: 'edit: replace the text of an existing digest; adds a revision, the old text is kept (kind, period, body, optional note)' },
        publish: {
            scope: 'digests:publish',
            write: true,
            describe: 'publish: store a generated digest as the nightly job does; repeating it is safe, a hand-edited digest is kept unless force is set (kind, period, body, optional model, sources like {"calendar":"ok","email":"failed"}, force)',
        },
    },

    // Fields for write actions are only offered to a key that can use them.
    input(z, actions) {
        const shape = {
            kind: z.enum(Object.keys(digests.PERIOD_RE)).optional().describe('daily (default) or weekly'),
            period: z.string().max(10).optional().describe('2026-11-08 for daily, 2026-W45 for weekly'),
        };
        if (actions.includes('get')) shape.rev = z.number().int().positive().optional().describe('get: a past revision');
        if (actions.includes('recent')) shape.count = z.number().int().min(1).max(7).optional().describe('recent: how many (default 3)');
        if (actions.includes('search')) {
            shape.query = z.string().max(200).optional().describe('search: words to look for');
            shape.limit = z.number().int().min(1).max(20).optional().describe('search: how many results (default 10)');
        }
        if (actions.includes('edit') || actions.includes('publish')) {
            shape.body = z.string().max(70000).optional().describe('edit/publish: the full markdown text');
        }
        if (actions.includes('edit')) shape.note = z.string().max(200).optional().describe('edit: why it changed');
        if (actions.includes('publish')) {
            shape.model = z.string().max(100).optional().describe('publish: the model that wrote it');
            shape.sources = z.record(z.string().max(40), z.string().max(40)).optional()
                .describe('publish: health of each source, for example {"calendar":"ok","email":"failed"}');
            shape.force = z.boolean().optional().describe('publish: replace a hand-edited digest');
        }
        return shape;
    },

    run(action, args, { db, key }) {
        const kind = args.kind || 'daily';
        switch (action) {
        case 'recent': {
            const items = digests.recent(db, kind, args.count || 3);
            const each = Math.floor(MAX_TEXT_CHARS / Math.max(items.length, 1));
            return { kind, digests: items.map((d) => shape(d, each)) };
        }
        case 'get':
            return shape(digests.get(db, kind, need(args.period, 'a period', action), { rev: args.rev }), MAX_TEXT_CHARS);
        case 'search':
            return { results: digests.search(db, need(args.query, 'a query', action), { kind: args.kind, limit: args.limit || 10 }) };
        case 'edit':
            return digests.edit(db, kind, need(args.period, 'a period', action), {
                body: need(args.body, 'a body', action), note: args.note, actor: key.name,
            });
        case 'publish':
            return digests.put(db, kind, need(args.period, 'a period', action), {
                body: need(args.body, 'a body', action),
                source: 'generated',
                actor: key.name,
                model: args.model,
                meta: args.sources ? { sources: args.sources } : undefined,
                force: args.force === true,
            });
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },

    // For hub_overview: the last few daily digests, shortened.
    brief(db) {
        return digests.recent(db, 'daily', BRIEF_COUNT).map((d) => {
            const c = clip(d.body, BRIEF_CHARS);
            return { kind: d.kind, period: d.period, rev: d.rev, truncated: c.truncated, text: c.text };
        });
    },
};
