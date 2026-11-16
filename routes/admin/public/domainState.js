// Which domains are switched off, shared by the rail, the command palette, the Overview board and the
// domain pages' notice. The list comes from GET /domains; if it cannot be read there is no list and nothing
// is marked (a missing answer is never taken for "on").
import { api } from './api.js';

// Route name -> domain name for the pages that show a domain's records. Graph, search and the rest are not
// domains, so they have no entry. This is the one place that says which page belongs to which domain.
export const ROUTE_DOMAIN = {
    digests: 'digests',
    places: 'places',
    flights: 'flights',
    trips: 'trips',
    lifelog: 'lifelog',
    deadlines: 'deadlines',
    preferences: 'preferences',
    entities: 'entities',
    portfolio: 'portfolio',
};
export const domainOfRoute = (routeName) => ROUTE_DOMAIN[routeName] || null;

let list = null; // null = not known
const subs = new Set();
const notify = () => { for (const fn of [...subs]) { try { fn(); } catch (e) { /* a listener must not break the others */ } } };

export const all = () => list;
export const get = (name) => (list && list.find((d) => d.name === name)) || null;
// True only when the hub said the domain is off.
export const isOff = (name) => { const d = name ? get(name) : null; return Boolean(d) && d.enabled === false; };

export function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

export async function refresh() {
    try {
        const res = await api('/domains');
        list = Array.isArray(res.domains) ? res.domains : null;
    } catch (e) {
        list = null;
    }
    notify();
    return list;
}

// Takes a list the hub just returned (the Overview fetches it too).
export function replace(domains) {
    list = Array.isArray(domains) ? domains : null;
    notify();
}

// Applies a change the hub has accepted (enabled and/or mcpMode) so every listener repaints at once.
export function patch(name, fields) {
    if (!list) return;
    list = list.map((d) => (d.name === name ? { ...d, ...fields } : d));
    notify();
}

export async function setEnabled(name, enabled) {
    await api(`/domains/${encodeURIComponent(name)}`, { method: 'PUT', body: { enabled } });
    patch(name, { enabled });
}

export async function setMode(name, mode) {
    await api(`/domains/${encodeURIComponent(name)}/mcp`, { method: 'PUT', body: { mode } });
    patch(name, { mcpMode: mode });
}

export function reset() {
    list = null;
    notify();
}
