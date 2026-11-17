// The dashboard Stats page: wired in like every page (route, shortcut, icon, skeleton), it calls only the stats
// route, and it draws with the in-house SVG charts (no library, no CDN). Parsing and served-as-JavaScript are
// covered by "every admin module parses" in admin.test.js.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../routes/admin/public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const view = read('views/stats.js');

describe('Stats page', () => {
    test('is registered in the overview group with a shortcut, an icon and a skeleton', () => {
        expect(read('app.js')).toMatch(/router\.register\('stats', \{ title: 'Stats', icon: 'stats', nav: true, group: 'overview', load: \(\) => import\('\.\/views\/stats\.js'\) \}\)/);
        const shortcuts = read('shortcuts.js');
        expect(shortcuts).toContain("['c', 'stats', 'Stats']");
        const letters = [...shortcuts.matchAll(/^\s+\['(\w)', '\w+', '[^']+'\],$/gm)].map((m) => m[1]);
        expect(new Set(letters).size).toBe(letters.length);
        expect(read('ui.js')).toMatch(/^\s+stats: \[/m);
        expect(read('skeletons.js')).toMatch(/^\s+stats: \(\) => wrap\('view stats'/m);
    });

    test('asks only for /stats with a known range, and uses no outside code', () => {
        const calls = [...view.matchAll(/ctx\.api\(`([^`]+)`/g)].map((m) => m[1]);
        expect(calls).toEqual(['/stats?range=${range}']);
        expect(view).not.toMatch(/https?:\/\//);
        expect(read('charts.js')).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
        for (const fn of ['stackedBars', 'hBars', 'donut', 'heatmap', 'lineChart']) expect(read('charts.js')).toContain(`export function ${fn}(`);
    });

    test('every chart has a text alternative', () => {
        for (const fn of ['stackedBars', 'hBars', 'donut', 'heatmap', 'lineChart']) {
            const calls = view.split(`${fn}({`).length - 1;
            const labelled = [...view.matchAll(new RegExp(`${fn}\\(\\{[\\s\\S]*?ariaLabel:`, 'g'))].length;
            expect({ fn, labelled: labelled >= calls }).toEqual({ fn, labelled: true });
        }
    });
});
