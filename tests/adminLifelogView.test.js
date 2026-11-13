// The dashboard Lifelog page: wired in everywhere a page must be, every API call names a real admin lifelog route,
// the pieces the brief asks for are present, and nothing private is stored in the browser. Parsing of the module is
// covered by "every admin module parses" in admin.test.js (it lists the views folder).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../routes/admin/public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const view = read('views/lifelog.js');

describe('Lifelog page: wiring', () => {
    test('is registered with a nav entry, a free shortcut, an icon, a skeleton and palette entries', () => {
        expect(read('app.js')).toMatch(/router\.register\('lifelog', \{ title: 'Lifelog', icon: 'lifelog', nav: true, group: 'data', load: \(\) => import\('\.\/views\/lifelog\.js'\) \}\)/);
        const shortcuts = read('shortcuts.js');
        expect(shortcuts).toContain("['l', 'lifelog', 'Lifelog']");
        const letters = [...shortcuts.matchAll(/^\s+\['(\w)', '\w+', '[^']+'\],$/gm)].map((m) => m[1]);
        expect(new Set(letters).size).toBe(letters.length);
        expect(read('ui.js')).toMatch(/^\s+lifelog: \[/m);
        expect(read('skeletons.js')).toMatch(/^\s+lifelog: \(\) => wrap\('view lifelog'/m);
        const app = read('app.js');
        for (const text of ["label: 'Open Lifelog'", "label: 'New episode'", "label: 'Add note'", "{ new: 'episode' }", "{ new: 'note' }"]) expect(app).toContain(text);
        expect(read('style.css')).toContain('.lifelog-strip');
    });
});

describe('Lifelog page: calls and content', () => {
    test('every API call names an admin lifelog route with the right method', () => {
        const routes = new Set([...fs.readFileSync(path.join(__dirname, '../routes/admin/api/lifelog.js'), 'utf8')
            .matchAll(/api\.(get|post|patch|delete)\('(\/lifelog[^']*)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2].replace(/:\w+/g, ':x')}`));
        const calls = [...view.matchAll(/ctx\.api\((['`])(\/lifelog[^'`]*)\1(?:,\s*\{\s*method:\s*'(\w+)')?/g)]
            .map((m) => `${m[3] || 'GET'} ${m[2].replace(/\?.*$/, '').replace(/\$\{[^}]*\}/g, ':x')}`);
        expect(calls.length).toBeGreaterThanOrEqual(10);
        for (const call of new Set(calls)) expect({ call, known: routes.has(call) }).toEqual({ call, known: true });
        // the admin API has no episode delete, so the page must not call one
        expect(routes.has('DELETE /lifelog/episodes/:x')).toBe(false);
    });

    test('has the day view, panels, dialogs, drawer sections and the privacy copy', () => {
        for (const text of ['Raw lines can describe people and places: handle with care.', 'Show raw lines (', 'Previous day', 'Next day', "'Today'",
            'lifelog-strip', 'lifelog-ticks', 'New episode', 'Add note', 'Forget a time range', 'deleteDialog(', 'forget-preview', 'confirm: true',
            '`Linked lines, ${', '`History, ${', "'Unlink'", "'Restore'", 'This episode is cancelled', 'Sources', 'Storage:', "role: 'search'",
            'Custom…', 'place_item']) {
            expect(view).toContain(text);
        }
        expect(view).toContain("href('lifelog', ['episode', String(id)], { date: d })");
    });

    test('server text goes in as text and nothing is kept in browser storage', () => {
        expect(view).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
        expect(view).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    });

    test('hub-zone time helpers round-trip a local input across a zone offset', () => {
        const src = view.replace(/^import[\s\S]*?from '\.\.\/router\.js';/m, '').replace(/export async function render[\s\S]*$/, '').replace(/\bexport /g, '');
        // eslint-disable-next-line no-new-func
        const mod = new Function(`${src}\nreturn { setTz: (z) => { tz = z; }, startOfDay, toLocalInput, fromLocalInput };`)();
        mod.setTz('America/Chicago');
        expect(mod.fromLocalInput('2026-11-13T14:05')).toBe('2026-11-13T20:05:00.000Z');
        expect(mod.toLocalInput('2026-11-13T20:05:00.000Z')).toBe('2026-11-13T14:05');
        expect(new Date(mod.startOfDay('2026-11-13')).toISOString()).toBe('2026-11-13T06:00:00.000Z');
        mod.setTz('Asia/Kathmandu');
        expect(mod.fromLocalInput('2026-11-13T14:05')).toBe('2026-11-13T08:20:00.000Z');
    });
});
