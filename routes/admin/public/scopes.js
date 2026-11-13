// What API key scopes mean, in plain words. Shared by the Keys view (chips, drawer, scope picker) and Agent
// access. A scope is `domain:action`, `domain:*` (the whole domain) or `*` (everything). Scopes not listed
// here still work; they are described generically.
import { chip, domainHue } from './ui.js';

export const CATALOGUE = [
    {
        domain: 'overview',
        title: 'Overview',
        scopes: [
            { scope: 'overview:read', label: 'Read', text: 'Use the hub overview tool: what the hub holds that this key can reach (domains, record counts, allowed actions) and a short brief of the latest digests. Leave it off for an agent that does not need it.' },
        ],
    },
    {
        domain: 'briefing',
        title: 'Briefing',
        scopes: [
            { scope: 'briefing:read', label: 'Read', text: 'Use the hub briefing tool and GET /hub/briefing: what needs attention now and what is coming up, from the domains the key can read. Turn it off for an agent that already gets these changes through a webhook.' },
        ],
    },
    {
        domain: 'digests',
        title: 'Digests',
        scopes: [
            { scope: 'digests:read', label: 'Read', text: 'Read daily and weekly digests and search their text, through the agent endpoint and /hub.' },
            { scope: 'digests:agent-write', label: 'Agent write', text: 'Write through the agent tool (the domain must also be switched to Read and write on the Overview board). Correct the text of an existing digest through the agent endpoint. Every earlier version is kept.', write: true },
            { scope: 'digests:publish', label: 'Publish', text: 'Store new generated digests through the agent endpoint, as the nightly job does.', write: true },
            { scope: 'digests:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Create, edit and restore digests through the /hub REST API (the nightly job uses this).', write: true },
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
            { scope: 'places:agent-write', label: 'Agent write', text: 'Write through the agent tool (the domain must also be switched to Read and write on the Overview board). Lets an agent add new places and change existing ones (name, kind, notes and rules) through the agent endpoint. Every earlier version is kept; deleting, restoring and naming the queue stay with you.', write: true },
            { scope: 'places:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Create, edit, restore and delete places, and accept or dismiss suggestions, through the /hub REST API. It does not let an agent edit through the agent endpoint.', write: true },
        ],
    },
    {
        domain: 'flights',
        title: 'Flights',
        scopes: [
            { scope: 'flights:read', label: 'Read', text: 'Read your flights (booking references included), trips, upcoming flights and the Passport stats through /hub.' },
            { scope: 'flights:suggest', label: 'Suggest', text: 'File a found flight (from email, the calendar or an agent) into the review queue, through the agent endpoint (write mode) and /hub. It cannot change any flight; accepting and dismissing stay with you.', write: true },
            { scope: 'flights:agent-write', label: 'Agent write', text: 'Write through the agent tool (the domain must also be switched to Read and write on the Overview board). Lets an agent add flights, change existing ones and ask the data sources for fresh flight data (refresh) through the agent endpoint. Every earlier version is kept; restoring and the review queue stay with you.', write: true },
            { scope: 'flights:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Add and change flights and trips, restore older versions, change the flights settings and data sources, and ask the data sources for fresh flight data (refresh), through the /hub REST API. Needs Read as well.', write: true },
            { scope: 'flights:observe', label: 'Observe', text: 'Report what a data source read about a flight (gate, terminal, times, delay from status mails) through /hub; the hub merges it unless you locked that field. Needs Read as well. It cannot change anything else.', write: true },
        ],
    },
    {
        domain: 'deadlines',
        title: 'Deadlines',
        scopes: [
            { scope: 'deadlines:read', label: 'Read', text: 'Read your deadlines (documents, insurance, licences, subscriptions, bills and tasks) with days left, through the agent endpoint and /hub. Reference numbers are private: /hub answers one item with its number, and agents never see it unless they ask for one item and have this scope.' },
            { scope: 'deadlines:agent-write', label: 'Agent write', text: 'Write through the agent tool (the domain must also be switched to Read and write on the Overview board). Lets an agent add deadlines, change them, mark them done (a repeating one moves to its next date) and end them, through the agent endpoint. It does not let an agent restore older versions. It needs Read as well to see anything.', write: true },
            { scope: 'deadlines:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Add and change deadlines, mark them done or ended, and restore older versions, through the /hub REST API. It does not let an agent edit through the agent endpoint; that is Edit. It needs Read as well, because the answer is the deadline.', write: true },
        ],
    },
    {
        domain: 'trips',
        title: 'Trips',
        scopes: [
            { scope: 'trips:read', label: 'Read', text: 'Read your trips (where, when, what kind, days to go) with their flights, deadlines and items, and the suggested trips made from flights with no trip, through /hub and the agent endpoint. Booking references, deadline reference numbers and amounts are never part of a trip; item references only when asked for.' },
            { scope: 'trips:agent-write', label: 'Agent write', text: 'Write through the agent tool (the domain must also be switched to Read and write on the Overview board). Lets an agent add trips, change them, link or unlink flights and add, change or remove trip items, through the agent endpoint. Restoring, deleting, and accepting or dismissing suggested trips stay with you (the dashboard only). It needs Read as well to see anything.', write: true },
            { scope: 'trips:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Add and change trips, restore older versions, link or unlink flights and add, change or remove trip items, through the /hub REST API. Deleting a trip and accepting or dismissing suggested trips stay with you (the dashboard only). It needs Read as well, because the answer is the trip.', write: true },
        ],
    },
    {
        domain: 'preferences',
        title: 'Preferences',
        scopes: [
            { scope: 'preferences:read', label: 'Read', text: 'Read your preferences (seat, call hours, favourite airline, food and so on) through the agent endpoint and /hub. They are plain facts; passwords, numbers and keys are refused when stored.' },
            { scope: 'preferences:agent-write', label: 'Agent write', text: 'Write through the agent tool (the domain must also be switched to Read and write on the Overview board). Lets an agent set preferences (create or change them by area and key) and unset them, through the agent endpoint. Unset hides a preference and keeps its history. It does not let an agent restore older versions. It needs Read as well to see anything.', write: true },
            { scope: 'preferences:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Add and change preferences, unset them and restore older versions, through the /hub REST API. It does not let an agent edit through the agent endpoint; that is Edit. It needs Read as well, because the answer is the preference.', write: true },
        ],
    },
    {
        domain: 'lifelog',
        title: 'Lifelog',
        note: 'The most private domain: a key with "*" (everything) does not get it. Grant Lifelog: everything or the scopes below on purpose.',
        scopes: [
            { scope: 'lifelog:push', label: 'Push', text: 'Add observations (what a camera, glasses, a sensor or a voice note saw or heard, as text) through POST /hub/lifelog/observations, only under the key\'s own name as the source. It cannot read anything back or change anything. Give this to capture devices and bridges.', write: true },
            { scope: 'lifelog:read', label: 'Read', text: 'Read the lifelog: days, episodes (meals, walks, sleep, places) and the raw observations, through /hub (and the agent endpoint once it has a lifelog tool).' },
            { scope: 'lifelog:agent-write', label: 'Agent write', text: 'Write through the agent tool (once there is one; the domain must also be switched to Read and write on the Overview board). Lets an agent add and change episodes, add observations and link them. Forgetting a time range stays with you (the dashboard only).', write: true },
            { scope: 'lifelog:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Add, change and restore episodes, link observations to them, and push observations under any source name, through the /hub REST API. Forgetting a time range stays with you (the dashboard only). It needs Read as well, because the answer is the episode.', write: true },
        ],
    },
    {
        domain: 'attendance',
        title: 'Attendance',
        scopes: [
            { scope: 'attendance:read', label: 'Read', text: 'Read Kerkar Creations attendance records.' },
            { scope: 'attendance:api-write', label: 'API write', text: 'Write through the API (jobs and scripts). Add attendance records.', write: true },
        ],
    },
];

const byScope = new Map(CATALOGUE.flatMap((d) => d.scopes.map((s) => [s.scope, { ...s, domain: d.domain, title: d.title }])));
const byDomain = new Map(CATALOGUE.map((d) => [d.domain, d]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The old scope names (write, edit) still work as aliases; they are explained as their new names.
const OLD_NAMES = (scope) => scope.replace(/:write$/, ':api-write').replace(/:edit$/, ':agent-write');

// { scope, domain, title, label, text, write } for any scope string.
export function explain(scope) {
    if (scope === '*') {
        return { scope, domain: '*', title: 'Everything', label: 'Everything', text: 'Every domain and every action, including ones added later, except Lifelog (the most private domain), which must be granted on its own. Keep this for your own tools.', write: true };
    }
    const known = byScope.get(scope) || byScope.get(OLD_NAMES(scope));
    if (known) return known;
    const [domain, action] = scope.split(':');
    const d = byDomain.get(domain);
    const title = d ? d.title : cap(domain || scope);
    if (action === '*') {
        return { scope, domain, title, label: 'Everything', text: `Everything in ${title}, including actions added later.`, write: true };
    }
    return { scope, domain, title, label: cap((action || '').replace(/-/g, ' ')), text: `The ${action} action on ${title}.`, write: /write|edit|publish|delete/.test(action || '') };
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
