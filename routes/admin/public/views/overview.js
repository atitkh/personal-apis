// Overview: the channel board (each domain is a cable from its data to the agents, with a power switch
// and an Off / Read / Read and write selector), what needs attention, and recent agent activity.
// Refetches when the tab comes back and every 60 s while it is visible.
import {
    h, icon, toggleSwitch, segmented, confirmDialog, toast, emptyState, pageHeader,
    plural, ago, domainHue, hidden, dayLabel, errorState,
} from '../ui.js';
import { dayBars, coverageStrip, legend } from '../charts.js';
import { href } from '../router.js';

export const MCP_LABEL = { off: 'Off', read: 'Read', write: 'Read and write' };
export const MCP_WRITE_WARNING = "Agents holding an agent-write or publish scope will be able to change this domain's data.";
// What write mode means for a domain, in its own words (the generic line for any other domain).
const WRITE_WARNING = {
    digests: "Agents holding a digests agent-write or publish scope will be able to change digests. Every earlier version is kept.",
    places: 'Agents holding a places suggest scope can file streets into the Needs a name queue, and a places agent-write scope can add and change places and their rules. Every earlier version is kept; deleting and naming the queue stay with you.',
};
WRITE_WARNING.flights = 'Agents holding a flights suggest scope can file found flights into the review queue, and a flights agent-write scope can add flights and change existing ones. Every earlier version is kept; accepting, dismissing and cancelling stay with you.';
WRITE_WARNING.deadlines = 'Agents holding a deadlines agent-write scope can add deadlines, change them and mark them done (a repeating one moves to its next date) or ended. Every earlier version is kept; restoring and anything private, like the reference, stay with you.';
WRITE_WARNING.trips = 'Agents holding a trips agent-write scope can add trips and change them, link and unlink flights, and add, change and remove trip items. Every earlier version of a trip is kept (items have no history); deleting a trip, restoring an older version and accepting or dismissing suggested trips stay with you.';
WRITE_WARNING.preferences = 'Agents holding a preferences agent-write scope can set preferences (create or change them by area and key) and unset them. Unset only hides a preference; every earlier version is kept and you can restore it here. Text that looks like a password, a long number or a key is refused.';
WRITE_WARNING.lifelog = 'Agents holding a lifelog agent-write scope can add and change episodes, log single observations (always under their own key name as the source) and link or unlink observations. Every earlier version of an episode is kept; forgetting a time range and restoring an older version stay with you.';
const writeWarning = (name) => WRITE_WARNING[name] || MCP_WRITE_WARNING;
const REFRESH_MS = 60 * 1000;
const UPCOMING = [{ name: 'flights', title: 'Flights', text: 'Next domain. Past and upcoming trips.' }];

let drawnOnce = false; // the cables draw in once per page load, not on every visit

const caption = (d) => {
    if (!d.enabled) return 'Paused for every key and visitor';
    if (!d.mcpTool) return 'No agent tool yet';
    return { off: 'Agents cannot reach it', read: 'Agents can read', write: 'Agents can read and change it' }[d.mcpMode] || '';
};

/* ---------- one channel ---------- */

function channel(d, index, actions) {
    const hue = domainHue(d.name, index);
    const meta = h('p', { class: 'ch-meta' });
    const where = h('p', { class: 'ch-where' });

    const power = toggleSwitch({ checked: d.enabled, label: `${d.title} power`, key: `${d.name}:power`, onChange: (v) => actions.power(d, v) });
    const powerText = h('span', { class: 'switch-text', 'aria-hidden': 'true' });

    // Two halves (so the wire can be cut in the middle) plus a row of round dashes for read-only.
    const wire = (cls) => h('span', { class: `wire ${cls}` }, h('i'), h('i'), h('span', { class: 'dashes' }, Array.from({ length: 40 }, () => h('b'))));
    const cable = h('div', { class: 'cable', role: 'img' },
        h('span', { class: 'plug src' }), wire('w1'), h('span', { class: 'jack' }), wire('w2'), h('span', { class: 'plug dst' }));
    const cap = h('p', { class: 'cable-caption' });

    const mode = d.mcpTool
        ? segmented({
            label: `Agent access for ${d.title}`,
            key: `${d.name}:mode`,
            value: d.mcpMode,
            options: Object.entries(MCP_LABEL).map(([value, label]) => ({ value, label })),
            onChange: (v) => actions.mode(d, v),
        })
        : h('p', { class: 'ch-none', text: 'No agent tool' });

    const el = h('li', { class: `channel hue-${hue}`, 'data-domain': d.name },
        h('div', { class: 'ch-name' },
            h('h3', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), h('span', { text: d.title })),
            meta, where),
        h('div', { class: 'ch-power' }, power, powerText),
        h('div', { class: 'ch-route' }, cable, cap),
        h('div', { class: 'ch-mode' }, mode));

    function update(next) {
        d = next;
        meta.textContent = d.records == null ? (d.storage === 'db' ? 'Nothing stored yet' : 'Files in git') : `${d.records.toLocaleString()} ${d.recordLabel}${d.lastChange ? `, changed ${ago(d.lastChange)}` : ''}`;
        where.textContent = `${d.sensitivity === 'public' ? 'Public' : 'Private'}, ${d.storage === 'db' ? 'in the database' : 'files in git'}`;
        power.setChecked(d.enabled);
        powerText.textContent = d.enabled ? 'On' : 'Off';
        cable.dataset.power = d.enabled ? 'on' : 'off';
        cable.dataset.mode = d.mcpTool ? d.mcpMode : 'none';
        cable.setAttribute('aria-label', `${d.title}: ${d.enabled ? 'on' : 'off'}. ${caption(d)}.`);
        cap.replaceChildren(h('strong', { text: d.enabled ? 'On. ' : 'Off. ' }), caption(d));
        el.classList.toggle('is-off', !d.enabled);
        el.classList.toggle('is-busy', Boolean(d.pending));
        if (mode.setValue) mode.setValue(d.mcpMode);
    }
    update(d);
    return { el, update, get: () => d };
}

function upcomingChannel(u) {
    return h('li', { class: 'channel soon hue-teal', 'aria-label': `${u.title}, not built yet` },
        h('div', { class: 'ch-name' },
            h('h3', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), h('span', { text: u.title })),
            h('p', { class: 'ch-meta', text: u.text })),
        h('div', { class: 'ch-power' }),
        h('div', { class: 'ch-route' }, h('div', { class: 'cable', 'data-power': 'soon', 'aria-hidden': 'true' }, h('span', { class: 'plug src' }), h('span', { class: 'wire' }, h('i'), h('i'), h('span', { class: 'dashes' }, Array.from({ length: 16 }, () => h('b')))))),
        h('div', { class: 'ch-mode' }, h('p', { class: 'ch-none', text: 'Not built yet' })));
}

/* ---------- the board ---------- */

function board(api) {
    let rows = new Map();
    const list = h('ul', { class: 'channels' });
    const el = h('section', { class: 'board', 'aria-labelledby': 'board-title' },
        h('div', { class: 'board-head' },
            h('h2', { id: 'board-title', text: 'Channels' }),
            h('p', { class: 'note', text: 'Each domain runs from its data on the left to the agents on the right. The switch pauses a domain for every key and visitor; nothing is deleted. The selector sets what agents may do through the MCP endpoint.' })),
        list);
    if (!drawnOnce && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.classList.add('draw-in');
        setTimeout(() => el.classList.remove('draw-in'), 1600);
    }
    drawnOnce = true;

    // Optimistic: show the new state at once, roll back with a toast if the server says no.
    async function change(d, patch, request, done, failVerb) {
        const row = rows.get(d.name);
        const before = row.get();
        if (before.pending) return;
        row.update({ ...before, ...patch, pending: true });
        try {
            await request();
            row.update({ ...row.get(), pending: false });
            toast(done);
        } catch (err) {
            row.update({ ...before, pending: false });
            toast(`Could not ${failVerb}. ${err.message}`, { kind: 'bad' });
        }
    }

    const actions = {
        async power(d, enabled) {
            const cur = rows.get(d.name).get();
            if (!enabled && cur.confirmOff) {
                const ok = await confirmDialog({ title: `Turn off ${cur.title}?`, body: cur.confirmOff, confirm: 'Turn off', danger: true });
                if (!ok) return;
            }
            change(cur, { enabled },
                () => api(`/domains/${encodeURIComponent(cur.name)}`, { method: 'PUT', body: { enabled } }),
                `${cur.title} turned ${enabled ? 'on' : 'off'}`, `turn ${cur.title} ${enabled ? 'on' : 'off'}`);
        },
        async mode(d, mode) {
            const cur = rows.get(d.name).get();
            if (mode === 'write' && cur.mcpMode !== 'write') {
                const ok = await confirmDialog({ title: `Let agents change ${cur.title}?`, body: writeWarning(cur.name), confirm: 'Allow changes', danger: true });
                if (!ok) { rows.get(d.name).update(rows.get(d.name).get()); return; }
            }
            change(cur, { mcpMode: mode },
                () => api(`/domains/${encodeURIComponent(cur.name)}/mcp`, { method: 'PUT', body: { mode } }),
                `Agent access for ${cur.title} set to ${MCP_LABEL[mode].toLowerCase()}`, `change agent access for ${cur.title}`);
        },
    };

    function update(domains) {
        const same = domains.length === rows.size && domains.every((d) => rows.has(d.name));
        if (same) {
            // Keep rows (and focus, and any running transition); skip rows with a change in flight.
            for (const d of domains) {
                const row = rows.get(d.name);
                if (!row.get().pending) row.update(d);
            }
            return;
        }
        rows = new Map();
        const items = domains.map((d, i) => {
            const row = channel(d, i, actions);
            rows.set(d.name, row);
            return row.el;
        });
        const upcoming = UPCOMING.filter((u) => !domains.some((d) => d.name === u.name)).map(upcomingChannel);
        list.replaceChildren(...items, ...upcoming);
        if (!domains.length) list.append(h('li', {}, emptyState({ title: 'No domains registered.', text: 'Add one in services/domains.js and it shows up here.' })));
    }

    return { el, update };
}

/* ---------- attention, activity, system ---------- */

// The three conditions the briefing also reports. One source: the panel takes them from the briefing (so the Today
// card and the panel never drift), and only falls back to the overview counts while the briefing is not there.
const isShared = (id) => id === 'flights:candidates:pending' || id === 'places:suggestions:pending' || id.startsWith('digests:missing:');

// Hub health: only what the overview data alone knows.
function healthIssues(o) {
    const out = [];
    if (o.database.status !== 'healthy') out.push({ kind: 'bad', text: 'The database is not responding.', hint: 'Check the container logs (docker logs personal-hub).' });
    const b = o.backups;
    const newest = b.newest;
    const staleMs = Math.max(36, (b.everyHours || 24) * 1.5) * 3600 * 1000;
    if (b.error) out.push({ kind: 'bad', text: `Backups failing: ${b.error}`, hint: 'No new backup is being made until this is fixed. Check the folder in Settings, or use Test location.', link: ['settings', 'Open settings'] });
    else if (b.enabled === false) out.push({ kind: 'warn', text: 'Automatic backups are off.', link: ['settings', 'Open settings'] });
    else if (!newest) out.push({ kind: 'warn', text: 'No backup has been made yet.', link: ['backups', 'Open backups'] });
    else if (Date.now() - Date.parse(newest.modifiedAt) > staleMs) out.push({ kind: 'warn', text: `The last backup is ${ago(newest.modifiedAt).replace(' ago', '')} old.`, link: ['backups', 'Open backups'] });
    if (o.portfolio.problems) out.push({ kind: 'warn', text: `${plural(o.portfolio.problems, 'portfolio file')} ${o.portfolio.problems === 1 ? 'needs' : 'need'} a look.`, link: ['portfolio', 'Open portfolio'] });
    return out;
}

const DIGEST_LINE = { hint: 'The nightly job runs at 11 PM.', link: ['digests', 'Open digests'] };
const PLACES_LINE = (one) => ({ hint: 'Streets the nightly digest saw that no place claims yet.', link: ['places', one ? 'Name it' : 'Name them', { tab: 'queue' }] });
const FLIGHTS_LINE = (one) => ({ hint: 'Flights a job or an agent found; accept or dismiss them.', link: ['flights', one ? 'Review it' : 'Review them', { tab: 'found' }] });

// The shared lines as the briefing words them (its text has no full stop; the panel's lines do).
function sharedFromBriefing(items) {
    return items.filter((i) => isShared(i.id)).map((i) => {
        const one = /^1 /.test(i.text);
        const extra = i.id.startsWith('digests:') ? DIGEST_LINE : i.id.startsWith('places:') ? PLACES_LINE(one) : FLIGHTS_LINE(one);
        return { kind: 'warn', id: i.id, text: `${i.text}.`, ...extra };
    });
}

// The same three lines from /admin/api/overview: used while the briefing loads or when it fails.
function sharedFromOverview(o) {
    const out = [];
    if (o.digests && o.digests.missing) out.push({ kind: 'warn', id: `digests:missing:${o.digests.expectedDaily}`, text: `The daily digest for ${o.digests.expectedDaily} has not arrived.`, ...DIGEST_LINE });
    const waiting = o.places && o.places.suggestions ? o.places.suggestions.pending : 0;
    if (waiting) out.push({ kind: 'warn', id: 'places:suggestions:pending', text: `${plural(waiting, 'spot')} ${waiting === 1 ? 'needs' : 'need'} a name.`, ...PLACES_LINE(waiting === 1) });
    const found = o.flights && o.flights.candidates ? o.flights.candidates.pending : 0;
    if (found) out.push({ kind: 'warn', id: 'flights:candidates:pending', text: `${plural(found, 'found flight')} ${found === 1 ? 'waits' : 'wait'} for review.`, ...FLIGHTS_LINE(found === 1) });
    return out;
}

// Hub health first, then the shared conditions (briefing when it arrived, overview counts otherwise).
function issues(o, briefingItems) {
    return [...healthIssues(o), ...(briefingItems ? sharedFromBriefing(briefingItems) : sharedFromOverview(o))];
}

function attention(list) {
    return h('section', { class: 'panel attention', 'aria-labelledby': 'att-title' },
        h('h2', { id: 'att-title', text: list.length ? 'Needs attention' : 'Attention' }),
        list.length
            ? h('ul', { class: 'att-list' }, list.map((i) => h('li', { class: `att ${i.kind}` },
                icon(i.kind === 'bad' ? 'bad' : 'warn', 'att-icon'),
                h('div', {},
                    h('p', { class: 'att-text' }, hidden(i.kind === 'bad' ? 'Problem: ' : 'Warning: '), i.text),
                    i.hint ? h('p', { class: 'att-hint', text: i.hint }) : null),
                i.link ? h('a', { class: 'btn quiet small', href: href(i.link[0], [], i.link[2] || null), text: i.link[1] }) : null)))
            : emptyState({
                title: 'Nothing needs you right now.',
                text: 'Checked: the database, backups, the daily digest, the portfolio files, the places queue and the found flights.',
                iconName: 'good',
                action: h('a', { class: 'btn quiet small', href: href('activity'), text: 'See recent activity' }),
            }));
}

const TOOL_HUE = (tool, domains) => {
    if (tool === 'hub_overview') return 'neutral';
    const i = domains.findIndex((d) => d.name === tool);
    return i >= 0 ? domainHue(tool, i) : 'muted';
};
const TOOL_LABEL = (tool, domains) => (tool === 'hub_overview' ? 'Hub overview' : (domains.find((d) => d.name === tool) || {}).title || tool);

function pulse(o, s) {
    const domains = o.domains || [];
    const tools = [...new Set(s.days.flatMap((d) => Object.keys(d.byTool)))];
    const data = s.days.map((d) => ({
        day: d.day,
        total: d.calls,
        parts: tools.map((t) => ({ hue: TOOL_HUE(t, domains), value: d.byTool[t] || 0, label: TOOL_LABEL(t, domains) })),
    }));
    const total = s.days.reduce((n, d) => n + d.calls, 0);
    const failed = s.days.reduce((n, d) => n + d.failed, 0);
    const today = s.days.length ? s.days[s.days.length - 1].calls : 0;
    const cov = o.digests && o.digests.coverage;

    return h('section', { class: 'panel pulse', 'aria-labelledby': 'pulse-title' },
        h('div', { class: 'panel-head' },
            h('h2', { id: 'pulse-title', text: 'Agent calls, last 14 days' }),
            h('a', { class: 'link', href: href('activity', [], { type: 'agents' }), text: 'All activity' })),
        h('p', { class: 'pulse-figure' },
            h('strong', { text: total.toLocaleString() }), ` ${total === 1 ? 'call' : 'calls'}, ${today} today`,
            failed ? h('span', { class: 'pulse-failed' }, icon('warn'), ` ${failed} failed`) : null),
        total
            ? [dayBars({ data, ariaLabel: `Agent calls per day for 14 days: ${plural(total, 'call')} in total, ${today} today.` }),
                legend(tools.map((t) => ({ hue: TOOL_HUE(t, domains), label: TOOL_LABEL(t, domains) })))]
            : emptyState({
                title: 'No agent has called the hub in the last 14 days.',
                text: 'Give an agent a key and the endpoint, and its calls show up here.',
                iconName: 'agents',
                action: h('a', { class: 'btn quiet small', href: href('agents'), text: 'Set up an agent' }),
            }),
        cov && cov.total ? h('div', { class: 'coverage' },
            h('h3', { text: 'Daily digests, last 30 days' }),
            coverageStrip({ days: cov.days, ariaLabel: `${cov.present} of ${cov.total} days have a daily digest`, href: (day) => href('digests', ['daily', day]) }),
            h('p', { class: 'note', text: `${cov.present} of ${cov.total} days have one. Gaps are days the nightly job did not deliver.` })) : null);
}

// "The domain is", "Both domains are", "All 3 domains are": counted, never assumed.
export function allOn(n) {
    if (n === 0) return 'No domains yet.';
    if (n === 1) return 'The one domain is on and healthy.';
    if (n === 2) return 'Both domains on and healthy.';
    return `All ${plural(n, 'domain')} on and healthy.`;
}

function headline(o, s, list) {
    const ds = o.domains || [];
    const on = ds.filter((d) => d.enabled).length;
    const first = list.length
        ? `${plural(list.length, 'thing')} ${list.length === 1 ? 'needs' : 'need'} a look.`
        : on === ds.length ? allOn(ds.length) : `${on} of ${plural(ds.length, 'domain')} on, nothing needs you.`;
    const second = s.lastCallAt ? `Last agent call ${ago(s.lastCallAt)}.` : 'No agent has called yet.';
    return [first, second];
}

/* ---------- Today card (the briefing: what needs you, what is coming up) ---------- */

const DAYS_KEY = 'hub-briefing-days';
const HORIZONS = [14, 30, 60];
const SEVERITY_WORD = { urgent: 'Urgent', attention: 'Attention', info: 'Info' };

function savedDays() {
    try {
        const n = Number(localStorage.getItem(DAYS_KEY));
        return HORIZONS.includes(n) ? n : 14;
    } catch (e) { return 14; }
}

// Where an item leads: the record when its ref is known, otherwise the place that handles that kind of item.
function itemLink(i) {
    if (i.id.startsWith('flights:candidates')) return href('flights', [], { tab: 'found' });
    if (i.id.startsWith('places:suggestions')) return href('places', [], { tab: 'queue' });
    if (i.id.startsWith('digests:missing')) return href('digests');
    if (i.ref && i.ref.domain === 'flights' && /^\d+$/.test(String(i.ref.id))) return href('flights', [String(i.ref.id)]);
    if (i.ref && i.ref.domain === 'deadlines' && /^\d+$/.test(String(i.ref.id))) return href('deadlines', [String(i.ref.id)]);
    return i.ref && i.ref.domain ? href(i.ref.domain) : null;
}

function todayItem(i, showSeverity) {
    const link = itemLink(i);
    const text = h('span', { class: 'today-text', text: i.text });
    return h('li', { class: `today-item sev-${i.severity}`, 'data-id': i.id },
        showSeverity ? h('span', { class: `chip sev-chip sev-${i.severity}` }, hidden('Severity: '), h('span', { text: SEVERITY_WORD[i.severity] || i.severity })) : null,
        link ? h('a', { class: 'today-link', href: link }, text) : text,
        i.date ? h('span', { class: 'today-date muted', text: dayLabel(i.date) }) : null);
}

// The panel shows the three shared conditions, so the card leaves them out (one line per condition on the page).
function todayBody(full) {
    const b = { ...full, attention: full.attention.filter((i) => !isShared(i.id)) };
    const moved = full.attention.length - b.attention.length;
    if (!b.attention.length && !b.upcoming.length) {
        return moved
            ? emptyState({ title: 'Nothing else needs you.', text: `Nothing else is coming up in the next ${b.days} days. The rest is under Needs attention below.`, iconName: 'good' })
            : emptyState({ title: 'Nothing needs you right now.', text: `Nothing is coming up in the next ${b.days} days either.`, iconName: 'good' });
    }
    return h('div', { class: 'today-lists' },
        b.attention.length ? h('section', { 'aria-label': 'Needs you' },
            h('h3', { class: 'today-sub', text: 'Needs you' }),
            h('ul', { class: 'today-list' }, b.attention.map((i) => todayItem(i, true)))) : null,
        b.upcoming.length ? h('section', { 'aria-label': `Next ${b.days} days` },
            h('h3', { class: 'today-sub', text: 'Coming up' }),
            h('ul', { class: 'today-list' }, b.upcoming.map((i) => todayItem(i, false)))) : null,
        b.more ? h('p', { class: 'today-more muted', text: `${plural(b.more, 'more item')} not shown.` }) : null);
}

// onData(briefing) after each load, onData(null) when it failed: the panel shares this one response.
function todayCard(api, ctx, onData) {
    let days = savedDays();
    const body = h('div', { class: 'today-body', 'aria-live': 'polite' });
    const seg = segmented({
        options: HORIZONS.map((n) => ({ value: String(n), label: `Next ${n} days` })),
        value: String(days),
        label: 'Look-ahead',
        key: 'today-days',
        cls: 'today-seg',
        onChange: (v) => {
            days = Number(v);
            try { localStorage.setItem(DAYS_KEY, String(days)); } catch (e) { /* private mode: not remembered */ }
            seg.setValue(v);
            load();
        },
    });
    const skeleton = () => h('div', { class: 'skeleton-block skel', 'aria-busy': 'true', 'aria-label': 'Loading' },
        h('div', { class: 'skeleton w-60' }), h('div', { class: 'skeleton w-80' }), h('div', { class: 'skeleton w-40' }));
    let ticket = 0;
    async function load() {
        const mine = ++ticket;
        body.replaceChildren(skeleton());
        try {
            const b = await api(`/briefing?days=${days}`);
            if (mine === ticket && ctx.isCurrent()) { body.replaceChildren(todayBody(b)); onData(b); }
        } catch (err) {
            if (mine === ticket && ctx.isCurrent()) { body.replaceChildren(errorState({ err, what: 'The briefing', retry: load })); onData(null); }
        }
    }
    load();
    return {
        el: h('section', { class: 'panel today', 'aria-labelledby': 'today-title' },
            h('div', { class: 'panel-head today-head' }, h('h2', { id: 'today-title', text: 'Today' }), seg),
            body),
        reload: load,
    };
}

/* ---------- view ---------- */

export async function render(ctx) {
    const { api } = ctx;
    const load = () => Promise.all([api('/overview'), api('/series?days=14')]);
    let [o, s] = await load();

    const lead = h('span', { class: 'headline' });
    const sub = h('span', { class: 'updated', 'aria-live': 'polite' });
    const b = board(api);
    const top = h('div', { class: 'overview-top' });
    const activity = h('div', { class: 'overview-activity' });
    let briefing = null; // the one briefing response, shared by the Today card and the Needs attention panel
    const today = todayCard(api, ctx, (b) => { briefing = b; paint(); });
    let fetchedAt = Date.now();

    function paint() {
        const list = issues(o, briefing ? briefing.attention : null);
        const [first, second] = headline(o, s, list);
        lead.replaceChildren(h('span', { class: `lead-state ${list.length ? 'warn' : 'good'}` }, icon(list.length ? 'warn' : 'good')), h('span', { text: `${first} ` }), h('span', { class: 'lead-second', text: second }));
        b.update(o.domains || []);
        top.replaceChildren(attention(list), today.el);
        activity.replaceChildren(pulse(o, s));
        sub.textContent = '';
    }
    paint();

    let busy = false;
    async function refresh() {
        if (busy || document.visibilityState !== 'visible' || !ctx.isCurrent()) return;
        busy = true;
        try {
            [o, s] = await load();
            fetchedAt = Date.now();
            if (ctx.isCurrent()) { paint(); today.reload(); }
        } catch (err) {
            sub.replaceChildren(`Could not refresh${err.network ? ': the hub did not answer' : ''}. Showing data from ${new Date(fetchedAt).toLocaleTimeString()}. `,
                h('button', { type: 'button', class: 'link', 'data-key': 'refresh-retry', onclick: () => refresh(), text: 'Retry' }));
        } finally {
            busy = false;
        }
    }
    const timer = setInterval(refresh, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - fetchedAt > 5000) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    ctx.onCleanup(() => {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
    });

    return h('div', { class: 'overview' },
        pageHeader({ lede: [lead, sub] }),
        top,
        b.el,
        activity);
}

