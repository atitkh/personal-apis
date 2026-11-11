// Pure geometry for the Passport globe (no DOM): an orthographic projection, horizon clipping of land rings and
// lines, great circles and lifted route arcs. Unit-disc coordinates: x east, y north (up), z toward the viewer; the
// view draws them at (cx + R x, cy - R y). A rotation is the point at the centre of the view, { lon, lat } in degrees.
//
// Clipping (as d3-geo does it, by hand): a land ring's vertices are projected; vertices with z >= 0 face the viewer.
// The ring is walked from a hidden vertex and cut into visible runs; each run starts and ends where an edge crosses the
// horizon (the chord between the two vertices meets the plane z = 0; normalised, that point is on the horizon circle).
// Every ring is counter-clockwise (land on the left, see scripts/globe-build.js) and the front hemisphere keeps that
// orientation, so after a run leaves the disc the land continues counter-clockwise along the horizon: each run is joined
// to the run whose entry is the nearest counter-clockwise from its exit, filling in the horizon arc, until the polygon
// closes. Rings with no visible vertex are dropped (no land ring at 110m contains a whole hemisphere).

const RAD = Math.PI / 180;
export const LAT_LIMIT = 80;
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 2.5;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
export const clampZoom = (z) => clamp(z, ZOOM_MIN, ZOOM_MAX);
export const clampLat = (lat) => clamp(lat, -LAT_LIMIT, LAT_LIMIT);

// [x, y, z] of (lon, lat) on the unit sphere as seen with `rot` at the centre.
export function project(lon, lat, rot) {
    const l = (lon - rot.lon) * RAD;
    const p = lat * RAD;
    const p0 = rot.lat * RAD;
    const cp = Math.cos(p);
    return [
        cp * Math.sin(l),
        Math.cos(p0) * Math.sin(p) - Math.sin(p0) * cp * Math.cos(l),
        Math.sin(p0) * Math.sin(p) + Math.cos(p0) * cp * Math.cos(l),
    ];
}
export const isFront = (v) => v[2] >= 0;

// A point lifted off the surface is hidden only when it is behind the sphere and inside the disc.
export const isVisibleLifted = (v) => v[2] >= 0 || v[0] * v[0] + v[1] * v[1] > 1;

export const toVec = (lon, lat) => {
    const p = lat * RAD;
    const l = lon * RAD;
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
export const toLonLat = (v) => [Math.atan2(v[1], v[0]) / RAD, Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD];

const ll = (p) => (Array.isArray(p) ? p : [p.lon, p.lat]);

// Angle between two points in radians.
export function distance(a, b) {
    const u = toVec(...ll(a));
    const v = toVec(...ll(b));
    return Math.atan2(Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
}

// n points [lon, lat] along the shorter great circle from a to b (both included). a, b: [lon, lat] or { lon, lat }.
export function greatCircle(a, b, n = 48) {
    const u = toVec(...ll(a));
    const v = toVec(...ll(b));
    const w = distance(a, b);
    const out = [];
    for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : k / (n - 1);
        if (w < 1e-9) { out.push(ll(a).slice()); continue; }
        const s = Math.sin(w);
        const f1 = Math.sin((1 - t) * w) / s;
        const f2 = Math.sin(t * w) / s;
        out.push(toLonLat([f1 * u[0] + f2 * v[0], f1 * u[1] + f2 * v[1], f1 * u[2] + f2 * v[2]]));
    }
    return out;
}

// Height of a route arc above the surface (in radii) at fraction t: a smooth bump, taller for longer routes.
export const arcLift = (t, w) => Math.sin(Math.PI * t) * Math.min(0.2, 0.03 + 0.11 * (w / Math.PI));

// A route as visible runs of [x, y]: the great circle sampled at n points, each lifted by arcLift.
export function routeRuns(a, b, rot, n = 48) {
    const w = distance(a, b);
    const pts = greatCircle(a, b, n).map(([lon, lat], k) => {
        const v = project(lon, lat, rot);
        const s = 1 + arcLift(n === 1 ? 0 : k / (n - 1), w);
        return [v[0] * s, v[1] * s, v[2] * s];
    });
    return splitRuns(pts, isVisibleLifted);
}

function splitRuns(pts, visible) {
    const runs = [];
    let cur = null;
    for (const p of pts) {
        if (visible(p)) {
            if (!cur) runs.push(cur = []);
            cur.push([p[0], p[1]]);
        } else cur = null;
    }
    return runs.filter((r) => r.length > 1);
}

// Where the edge p -> q (one in front, one behind) meets the horizon, as a point on the unit circle.
function crossing(p, q) {
    const t = p[2] / (p[2] - q[2]);
    const x = p[0] + t * (q[0] - p[0]);
    const y = p[1] + t * (q[1] - p[1]);
    const len = Math.hypot(x, y) || 1;
    return [x / len, y / len];
}

// A polyline on the surface (graticule) as visible runs of [x, y], cut exactly at the horizon.
export function lineRuns(points, rot) {
    const vs = points.map(([lon, lat]) => project(lon, lat, rot));
    const runs = [];
    let cur = null;
    vs.forEach((q, k) => {
        const p = vs[k - 1];
        if (isFront(q)) {
            if (!cur) {
                cur = p ? [crossing(p, q)] : [];
                runs.push(cur);
            }
            cur.push([q[0], q[1]]);
        } else if (cur) {
            cur.push(crossing(p, q));
            cur = null;
        }
    });
    return runs.filter((r) => r.length > 1);
}

const TAU = Math.PI * 2;
const angle = (p) => Math.atan2(p[1], p[0]);
const ccw = (from, to) => ((to - from) % TAU + TAU) % TAU;

// Points on the horizon going counter-clockwise from angle a0 to a1 (ends excluded), one every `step` degrees.
function horizonArc(a0, a1, step) {
    const span = ccw(a0, a1);
    const n = Math.floor(span / (step * RAD));
    const out = [];
    for (let k = 1; k <= n; k++) {
        const a = a0 + (span * k) / (n + 1);
        out.push([Math.cos(a), Math.sin(a)]);
    }
    return out;
}

// A counter-clockwise ring of [lon, lat] clipped to the front hemisphere: a list of closed polygons of [x, y].
export function clipRing(ring, rot, step = 6) {
    const vs = ring.map(([lon, lat]) => project(lon, lat, rot));
    const n = vs.length;
    const start = vs.findIndex((v) => !isFront(v));
    if (start < 0) return [vs.map((v) => [v[0], v[1]])];
    if (!vs.some(isFront)) return [];
    const runs = [];
    let run = null;
    let prev = vs[start];
    for (let k = 1; k <= n; k++) {
        const q = vs[(start + k) % n];
        if (isFront(q)) {
            if (!run) {
                const entry = crossing(prev, q);
                run = { pts: [entry], a0: angle(entry) };
            }
            run.pts.push([q[0], q[1]]);
        } else if (run) {
            const exit = crossing(prev, q);
            run.pts.push(exit);
            run.a1 = angle(exit);
            runs.push(run);
            run = null;
        }
        prev = q;
    }
    const polys = [];
    const used = new Set();
    for (const first of runs) {
        if (used.has(first)) continue;
        const poly = [];
        let cur = first;
        for (let guard = 0; guard <= runs.length; guard++) {
            used.add(cur);
            poly.push(...cur.pts);
            let next = null;
            let best = Infinity;
            for (const r of runs) {
                if (used.has(r) && r !== first) continue;
                const d = ccw(cur.a1, r.a0);
                if (d < best) { best = d; next = r; }
            }
            if (!next) break;
            poly.push(...horizonArc(cur.a1, next.a0, step));
            if (next === first) break;
            cur = next;
        }
        polys.push(poly);
    }
    return polys;
}

// The centre to start from: the visit-weighted mean of the airports, or (0, 20) with none.
export function midpoint(airports) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const a of airports) {
        const v = toVec(a.lon, a.lat);
        const w = a.visits || 1;
        x += v[0] * w;
        y += v[1] * w;
        z += v[2] * w;
    }
    if (Math.hypot(x, y, z) < 1e-6) return { lon: 0, lat: 20 };
    const [lon, lat] = toLonLat([x, y, z]);
    return { lon, lat: clampLat(lat) };
}

// SVG path data for polygons or runs in unit-disc coordinates drawn at (cx + R x, cy - R y).
export function pathData(list, cx, cy, R, close) {
    let d = '';
    for (const pts of list) {
        pts.forEach(([x, y], k) => { d += `${k ? 'L' : 'M'}${(cx + R * x).toFixed(1)} ${(cy - R * y).toFixed(1)}`; });
        if (close) d += 'Z';
    }
    return d;
}
