// Geometry of the Passport globe (routes/admin/public/globe.js, a browser ES module): run in a child node process,
// because jest here loads CommonJS. Each case prints JSON that the assertions below read.
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const pub = path.join(__dirname, '../routes/admin/public');
function run(body) {
    const code = `const g = await import(${JSON.stringify(pathToFileURL(path.join(pub, 'globe.js')).href)});
const d = await import(${JSON.stringify(pathToFileURL(path.join(pub, 'globedata.js')).href)});
const area = (p) => p.reduce((s, a, k) => { const b = p[(k + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const rect = (l0, l1, a0, a1) => { const r = []; for (let l = l0; l < l1; l += 5) r.push([l, a0]); for (let a = a0; a < a1; a += 5) r.push([l1, a]);
  for (let l = l1; l > l0; l -= 5) r.push([l, a1]); for (let a = a1; a > a0; a -= 5) r.push([l0, a]); return r; };
const out = await (async () => { ${body} })();
process.stdout.write(JSON.stringify(out));`;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(res.stderr);
    return JSON.parse(res.stdout);
}

describe('globe geometry', () => {
    test('project: the centre is (0, 0, 1), 90 degrees east is on the right edge, the antipode is behind', () => {
        const o = run(`const rot = { lon: 10, lat: 20 };
            return { c: g.project(10, 20, rot), e: g.project(100, 0, { lon: 10, lat: 0 }), back: g.project(-170, -20, rot),
                     front: g.isFront(g.project(10, 20, rot)), behind: g.isFront(g.project(-170, -20, rot)), n: g.project(0, 90, { lon: 0, lat: 0 }) };`);
        expect(o.c.map((v) => +v.toFixed(6))).toEqual([0, 0, 1]);
        expect(o.e.map((v) => +v.toFixed(6))).toEqual([1, 0, 0]);
        expect(o.back[2]).toBeCloseTo(-1, 6);
        expect(o.front).toBe(true);
        expect(o.behind).toBe(false);
        expect(o.n[1]).toBeCloseTo(1, 6); // north is up
    });

    test('greatCircle: ends at both airports, points on the sphere, crosses the date line the short way', () => {
        const o = run(`const pts = g.greatCircle([170, 10], [-170, 10], 9);
            const dfw = g.greatCircle({ lon: -97, lat: 32.9 }, { lon: 2.5, lat: 49 }, 48);
            return { pts, n: dfw.length, first: dfw[0], last: dfw[47], same: g.greatCircle([5, 5], [5, 5], 3) };`);
        expect(o.pts[0][0]).toBeCloseTo(170, 6);
        expect(Math.abs(o.pts[8][0])).toBeCloseTo(170, 6);
        expect(o.pts.every(([lon]) => Math.abs(lon) >= 169.9)).toBe(true); // never through 0
        expect(Math.abs(o.pts[4][0])).toBeCloseTo(180, 4);
        expect(o.pts[4][1]).toBeGreaterThan(10); // bows toward the pole
        expect(o.n).toBe(48);
        expect(o.first[0]).toBeCloseTo(-97, 6);
        expect(o.last[1]).toBeCloseTo(49, 6);
        expect(o.same).toEqual([[5, 5], [5, 5], [5, 5]]);
    });

    test('clipRing: inside, behind, and a ring cut by the horizon closes along the short arc', () => {
        const o = run(`const rot = { lon: 0, lat: 0 };
            const inside = g.clipRing(rect(-10, 10, -10, 10), rot);
            const behind = g.clipRing(rect(150, 170, -10, 10), rot);
            const half = g.clipRing(rect(60, 120, -10, 10), rot);
            const band = g.clipRing(rect(-120, 120, -10, 10), rot);
            return { inside: inside.length, insideArea: area(inside[0]), behind: behind.length, half: half.length, halfArea: area(half[0]),
                     halfMaxX: Math.max(...half[0].map((p) => p[0])), halfR: Math.max(...half[0].map((p) => Math.hypot(...p))),
                     band: band.length, bandArea: area(band[0]) };`);
        expect(o.inside).toBe(1);
        expect(o.insideArea).toBeGreaterThan(0.1);
        expect(o.behind).toBe(0);
        expect(o.half).toBe(1);
        expect(o.halfArea).toBeGreaterThan(0.02);
        expect(o.halfArea).toBeLessThan(0.08); // the long way round would be about pi
        expect(o.halfMaxX).toBeLessThanOrEqual(1 + 1e-9);
        expect(o.halfR).toBeLessThanOrEqual(1 + 1e-9);
        expect(o.band).toBe(1);
        expect(o.bandArea).toBeGreaterThan(0.6);
        expect(o.bandArea).toBeLessThan(0.75);
    });

    test('clipRing over the real land from many viewpoints: points stay on the disc, no polygon goes the long way round', () => {
        const o = run(`const rings = d.landRings(); let maxR = 0, minA = 0, maxTotal = 0;
            for (let lon = -180; lon < 180; lon += 30) for (const lat of [-80, -30, 0, 45, 80]) {
              let total = 0;
              for (const r of rings) for (const p of g.clipRing(r, { lon, lat })) { const A = area(p); total += A; minA = Math.min(minA, A); for (const q of p) maxR = Math.max(maxR, Math.hypot(...q)); }
              maxTotal = Math.max(maxTotal, total);
            }
            return { maxR, minA, maxTotal, rings: rings.length, lakes: d.landRings(d.GLOBE_LAKES).length, size: d.GLOBE_LAND.join('').length };`);
        expect(o.maxR).toBeLessThanOrEqual(1 + 1e-9);
        expect(o.minA).toBeGreaterThan(-1e-3); // only limb slivers
        expect(o.maxTotal).toBeLessThan(Math.PI * 0.75); // land never fills the disc
        expect(o.rings).toBeGreaterThan(90);
        expect(o.lakes).toBe(1);
        expect(o.size).toBeLessThan(60000);
    });

    test('lineRuns and routeRuns: back parts are hidden, lifted arcs show past the limb', () => {
        const o = run(`const rot = { lon: 0, lat: 0 };
            const eq = []; for (let lon = -180; lon <= 180; lon += 10) eq.push([lon, 0]);
            const runs = g.lineRuns(eq, rot);
            const xs = runs.flat().map((p) => p[0]);
            const front = g.routeRuns([-20, 0], [20, 0], rot);
            const gone = g.routeRuns([150, 0], [170, 0], rot);
            const limb = g.routeRuns([60, 0], [120, 0], rot);
            return { n: runs.length, min: Math.min(...xs), max: Math.max(...xs), front: front.length, frontPts: front[0].length,
                     mid: front[0][24], gone: gone.length, limb: limb.length, limbMaxX: Math.max(...limb.flat().map((p) => p[0])),
                     lift0: g.arcLift(0, 1), liftMid: g.arcLift(0.5, Math.PI) };`);
        expect(o.n).toBe(1);
        expect(o.min).toBeCloseTo(-1, 6);
        expect(o.max).toBeCloseTo(1, 6);
        expect(o.front).toBe(1);
        expect(o.frontPts).toBe(48);
        expect(o.gone).toBe(0);
        expect(o.limb).toBe(1);
        expect(o.limbMaxX).toBeGreaterThan(1); // lifted above the horizon
        expect(o.lift0).toBe(0);
        expect(o.liftMid).toBeCloseTo(0.14, 6);
    });

    test('midpoint, clamps and path data', () => {
        const o = run(`return { m: g.midpoint([{ lon: 10, lat: 0, visits: 1 }, { lon: 30, lat: 0, visits: 1 }]), w: g.midpoint([{ lon: 0, lat: 0, visits: 3 }, { lon: 90, lat: 0, visits: 1 }]),
                     none: g.midpoint([]), z: [g.clampZoom(0.1), g.clampZoom(9), g.clampZoom(1.3)], lat: [g.clampLat(89), g.clampLat(-95)], lon: [g.wrapLon(190), g.wrapLon(-181), g.wrapLon(45)],
                     d: g.pathData([[[0, 0], [1, 1]]], 250, 250, 100, true) };`);
        expect(o.m.lon).toBeCloseTo(20, 6);
        expect(o.w.lon).toBeGreaterThan(0);
        expect(o.w.lon).toBeLessThan(45);
        expect(o.none).toEqual({ lon: 0, lat: 20 });
        expect(o.z).toEqual([0.8, 2.5, 1.3]);
        expect(o.lat).toEqual([80, -80]);
        expect(o.lon.map((v) => Math.round(v))).toEqual([-170, 179, 45]);
        expect(o.d).toBe('M250.0 250.0L350.0 150.0Z');
    });
});
