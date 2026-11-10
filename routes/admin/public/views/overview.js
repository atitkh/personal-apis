// Overview: the channel board (each domain is a cable from its data to the agents, with a power switch
// and an Off / Read / Read and write selector), what needs attention, and recent agent activity.
// Refetches when the tab comes back and every 60 s while it is visible.
import {
    h, icon, toggleSwitch, segmented, confirmDialog, toast, emptyState,
    plural, ago, domainHue, hidden,
} from '../ui.js';
import { dayBars, coverageStrip, legend } from '../charts.js';
import { href } from '../router.js';

export const MCP_LABEL = { off: 'Off', read: 'Read', write: 'Read and write' };
export const MCP_WRITE_WARNING = "Agents holding an edit or publish key will be able to change this domain's data. Digest changes keep every earlier version.";
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
                const ok = await confirmDialog({ title: `Let agents change ${cur.title}?`, body: MCP_WRITE_WARNING, confirm: 'Allow changes', danger: true });
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

function issues(o) {
    const out = [];
    if (o.database.status !== 'healthy') out.push({ kind: 'bad', text: 'The database is not responding.', hint: 'Check the container logs (docker logs nodejs).' });
    const newest = o.backups.newest;
    if (!newest) out.push({ kind: 'warn', text: 'No backup has been made yet.', link: ['backups', 'Open backups'] });
    else if (Date.now() - Date.parse(newest.modifiedAt) > 36 * 3600 * 1000) out.push({ kind: 'warn', text: `The last backup is ${ago(newest.modifiedAt).replace(' ago', '')} old.`, link: ['backups', 'Open backups'] });
    if (o.digests && o.digests.missing) out.push({ kind: 'warn', text: `The daily digest for ${o.digests.expectedDaily} has not arrived.`, hint: 'The nightly job runs at 11 PM.', link: ['digests', 'Open digests'] });
    if (o.portfolio.problems) out.push({ kind: 'warn', text: `${plural(o.portfolio.problems, 'portfolio file')} ${o.portfolio.problems === 1 ? 'needs' : 'need'} a look.`, link: ['portfolio', 'Open portfolio'] });
    return out;
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
                i.link ? h('a', { class: 'btn quiet small', href: href(i.link[0]), text: i.link[1] }) : null)))
            : emptyState({
                title: 'Nothing needs you right now.',
                text: 'Checked: the database, backups, the daily digest and the portfolio files.',
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

function headline(o, s, list) {
    const ds = o.domains || [];
    const on = ds.filter((d) => d.enabled).length;
    const first = list.length
        ? `${plural(list.length, 'thing')} ${list.length === 1 ? 'needs' : 'need'} a look.`
        : on === ds.length ? (ds.length === 2 ? 'Both domains on and healthy.' : `All ${plural(ds.length, 'domain')} on and healthy.`) : `${on} of ${plural(ds.length, 'domain')} on, nothing needs you.`;
    const second = s.lastCallAt ? `Last agent call ${ago(s.lastCallAt)}.` : 'No agent has called yet.';
    return [first, second];
}

/* ---------- view ---------- */

export async function render(ctx) {
    const { api } = ctx;
    const load = () => Promise.all([api('/overview'), api('/series?days=14')]);
    let [o, s] = await load();

    const lead = h('p', { class: 'headline' });
    const sub = h('p', { class: 'updated', 'aria-live': 'polite' });
    const b = board(api);
    const lower = h('div', { class: 'overview-lower' });
    let fetchedAt = Date.now();

    function paint() {
        const list = issues(o);
        const [first, second] = headline(o, s, list);
        lead.replaceChildren(h('span', { class: `lead-state ${list.length ? 'warn' : 'good'}` }, icon(list.length ? 'warn' : 'good')), h('span', { text: `${first} ` }), h('span', { class: 'lead-second', text: second }));
        b.update(o.domains || []);
        lower.replaceChildren(attention(list), pulse(o, s));
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
            if (ctx.isCurrent()) paint();
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
        h('div', { class: 'summary' }, lead, sub),
        b.el,
        lower);
}

