// Hash router. A route is `#/<name>/<part>/<part>?<query>`, e.g. #/digests/daily/2026-11-08 or
// #/activity?type=agents. Views register here; a new view is one module plus one register() call.
const routes = new Map();
let listener = null;

// def: { title, icon, nav (show in the rail), group (overview, data, access, system: the rail section), mobile (show in the bottom bar), load: () => import(...) }
export function register(name, def) {
    routes.set(name, { name, ...def });
}

export const all = () => [...routes.values()];
export const get = (name) => routes.get(name);
export const DEFAULT = 'overview';

export function parse(hash = location.hash) {
    const raw = hash.replace(/^#\/?/, '');
    const [path, qs = ''] = raw.split('?');
    const parts = path.split('/').filter(Boolean).map((p) => {
        try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    const name = parts.shift() || DEFAULT;
    return { name, parts, query: new URLSearchParams(qs), known: routes.has(name) };
}

export function href(name, parts = [], query = null) {
    const path = [name, ...parts].map((p) => encodeURIComponent(p)).join('/');
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
    return `#/${path}${qs ? `?${qs}` : ''}`;
}

export function navigate(target, { replace = false } = {}) {
    const next = target.startsWith('#') ? target : `#/${target}`;
    if (next === location.hash) return;
    if (replace) {
        history.replaceState(null, '', next);
        if (listener) listener(parse(), { replaced: true });
    } else {
        location.hash = next;
    }
}

// Updates the query of the current route without a new history entry and without re-rendering
// (for filters and search fields that already show their own state).
export function setQuery(query) {
    const cur = parse();
    const merged = Object.fromEntries(cur.query.entries());
    Object.assign(merged, query);
    history.replaceState(null, '', href(cur.name, cur.parts, merged));
}

export function start(onRoute) {
    listener = onRoute;
    window.addEventListener('hashchange', () => onRoute(parse(), {}));
    if (!location.hash) history.replaceState(null, '', href(DEFAULT));
    onRoute(parse(), { initial: true });
}
