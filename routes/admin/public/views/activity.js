// Activity: the audit log as sentences, grouped by day, newest first. The filter lives in the URL
// (#/activity?type=keys); older events load on demand. Agent calls show tool and action, never content.
import { h, icon, button, emptyState, chipNav, dayLabel, keepFocus, toast, hidden, actorName } from '../ui.js';
import { isoDay } from '../charts.js';
import { href } from '../router.js';
import { MCP_LABEL } from './overview.js';
import { explain } from '../scopes.js';

const PAGE = 50;
const TYPES = [
    ['all', 'All'],
    ['keys', 'Keys'],
    ['agents', 'Agents'],
    ['backups', 'Backups'],
    ['domains', 'Domains'],
    ['digests', 'Digests'],
    ['places', 'Places'],
    ['flights', 'Flights'],
    ['deadlines', 'Deadlines'],
    ['signins', 'Sign-ins'],
];
// Empty-state titles per chip, in words that fit the events ("No agents events" read badly).
const NONE = { keys: 'No key changes yet.', agents: 'No agent calls yet.', backups: 'No backups yet.', domains: 'No domain changes yet.', digests: 'No digest edits yet.', places: 'No place changes yet.', flights: 'No flight changes yet.', deadlines: 'No deadline changes yet.', signins: 'No sign-ins yet.' };
const DOMAIN_TITLE = { digests: 'Digests', portfolio: 'Portfolio', places: 'Places', flights: 'Flights', deadlines: 'Deadlines' };
const ICON = {
    login: 'user', logout: 'user', login_failed: 'warn',
    key_created: 'keys', key_updated: 'keys', key_revoked: 'keys',
    domain_enabled: 'overview', domain_disabled: 'overview', domain_mcp_changed: 'agents',
    digest_edited: 'digests', digest_restored: 'digests',
    backup_run: 'backup', mcp_call: 'agents',
    place_created: 'places', place_updated: 'places', place_restored: 'places', place_deleted: 'places',
    place_rule_added: 'places', place_rule_updated: 'places', place_rule_removed: 'places',
    place_suggestion_accepted: 'places', place_suggestion_dismissed: 'places',
    flight_created: 'calendar', flight_updated: 'calendar', flight_restored: 'calendar',
    trip_created: 'calendar', trip_updated: 'calendar', flight_settings_changed: 'calendar',
    flight_candidate_filed: 'calendar', flight_candidate_accepted: 'calendar', flight_candidate_dismissed: 'calendar',
    deadline_created: 'calendar', deadline_updated: 'calendar', deadline_done: 'calendar', deadline_ended: 'calendar', deadline_restored: 'calendar',
};
const RULE_NAME = { street: 'street', zone: 'zone', radius: 'circle' };

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const strong = (text) => h('strong', { text });
const domainName = (n) => DOMAIN_TITLE[n] || n || 'a domain';
const readableScope = (s) => { const e = explain(s); return e.domain === '*' ? 'everything' : `${e.title} ${e.label.toLowerCase()}`; };

function keyRef(d) {
    const name = d && d.name ? d.name : 'a key';
    return d && d.id ? h('a', { class: 'link', href: href('keys', [String(d.id)]), text: name }) : strong(name);
}

// " (renamed from x; added Flights observe; removed Places edit)" for a key_updated row.
function keyChanges(d) {
    const parts = [];
    if (d && d.renamed_from) parts.push(`renamed from ${d.renamed_from}`);
    if (d && d.added && d.added.length) parts.push(`added ${d.added.map(readableScope).join(', ')}`);
    if (d && d.removed && d.removed.length) parts.push(`removed ${d.removed.map(readableScope).join(', ')}`);
    return parts.length ? ` (${parts.join('; ')})` : '';
}

// A place by its label (ids and labels are all the audit log keeps; never a street).
function placeRef(d, { gone = false } = {}) {
    const label = d && d.label ? d.label : 'a place';
    return d && d.id && !gone ? h('a', { class: 'link', href: href('places', [String(d.id)]), text: label }) : strong(label);
}
const ruleWord = (d) => `a ${RULE_NAME[d.rule_type] || 'rule'}${RULE_NAME[d.rule_type] ? ' rule' : ''}`;

function digestRef(d) {
    if (!d || !d.kind || !d.period) return 'a digest';
    const label = d.kind === 'daily' ? `the daily digest for ${dayLabel(d.period, { month: 'short', day: 'numeric' })}` : `the weekly review for ${d.period}`;
    return h('a', { class: 'link', href: href('digests', [d.kind, d.period]), text: label });
}

// "Atit created key openclaw (Digests read)"
function sentence(e) {
    const d = e.detail || {};
    const who = strong(actorName(e.actor));
    switch (e.action) {
    case 'login': return [who, ' signed in'];
    case 'logout': return [who, ' signed out'];
    case 'login_failed': return ['Someone tried a wrong admin key'];
    case 'key_created': return [who, ' created key ', keyRef(d), d.scopes ? ` (${d.scopes.map(readableScope).join(', ')})` : ''];
    case 'key_updated': return [who, ' updated key ', keyRef(d), keyChanges(d)];
    case 'key_revoked': return [who, ' revoked key ', keyRef(d)];
    case 'domain_enabled': return [who, ' turned on ', domainName(d.name)];
    case 'domain_disabled': return [who, ' turned off ', domainName(d.name)];
    case 'domain_mcp_changed': return [who, ` set agent access for ${domainName(d.name)} to ${(MCP_LABEL[d.to] || d.to || 'an unknown mode').toLowerCase()}`];
    case 'digest_edited': return [who, ' edited ', digestRef(d)];
    case 'digest_restored': return [who, ' restored an older version of ', digestRef(d)];
    case 'backup_run': return [who, ' made a backup'];
    case 'flight_created': return [who, ' added the flight ', strong(d.flight || 'a flight')];
    case 'flight_updated': return [who, ' changed the flight ', strong(d.flight || 'a flight')];
    case 'flight_restored': return [who, ' restored an older version of the flight ', strong(d.flight || 'a flight')];
    case 'trip_created': return [who, ' added the trip ', strong(d.title || 'a trip')];
    case 'trip_updated': return [who, ' changed the trip ', strong(d.title || 'a trip')];
    case 'deadline_created': return [who, ' added the deadline ', strong(d.title || 'a deadline')];
    case 'deadline_updated': return [who, ' changed the deadline ', strong(d.title || 'a deadline')];
    case 'deadline_done': return [who, ' marked the deadline ', strong(d.title || 'a deadline'), d.next_due ? ` done, next due ${d.next_due}` : ' done'];
    case 'deadline_ended': return [who, ' ended the deadline ', strong(d.title || 'a deadline')];
    case 'deadline_restored': return [who, ' restored an older version of the deadline ', strong(d.title || 'a deadline')];
    case 'flight_settings_changed': return [who, ' changed the flights settings'];
    case 'flight_candidate_filed': return [who, ' found the flight ', strong(d.flight || 'a flight'), ' for review'];
    case 'flight_candidate_accepted': return [who, ' accepted the found flight ', strong(d.flight || 'a flight')];
    case 'flight_candidate_dismissed': return [who, ' dismissed the found flight ', strong(d.flight || 'a flight')];
    case 'place_created': return [who, ' added the place ', placeRef(d)];
    case 'place_updated': return [who, ' changed ', placeRef(d)];
    case 'place_restored': return [who, ' restored an older version of ', placeRef(d)];
    case 'place_deleted': return [who, ' deleted the place ', placeRef(d, { gone: true })];
    case 'place_rule_added': return [who, ` added ${ruleWord(d)} to `, placeRef(d)];
    case 'place_rule_updated': return [who, ` changed ${ruleWord(d)} of `, placeRef(d)];
    case 'place_rule_removed': return [who, ` removed ${ruleWord(d)} from `, placeRef(d)];
    case 'place_suggestion_accepted': return d.created ? [who, ' named a spot from the queue: ', placeRef(d)] : [who, ' added a spot from the queue to ', placeRef(d)];
    case 'place_suggestion_dismissed': return [who, ' dismissed a spot in the places queue'];
    case 'mcp_call': return [strong(d.key || e.actor), ' called ', h('code', { text: `${d.tool || 'unknown'}${d.action ? `.${d.action}` : ''}` }), d.ok ? '' : ', which failed'];
    default: return [who, ` ${e.action.replace(/_/g, ' ')}`];
    }
}

const failed = (e) => e.action === 'login_failed' || (e.action === 'mcp_call' && e.detail && e.detail.ok === false);

function dayHeading(day) {
    const today = isoDay(new Date());
    const y = new Date();
    y.setDate(y.getDate() - 1);
    if (day === today) return 'Today';
    if (day === isoDay(y)) return 'Yesterday';
    const opts = { weekday: 'long', month: 'long', day: 'numeric' };
    if (day.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
    return dayLabel(day, opts);
}

function groups(events) {
    const out = [];
    for (const e of events) {
        const day = isoDay(new Date(e.at));
        let g = out[out.length - 1];
        if (!g || g.day !== day) { g = { day, events: [] }; out.push(g); }
        g.events.push(e);
    }
    return out;
}

function eventItem(e) {
    const bad = failed(e);
    return h('li', { class: `event${bad ? ' bad' : ''}` },
        h('time', { class: 'event-time', datetime: e.at, text: timeFmt.format(new Date(e.at)) }),
        h('span', { class: 'event-icon', 'aria-hidden': 'true' }, icon(bad ? 'warn' : ICON[e.action] || 'activity')),
        h('p', { class: 'event-text' }, bad ? hidden('Failed: ') : null, sentence(e),
            ['login', 'login_failed'].includes(e.action) && e.ip ? h('span', { class: 'event-ip', text: ` from ${e.ip}` }) : null,
            // Phones show the time here instead: it floats to the end of the sentence's last line when it fits.
            h('time', { class: 'event-time-inline', datetime: e.at, text: timeFmt.format(new Date(e.at)) })));
}

export async function render(ctx) {
    const asked = ctx.route.query.get('type') || 'all';
    const type = TYPES.some(([id]) => id === asked) ? asked : 'all';
    const first = await ctx.api(`/activity?type=${type}&limit=${PAGE}`);
    const events = first.events.slice();
    let more = first.more;

    const list = h('div', { class: 'days' });
    const foot = h('div', { class: 'load-more' });
    const loadMore = button({
        text: 'Show older events',
        variant: 'quiet',
        'data-key': 'load-more',
        // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
        onClick: async () => {
            if (loadMore.getAttribute('aria-disabled') === 'true') return;
            loadMore.setAttribute('aria-disabled', 'true');
            try {
                const next = await ctx.api(`/activity?type=${type}&limit=${PAGE}&before=${events[events.length - 1].id}`);
                events.push(...next.events);
                more = next.more;
                keepFocus(list.parentNode, paint);
            } catch (err) {
                toast(`Could not load older events. ${err.message}`, { kind: 'bad' });
            }
            loadMore.removeAttribute('aria-disabled');
        },
    });

    function paint() {
        list.replaceChildren(...groups(events).map((g) => h('section', { class: 'day', 'aria-labelledby': `day-${g.day}` },
            h('h2', { class: 'day-title', id: `day-${g.day}` }, h('span', { text: dayHeading(g.day) }), h('span', { class: 'day-count', text: String(g.events.length) }), hidden(g.events.length === 1 ? ' event' : ' events')),
            h('ol', { class: 'events' }, g.events.map(eventItem)))));
        foot.replaceChildren(more ? loadMore : events.length > 8 ? h('p', { class: 'note', tabindex: '-1', 'data-key': 'load-more', text: 'That is everything in the log.' }) : '');
    }
    paint();

    const label = (TYPES.find(([id]) => id === type) || TYPES[0])[1].toLowerCase();
    return h('div', { class: 'view activity' },
        h('p', { class: 'lede', text: 'What happened on the hub, newest first: sign-ins, keys, domain switches, digest edits, backups and agent calls.' }),
        chipNav({ label: 'Show', current: type, items: TYPES.map(([id, text]) => ({ id, label: text, href: href('activity', [], { type: id === 'all' ? null : id }) })) }),
        events.length
            ? h('div', {}, list, foot)
            : emptyState({
                title: type === 'all' ? 'Nothing has happened yet.' : NONE[type] || `No ${label} events yet.`,
                text: type === 'all' ? 'Sign-ins, key changes and agent calls show up here.' : 'Pick All to see everything else.',
                iconName: 'activity',
                action: type === 'all'
                    ? h('a', { class: 'btn quiet small', href: href('keys', [], { new: '1' }), text: 'Create a key' })
                    : h('a', { class: 'btn quiet small', href: href('activity'), text: 'Show all events' }),
            }));
}
