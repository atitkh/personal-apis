// The dashboard Trips page: it is wired in everywhere a page must be, every API call it makes names a real admin
// route, and the pieces the brief asks for are present. Parsing and served-as-JavaScript for the new module is
// covered by "every admin module parses" in admin.test.js (it lists the views folder).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../routes/admin/public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const view = read('views/trips.js');

describe('Trips page: wiring', () => {
    test('is registered with a nav entry, a free shortcut, an icon, a skeleton and palette entries', () => {
        expect(read('app.js')).toMatch(/router\.register\('trips', \{ title: 'Trips', icon: 'trips', nav: true, group: 'data', load: \(\) => import\('\.\/views\/trips\.js'\) \}\)/);
        const shortcuts = read('shortcuts.js');
        expect(shortcuts).toContain("['t', 'trips', 'Trips']");
        const letters = [...shortcuts.matchAll(/^\s+\['(\w)', '\w+', '[^']+'\],$/gm)].map((m) => m[1]);
        expect(new Set(letters).size).toBe(letters.length);
        expect(read('ui.js')).toMatch(/^\s+trips: \[/m);
        expect(read('skeletons.js')).toMatch(/^\s+trips: \(\) => wrap\('view trips'/m);
        const app = read('app.js');
        expect(app).toContain("id: 'act:trip'");
        expect(app).toContain("router.href('trips', [], { new: '1' })");
        expect(app).toContain('`trip:${t.id}`');
    });

    test('the activity page already words every trip action', () => {
        const activity = read('views/activity.js');
        const actions = ['trip_created', 'trip_updated', 'trip_restored', 'trip_flight_linked', 'trip_flight_unlinked', 'trip_item_added',
            'trip_item_updated', 'trip_item_removed', 'trip_suggestion_accepted', 'trip_suggestion_dismissed', 'trip_suggestions_restored', 'trip_deleted'];
        for (const a of actions) {
            expect(activity).toContain(`case '${a}':`);
            expect(activity).toContain(`${a}:`);
        }
        expect(activity).toContain("['trips', 'Trips']");
    });
});

describe('Trips page: calls and content', () => {
    test('every API call names an admin trips route with the right method', () => {
        const routes = new Set([...fs.readFileSync(path.join(__dirname, '../routes/admin/api/trips.js'), 'utf8')
            .matchAll(/api\.(get|post|patch|delete)\('(\/trips[^']*)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2].replace(/:\w+/g, ':x')}`));
        const calls = [...view.matchAll(/ctx\.api\((['`])(\/trips[^'`]*)\1(?:,\s*\{\s*method:\s*'(\w+)')?/g)]
            .map((m) => `${m[3] || 'GET'} ${m[2].replace(/\?.*$/, '').replace(/\$\{[^}]*\}/g, ':x')}`);
        expect(calls.length).toBeGreaterThanOrEqual(12);
        for (const call of new Set(calls)) expect({ call, known: routes.has(call) }).toEqual({ call, known: true });
    });

    test('has the tabs, the suggestions panel, the drawer sections and the plain-words copy', () => {
        for (const text of ["['upcoming', 'Upcoming']", "['ongoing', 'Ongoing']", "['past', 'Past']", 'Cancelled',
            'Set your home airport in the ', 'Flights settings', ' so trips can be suggested.', 'again', 'Accept', 'Dismiss',
            '`Flights, ${', '`Deadlines, ${', '`Items, ${', '`History, ${', 'Delete permanently', 'Show reference', 'Hide reference',
            'Linking it moves it here', 'On another trip (linking moves it here)', 'This trip is cancelled', 'New trip', 'deleteDialog(',
            'status_override', "'Unlink'", 'restore-dismissed', 'stale_suggestion']) {
            expect(view).toContain(text);
        }
        expect(view).toContain("href('deadlines', [String(d.id)])");
        expect(view).toContain("href('flights', [String(f.id)])");
    });

    test('an item reference is fetched only on Show reference or Edit, and never put in a list row', () => {
        expect(view).toMatch(/const \{ reference: _ref, \.\.\.rest \}|reference: _ref/);
        expect(view).toContain('/items`');
        const row = view.slice(view.indexOf('function itemRow'), view.indexOf('async function openItemForm'));
        expect(row).not.toMatch(/item\.reference/);
        expect(row).toContain('has_reference');
    });

    test('server text goes in as text: no innerHTML anywhere', () => {
        expect(view).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    });
});
