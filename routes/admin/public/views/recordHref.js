// Where a record opens in the dashboard, per domain. Used by Search and by the Linked section of a drawer.
import { href } from '../router.js';

const MAP = {
    digests: (id) => { const [kind, period] = String(id).split('/'); return href('digests', [kind, period]); },
    deadlines: (id) => href('deadlines', [String(id)]),
    preferences: (id) => href('preferences', [String(id)]),
    places: (id) => href('places', [String(id)]),
    flights: (id) => href('flights', [String(id)]),
    trips: (id) => href('trips', [String(id)]),
    lifelog: (id, date) => href('lifelog', ['episode', String(id)], date ? { date } : null),
    portfolio: (id, date, title) => href('portfolio', [], { q: title || String(id) }),
    entities: (id) => href('entities', [String(id)]),
    notes: (id) => href('notes', [String(id)]),
};

export const recordHref = (domain, id, extra = {}) => (MAP[domain] || (() => href(domain)))(id, extra.date, extra.title);
