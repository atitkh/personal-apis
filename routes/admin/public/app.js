// Personal hub admin. Plain ES modules, no build step, no framework.
// app.js wires things together: session, shell, routes, command palette. Views live in views/*.js
// and export render(ctx); a new view is one file plus one register() line below.
import { h, toast, emptyState, errorState, keepFocus } from './ui.js';
import { api, setUnauthorizedHandler } from './api.js';
import * as router from './router.js';
import { createShell } from './shell.js';
import { openPalette, installShortcut, addSource, digestCommand } from './palette.js';
import { THEMES, setPreference } from './theme.js';
import { installShortcuts, showShortcuts, GO } from './shortcuts.js';
import { renderSignIn } from './views/signin.js';
import { pageSkeleton } from './skeletons.js';

router.register('overview', { title: 'Overview', icon: 'overview', nav: true, mobile: true, load: () => import('./views/overview.js') });
router.register('digests', { title: 'Digests', icon: 'digests', nav: true, mobile: true, load: () => import('./views/digests.js') });
router.register('places', { title: 'Places', icon: 'places', nav: true, load: () => import('./views/places.js') });
router.register('flights', { title: 'Flights', icon: 'flights', nav: true, load: () => import('./views/flights.js') });
router.register('keys', { title: 'API keys', short: 'Keys', icon: 'keys', nav: true, mobile: true, load: () => import('./views/keys.js') });
router.register('agents', { title: 'Agent access', short: 'Agents', icon: 'agents', nav: true, mobile: true, load: () => import('./views/agents.js') });
router.register('backups', { title: 'Backups', icon: 'backups', nav: true, load: () => import('./views/backups.js') });
router.register('portfolio', { title: 'Portfolio', icon: 'portfolio', nav: true, load: () => import('./views/portfolio.js') });
router.register('activity', { title: 'Activity', icon: 'activity', nav: true, load: () => import('./views/activity.js') });
router.register('settings', { title: 'Settings', icon: 'settings', nav: true, load: () => import('./views/settings.js') });

const root = document.getElementById('app');
let session = null;
let shell = null;
let renderToken = 0;
let cleanups = [];
let current = null;

function runCleanups() {
    for (const fn of cleanups) { try { fn(); } catch (e) { /* ignore */ } }
    cleanups = [];
}

async function signOut() {
    try { await api('/logout', { method: 'POST' }); } catch (e) { /* already out */ }
    endSession();
    toast('Signed out', { kind: 'info' });
}

// `ended`: the server said the session is gone (expired, or signed out elsewhere). The sign-in screen
// says so, and signing in returns to the same #/route.
function endSession({ ended = false } = {}) {
    const returnTo = location.hash;
    session = null;
    shell = null;
    current = null;
    renderToken++;
    runCleanups();
    for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
    showSignIn({ ended, returnTo });
}

function showSignIn({ ended = false, returnTo = '' } = {}) {
    const title = router.get(router.parse(returnTo).name);
    renderSignIn(root, async () => {
        session = await api('/session');
        if (returnTo && returnTo !== location.hash) history.replaceState(null, '', returnTo);
        startApp();
    }, { note: ended ? `Your session ended. Sign in again to go back to ${title ? title.title : 'where you were'}.` : '' });
}

function notFound(name) {
    return emptyState({
        title: 'There is no page here.',
        text: `Nothing lives at #/${name}. Pick a section from the menu, or press Ctrl K to search.`,
        iconName: 'warn',
        action: h('a', { class: 'btn', href: router.href('overview'), text: 'Go to the overview' }),
    });
}

// A view file that failed to download (offline, hub down) stays failed in the browser's module map, so
// later tries import it under a fresh URL and keep the module that loaded. A failed download reads like
// any other network failure.
const views = new Map();
const failedViews = new Set();
async function loadView(name, def) {
    if (views.has(name)) return views.get(name);
    try {
        const mod = await (failedViews.has(name) ? import(`./views/${name}.js?retry=${Date.now()}`) : def.load());
        views.set(name, mod);
        return mod;
    } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        failedViews.add(name);
        const err = new Error('The hub did not answer.');
        err.network = true;
        throw err;
    }
}

// Renders the route. `soft` keeps the current content until the new one is ready (no skeleton flash);
// used when a view refreshes itself or moves within the same section.
async function renderRoute(route, { soft = false, focus = false } = {}) {
    if (!shell) return;
    const token = ++renderToken;
    const def = router.get(route.name);
    shell.setRoute(route.name, def ? def.title : 'Not found');
    if (!soft) {
        runCleanups();
        shell.content.replaceChildren(pageSkeleton(route));
    }
    let node;
    const mine = []; // this render's timers and listeners; they replace the previous render's once it shows
    try {
        if (!def) node = notFound(route.name);
        else {
            const mod = await loadView(route.name, def);
            node = await mod.render({
                route,
                api,
                rerender: () => renderRoute(router.parse(), { soft: true }),
                onCleanup: (fn) => mine.push(fn),
                isCurrent: () => token === renderToken,
                signOut,
            });
        }
    } catch (err) {
        if (!session || err.status === 401) return;
        node = errorState({
            err,
            what: def ? def.title : 'This page',
            retry: () => renderRoute(router.parse(), { soft: true }),
        });
    }
    if (token !== renderToken || !shell) {
        for (const fn of mine) { try { fn(); } catch (e) { /* ignore */ } }
        return;
    }
    runCleanups();
    cleanups = mine;
    // A soft render (same section) keeps keyboard focus on the element with the same data-key.
    if (soft) {
        const hadFocus = shell.content.contains(document.activeElement);
        keepFocus(shell.content, () => shell.content.replaceChildren(node));
        // The focused element went away (e.g. Retry worked): land on the page title, not on <body>.
        if (hadFocus && !shell.content.contains(document.activeElement)) shell.title.focus({ preventScroll: true });
    } else shell.content.replaceChildren(node);
    if (focus) shell.title.focus({ preventScroll: true });
    if (!soft) window.scrollTo(0, 0);
    refreshBadges();
}

// The side menu shows how many found flights wait for review (the Flights view refreshes it after each change).
let badgeAt = 0;
async function refreshBadges() {
    const at = ++badgeAt;
    try {
        const r = await api('/flights/candidates?limit=1');
        if (at === badgeAt && shell) shell.setBadge('flights', r.counts.pending);
    } catch (e) { /* the badge is a hint; leave it as it was */ }
}

function onRoute(route, { initial }) {
    const sameView = Boolean(current && current.name === route.name);
    current = route;
    // Focus moves to the page title only when the section changes, so screen readers hear where they are.
    renderRoute(route, { focus: !initial && !sameView, soft: sameView });
}

let routerStarted = false;
function startApp() {
    shell = createShell({ session, onSignOut: signOut, openPalette, api });
    root.replaceChildren(shell.el);
    if (!routerStarted) {
        routerStarted = true;
        router.start(onRoute);
    } else {
        onRoute(router.parse(), { initial: true });
    }
}

/* ---------- palette commands ---------- */

addSource(() => router.all().map((r, i) => {
    const go = GO.find(([, name]) => name === r.name);
    return {
        id: `view:${r.name}`, group: 'Go to', icon: r.icon, label: r.title, keywords: `${r.short || ''} page view`, order: i,
        keys: go ? ['G', go[0].toUpperCase()] : null,
        run: () => router.navigate(router.href(r.name)),
    };
}));

addSource(() => [
    {
        id: 'act:backup', group: 'Actions', icon: 'backup', label: 'Back up now', keywords: 'backup database copy', order: 1,
        run: async () => {
            const done = toast('Backing up…', { kind: 'info' });
            try {
                await api('/backups', { method: 'POST' });
                done();
                toast('Backup finished');
                if (current && ['backups', 'overview'].includes(current.name)) renderRoute(router.parse(), { soft: true });
            } catch (err) {
                done();
                toast(`The backup failed. ${err.message}`, { kind: 'bad' });
            }
        },
    },
    {
        id: 'act:place', group: 'Actions', icon: 'plus', label: 'New place', keywords: 'add place location street', order: 3,
        run: () => router.navigate(router.href('places', [], { new: '1' })),
    },
    {
        id: 'act:queue', group: 'Actions', icon: 'places', label: 'Places that need a name', keywords: 'queue suggestions unnamed streets spots', order: 4,
        run: () => router.navigate(router.href('places', [], { tab: 'queue' })),
    },
    {
        id: 'act:flight', group: 'Actions', icon: 'plus', label: 'Add flight', keywords: 'new flight add trip airport plane', order: 5,
        run: () => router.navigate(router.href('flights', [], { tab: 'flights', new: '1' })),
    },
    {
        id: 'act:found', group: 'Actions', icon: 'flights', label: 'Flights waiting for review', keywords: 'found flights queue candidates accept dismiss', order: 6,
        run: () => router.navigate(router.href('flights', [], { tab: 'found' })),
    },
    {
        id: 'act:key', group: 'Actions', icon: 'plus', label: 'Create key', keywords: 'new api key', order: 2,
        run: () => router.navigate(router.href('keys', [], { new: '1' })),
    },
    ...THEMES.map(([value, label], i) => ({
        id: `theme:${value}`, group: 'Actions', icon: value === 'dark' ? 'moon' : value === 'light' ? 'sun' : 'system',
        label: `Theme: ${label.toLowerCase()}`, keywords: 'theme appearance dark light colour color', order: 10 + i,
        run: () => { setPreference(value); toast(`Theme set to ${label.toLowerCase()}`, { kind: 'info' }); },
    })),
    { id: 'act:signout', group: 'Actions', icon: 'signout', label: 'Sign out', keywords: 'log out logout', order: 20, run: signOut },
    { id: 'act:shortcuts', group: 'Actions', icon: 'keyboard', label: 'Keyboard shortcuts', keywords: 'keys keyboard help hotkeys', keys: ['?'], order: 21, run: () => showShortcuts() },
    { id: 'act:rail', group: 'Actions', icon: 'collapse', label: 'Show or hide the side menu', keywords: 'rail sidebar menu collapse expand', keys: ['['], order: 22, run: () => shell && shell.toggleRail() },
]);

addSource(async () => {
    const [daily, weekly, keys, places, trips] = await Promise.all([
        api('/digests?kind=daily&limit=200').catch(() => ({ digests: [] })),
        api('/digests?kind=weekly&limit=60').catch(() => ({ digests: [] })),
        api('/keys').catch(() => ({ keys: [] })),
        api('/places').catch(() => ({ places: [] })),
        api('/flights?limit=200').catch(() => ({ flights: [] })),
    ]);
    return [
        ...daily.digests.map((d, i) => digestCommand(d, 100 + i)),
        ...weekly.digests.map((d, i) => digestCommand(d, 400 + i)),
        ...keys.keys.filter((k) => !k.revoked_at).map((k, i) => ({
            id: `key:${k.id}`, group: 'Keys', icon: 'keys', label: k.name, hint: k.scopes.join(', '), keywords: `key ${k.scopes.join(' ')}`, order: 600 + i,
            run: () => router.navigate(router.href('keys', [String(k.id)])),
        })),
        // Names and kinds only: rule values never go into the palette.
        ...places.places.map((p, i) => ({
            id: `place:${p.id}`, group: 'Places', icon: 'places', label: p.label, hint: p.kind, keywords: `place ${p.kind}`, order: 800 + i,
            run: () => router.navigate(router.href('places', [String(p.id)])),
        })),
        // Route, number and date only: never the booking reference, seat or notes.
        ...trips.flights.map((f, i) => ({
            id: `flight:${f.id}`, group: 'Flights', icon: 'flights', label: `${f.airline_iata} ${f.flight_number}  ${f.origin_iata} to ${f.dest_iata}`, hint: f.dep_local_date,
            keywords: `flight ${f.airline_name || ''} ${f.origin_iata} ${f.dest_iata} ${f.dep_local_date}`, order: 1000 + i,
            run: () => router.navigate(router.href('flights', [String(f.id)])),
        })),
    ];
});

/* ---------- start ---------- */

setUnauthorizedHandler(() => {
    if (!session) return;
    endSession({ ended: true });
});
installShortcut(() => Boolean(session && shell));
installShortcuts({
    enabled: () => Boolean(session && shell),
    go: (name) => router.navigate(router.href(name)),
    toggleRail: () => shell && shell.toggleRail(),
    openPalette,
    content: () => shell && shell.content,
});

(async () => {
    try {
        const s = await api('/session');
        session = s.authenticated ? s : null;
    } catch (e) {
        session = null;
    }
    if (session) startApp();
    else showSignIn();
})();
