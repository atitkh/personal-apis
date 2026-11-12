// Settings, backup location and backup actions are for a person at the dashboard: nothing of them on /hub REST or MCP.
const fs = require('fs');
const path = require('path');

const routes = require('./__snapshots__/routes.json');
const list = Array.isArray(routes) ? routes : Object.values(routes).flat();

// The flights data-source settings (provider keys, quotas) were on /hub before the hub settings existed; they are a different thing.
const OLD = ['GET /hub/flights/settings', 'PUT /hub/flights/settings'];

describe('no settings or backups over /hub or MCP', () => {
    test('no /hub or public route is about settings or backups', () => {
        const hits = list.filter((r) => !OLD.includes(r) && !r.split(' ')[1].startsWith('/admin/api/') && /settings|backup|timezone/i.test(r.split(' ')[1]));
        expect(hits).toEqual([]);
    });

    test('the settings and backup routes are all under /admin/api', () => {
        const mine = list.filter((r) => !OLD.includes(r) && /\/(settings|backups)\b/.test(r));
        expect(mine.length).toBeGreaterThanOrEqual(6);
        expect(mine.filter((r) => !r.split(' ')[1].startsWith('/admin/api/'))).toEqual([]);
    });

    test('no MCP domain tool, tool list or key scope mentions settings or backups', () => {
        const root = path.join(__dirname, '..', 'services', 'mcp');
        const files = [];
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name))));
        walk(root);
        expect(files.length).toBeGreaterThan(6);
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            expect(`${f}: ${/services\/settings|require\('\.\.\/\.\.\/backup'\)|hub_settings|backup\./i.test(src)}`).toMatch(/: false$/);
        }
    });
});
