// Permanent delete is for a person at the dashboard: it must not exist on /hub REST or over MCP.
// The route table (tests/__snapshots__/routes.json) is the record of every route; this test reads it.
const fs = require('fs');
const path = require('path');

const routes = require('./__snapshots__/routes.json');
const list = Array.isArray(routes) ? routes : Object.values(routes).flat();

// The two old /hub/places deletes were removed (never used); nothing may be added back.
const LEGACY_HUB_DELETES = [];
// Agent actions that take a part out of a record (not a record): trip items are a trip's itinerary lines, which an
// agent with trips:agent-write may add, change and take out again (plan decision 9). The trip itself stays and
// deleting it remains dashboard-only. Anything added here is a decision, not a convenience.
const MCP_PART_REMOVALS = ['trips.remove_item'];

describe('no delete over /hub or MCP', () => {
    test('/hub has no DELETE route at all', () => {
        const hub = list.filter((r) => /^DELETE \/hub\b/.test(r));
        expect(hub.sort()).toEqual([...LEGACY_HUB_DELETES].sort());
    });

    test('no /hub route is named like a delete', () => {
        const named = list.filter((r) => r.includes('/hub/') && /delete|destroy|purge|forget|dismissed$/i.test(r.split(' ')[1]));
        expect(named).toEqual([]);
    });

    test('every dashboard delete route is under /admin/api', () => {
        const deletes = list.filter((r) => r.startsWith('DELETE '));
        const outside = deletes.filter((r) => !r.startsWith('DELETE /admin/api/') && !LEGACY_HUB_DELETES.includes(r));
        expect(outside).toEqual([]);
    });

    test('no MCP tool action can delete or remove', () => {
        const dir = path.join(__dirname, '..', 'services', 'mcp', 'domains');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
        expect(files.length).toBeGreaterThanOrEqual(6);
        for (const f of files) {
            const def = require(path.join(dir, f));
            const names = Object.keys(def.actions || {});
            const named = names.filter((a) => /delete|remove|destroy|purge|forget/i.test(a) && !MCP_PART_REMOVALS.includes(`${def.domain}.${a}`));
            expect(named).toEqual([]);
        }
    });
});
