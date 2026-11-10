// What API key scopes mean, in plain words. Shared by the Keys view (chips, drawer, scope picker) and Agent
// access. A scope is `domain:action`, `domain:*` (the whole domain) or `*` (everything). Scopes not listed
// here still work; they are described generically.
import { chip, domainHue } from './ui.js';

export const CATALOGUE = [
    {
        domain: 'digests',
        title: 'Digests',
        scopes: [
            { scope: 'digests:read', label: 'Read', text: 'Read daily and weekly digests and search their text, through the agent endpoint and /hub.' },
            { scope: 'digests:edit', label: 'Edit', text: 'Correct the text of an existing digest through the agent endpoint. Every earlier version is kept.', write: true },
            { scope: 'digests:publish', label: 'Publish', text: 'Store new generated digests through the agent endpoint, as the nightly job does.', write: true },
            { scope: 'digests:write', label: 'Write', text: 'Create, edit and restore digests through the /hub REST API (the nightly job uses this).', write: true },
        ],
    },
    {
        domain: 'portfolio',
        title: 'Portfolio',
        scopes: [
            { scope: 'portfolio:read', label: 'Read', text: 'Read portfolio projects through the agent endpoint. The public site needs no key.' },
        ],
    },
    {
        domain: 'places',
        title: 'Places',
        scopes: [
            { scope: 'places:read', label: 'Read', text: 'Read your places and their rules (these include your home address) and ask which place a location is, through the agent endpoint and /hub.' },
            { scope: 'places:suggest', label: 'Suggest', text: 'File a street that no place claims yet into the "needs a name" queue, through the agent endpoint (write mode) and /hub. It cannot change any place.', write: true },
            { scope: 'places:edit', label: 'Edit', text: 'Lets an agent add new places and change existing ones (name, kind, notes and rules) through the agent endpoint, when Places is in write mode. Every earlier version is kept; deleting, restoring and naming the queue stay with you.', write: true },
            { scope: 'places:write', label: 'Write', text: 'Create, edit, restore and delete places, and accept or dismiss suggestions, through the /hub REST API. It does not let an agent edit through the agent endpoint.', write: true },
        ],
    },
    {
        domain: 'flights',
        title: 'Flights',
        scopes: [
            { scope: 'flights:read', label: 'Read', text: 'Read your flights (booking references included), trips, upcoming flights and the Passport stats through /hub.' },
            { scope: 'flights:suggest', label: 'Suggest', text: 'File a found flight (from email, the calendar or an agent) into the review queue, through the agent endpoint (write mode) and /hub. It cannot change any flight; accepting and dismissing stay with you.', write: true },
            { scope: 'flights:edit', label: 'Edit', text: 'Lets an agent add flights and change existing ones through the agent endpoint, when Flights is in write mode. Every earlier version is kept; restoring and the review queue stay with you.', write: true },
            { scope: 'flights:write', label: 'Write', text: 'Add and change flights and trips, restore older versions and change the flights settings through the /hub REST API. Needs Read as well.', write: true },
        ],
    },
    {
        domain: 'attendance',
        title: 'Attendance',
        scopes: [
            { scope: 'attendance:read', label: 'Read', text: 'Read Kerkar Creations attendance records.' },
            { scope: 'attendance:write', label: 'Write', text: 'Add attendance records.', write: true },
        ],
    },
];

const byScope = new Map(CATALOGUE.flatMap((d) => d.scopes.map((s) => [s.scope, { ...s, domain: d.domain, title: d.title }])));
const byDomain = new Map(CATALOGUE.map((d) => [d.domain, d]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// { scope, domain, title, label, text, write } for any scope string.
export function explain(scope) {
    if (scope === '*') {
        return { scope, domain: '*', title: 'Everything', label: 'Everything', text: 'Every domain and every action, including ones added later. Keep this for your own tools.', write: true };
    }
    const known = byScope.get(scope);
    if (known) return known;
    const [domain, action] = scope.split(':');
    const d = byDomain.get(domain);
    const title = d ? d.title : cap(domain || scope);
    if (action === '*') {
        return { scope, domain, title, label: 'Everything', text: `Everything in ${title}, including actions added later.`, write: true };
    }
    return { scope, domain, title, label: cap(action || ''), text: `The ${action} action on ${title}.`, write: /write|edit|publish|delete/.test(action || '') };
}

const hueOf = (domain) => {
    if (domain === '*') return 'neutral';
    const i = CATALOGUE.findIndex((d) => d.domain === domain);
    return domainHue(domain, Math.max(i, 0));
};

// "Digests: read" as a chip in the domain's colour; the full explanation is in its tooltip.
export function scopeChip(scope) {
    const e = explain(scope);
    return chip(e.domain === '*' ? 'Everything' : `${e.title}: ${e.label.toLowerCase()}`, { hue: hueOf(e.domain), title: `${scope}. ${e.text}`, cls: e.write ? 'chip-write' : '' });
}

export { hueOf as scopeHue };
