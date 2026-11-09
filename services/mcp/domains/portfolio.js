// MCP tool for the portfolio domain: read-only, from the same files the public /portfolio routes serve.
const fs = require('fs');
const path = require('path');
const { readJson } = require('../../../routes/portfolio/freshJson');
const { ToolError, clip, MAX_TEXT_CHARS } = require('../util');

const ATIT_DIR = path.join(__dirname, '..', '..', '..', 'routes', 'portfolio', 'atit');
const MD_DIR = path.join(ATIT_DIR, 'md');

const entries = () => {
    const data = readJson(path.join(ATIT_DIR, 'atit.json'));
    return Array.isArray(data.portfolio) ? data.portfolio : [];
};

function page(id) {
    const file = path.join(MD_DIR, `${id}.md`);
    if (!file.startsWith(MD_DIR + path.sep) || !fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
}

module.exports = {
    domain: 'portfolio',
    readScope: 'portfolio:read',
    description: "Atit's public portfolio: his projects with dates, categories, technologies, links and project pages.",
    actions: {
        list: { scope: 'portfolio:read', describe: 'list: all projects, newest data as stored (optional category, for example "Web")' },
        get: { scope: 'portfolio:read', describe: 'get: one project with its description, links and page text (id from list)' },
    },

    input(z) {
        return {
            id: z.union([z.number().int().min(0), z.string().max(20)]).optional().describe('get: the project id'),
            category: z.string().max(60).optional().describe('list: only this main category'),
        };
    },

    run(action, args) {
        if (action === 'list') {
            const want = args.category ? String(args.category).toLowerCase() : null;
            const items = entries()
                .filter((e) => !want || String(e.mainCategory || '').toLowerCase() === want)
                .map((e) => ({ id: e.id, title: e.title || '', category: e.mainCategory || '', date: e.date || '', tech: e.categories || [], hasPage: Boolean(e.more) }));
            return { count: items.length, projects: items };
        }
        if (action === 'get') {
            if (args.id == null || args.id === '') throw new ToolError('bad_request', 'The get action needs an id.');
            const e = entries().find((x) => String(x.id) === String(args.id));
            if (!e) throw new ToolError('not_found', `No portfolio project with id ${args.id}.`);
            const text = e.more ? page(e.id) : null;
            const c = clip(text, MAX_TEXT_CHARS);
            return {
                id: e.id,
                title: e.title || '',
                description: e.description || '',
                category: e.mainCategory || '',
                tech: e.categories || [],
                date: e.date || '',
                links: e.projectLink || [],
                image: e.image || null,
                video: e.video || null,
                page: c.text,
                truncated: c.truncated,
            };
        }
        throw new ToolError('bad_action', `Unknown action "${action}".`);
    },
};
