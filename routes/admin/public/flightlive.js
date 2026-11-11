// Flights: live details from data sources (stage B). Used by views/flights.js.
//   liveDetails(f)        read-only block for the drawer: estimated and actual times, terminals, gates, belt, aircraft, delay chip
//   liveFields(f)         the by-hand edit fields (times, terminals, gates, belt, registration) and what changed in them
//   lockNote(name, ...)   the "Edited by hand" chip with an Unlock button under a locked field
//   refreshBar(...)       the Refresh from sources button, its Force option and the per-source result list
//   rowExtras(f)          the small gate text and delay chip for a table row
//   sourcesCard(ctx, d)   the Data sources card on the Flights tab
// Times are the clock at each airport. Server text goes in as text. API keys never reach this page: a source is
// only "configured" or not.
import { h, icon, button, plural, toast, chip, toggleSwitch } from './ui.js';

/* ---------- field names ---------- */

export const LIVE_TITLE = {
    actual_dep: 'Actual departure', actual_arr: 'Actual arrival', est_dep: 'Estimated departure', est_arr: 'Estimated arrival',
    dep_terminal: 'Departure terminal', dep_gate: 'Departure gate', arr_terminal: 'Arrival terminal', arr_gate: 'Arrival gate',
    baggage_belt: 'Baggage belt', aircraft_type: 'Aircraft', aircraft_reg: 'Registration', delay_min: 'Delay',
};
// Fields the form can lock, in the order the lock notes are looked for.
export const LOCKABLE = ['actual_dep', 'actual_arr', 'est_dep', 'est_arr', 'dep_terminal', 'dep_gate', 'arr_terminal', 'arr_gate', 'baggage_belt', 'aircraft_type', 'aircraft_reg'];
const LIVE_TIMES = ['est_dep', 'est_arr'];
const LIVE_TEXT = ['dep_terminal', 'dep_gate', 'arr_terminal', 'arr_gate', 'baggage_belt', 'aircraft_reg'];
export const LIVE_NAMES = [...LIVE_TIMES, ...LIVE_TEXT];

/* ---------- time helpers ---------- */

// The clock at an airport for a UTC instant: parts for "2026-03-01" and "08:05".
function localParts(iso, tz) {
    if (!iso) return null;
    try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
            timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
        return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    } catch (e) {
        return { date: String(iso).slice(0, 10), time: String(iso).slice(11, 16) };
    }
}

export const localInputValue = (iso, tz) => {
    const p = localParts(iso, tz);
    return p ? `${p.date}T${p.time}` : '';
};

// "14:05", with the date added when it is not the scheduled day ("Mar 2, 00:40").
function clockAt(iso, tz, schedIso) {
    const p = localParts(iso, tz);
    if (!p) return null;
    const s = localParts(schedIso, tz);
    if (s && s.date === p.date) return p.time;
    const [y, m, d] = p.date.split('-').map(Number);
    const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
    return `${month} ${d}, ${p.time}`;
}

/* ---------- delay chip ---------- */

export function delayText(min) {
    if (min == null) return null;
    if (min === 0) return 'on time';
    return min > 0 ? `+${min} min` : `${-min} min early`;
}

export function delayChip(f) {
    const text = delayText(f.delay_min);
    if (!text) return null;
    const kind = f.delay_min >= 15 ? 'is-late' : f.delay_min > 0 ? 'is-slight' : 'is-ontime';
    return h('span', { class: `chip delay-chip ${kind}`, title: 'Minutes after the scheduled time (worked out by the hub)' }, h('span', { text }));
}

/* ---------- the read-only block ---------- */

export const CANCEL_HINT = 'A data source reports this flight as cancelled. Set the status yourself if it is true.';

const hasLive = (f) => ['est_dep', 'est_arr', 'actual_dep', 'actual_arr', 'dep_terminal', 'dep_gate', 'arr_terminal', 'arr_gate', 'baggage_belt', 'aircraft_type', 'aircraft_reg']
    .some((k) => f[k]) || f.delay_min != null || f.source_says_cancelled;

export function liveDetails(f) {
    const column = (title, rows) => {
        const shown = rows.filter(([, v]) => v);
        return h('div', { class: 'live-col' }, h('h4', { text: title }),
            shown.length
                ? h('dl', { class: 'facts live-facts' }, shown.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))
                : h('p', { class: 'muted', text: 'Nothing yet' }));
    };
    const terminal = (t, g) => [['Terminal', t], ['Gate', g]];
    const dep = column('Departure', [
        ['Scheduled', clockAt(f.sched_dep, f.dep_tz, f.sched_dep)],
        ['Estimated', clockAt(f.est_dep, f.dep_tz, f.sched_dep)],
        ['Actual', clockAt(f.actual_dep, f.dep_tz, f.sched_dep)],
        ...terminal(f.dep_terminal, f.dep_gate)]);
    const arr = column('Arrival', [
        ['Scheduled', clockAt(f.sched_arr, f.arr_tz, f.sched_arr)],
        ['Estimated', clockAt(f.est_arr, f.arr_tz, f.sched_arr)],
        ['Actual', clockAt(f.actual_arr, f.arr_tz, f.sched_arr)],
        ...terminal(f.arr_terminal, f.arr_gate),
        ['Baggage belt', f.baggage_belt]]);
    const craft = [f.aircraft_type, f.aircraft_reg].filter(Boolean).join(', ');
    return h('div', { class: 'live-details' },
        h('div', { class: 'live-chips' },
            delayChip(f) || null,
            f.source_says_cancelled ? h('span', { class: 'chip cancel-hint-chip', title: CANCEL_HINT }, icon('info'), h('span', { text: 'A source says cancelled' })) : null),
        f.source_says_cancelled ? h('p', { class: 'note cancel-hint', text: CANCEL_HINT }) : null,
        hasLive(f) ? h('div', { class: 'live-grid' }, dep, arr) : h('p', { class: 'note', text: 'No live details yet. They appear after a refresh from the data sources, or when you fill them in below.' }),
        craft ? h('p', { class: 'live-craft' }, h('strong', { text: 'Aircraft ' }), craft) : null);
}

/* ---------- lock chips ---------- */

// Under a field a person edited: a lock chip and an Unlock button. `onUnlock(name)` sends unlock:[name].
export function lockNote(name, onUnlock) {
    return h('p', { class: 'lock-note', 'data-lock': name },
        h('span', { class: 'chip lock-chip', title: 'Edited by hand' }, icon('lock'), h('span', { text: 'Edited by hand' })),
        h('span', { class: 'lock-text', text: 'Sources will not overwrite it.' }),
        button({ text: 'Unlock', variant: 'quiet', size: 'small', label: `Unlock ${LIVE_TITLE[name] || name}`, 'data-key': `unlock:${name}`, onClick: () => onUnlock(name) }));
}

// After the form is built: put a lock note under each locked field's input.
export function addLockNotes(form, locked, onUnlock) {
    for (const name of LOCKABLE) {
        if (!locked.includes(name)) continue;
        const input = form.querySelector(`[name="${name}"]`);
        const box = input && input.closest('.field');
        if (box) box.append(lockNote(name, onUnlock));
    }
}

/* ---------- by-hand edit fields ---------- */

const liveId = { n: 0 };
function liveField(name, label, input, help) {
    input.id = `lf-${name}-${++liveId.n}`;
    return h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input, help ? h('p', { class: 'help', text: help }) : null);
}

// f: the flight. Returns { el, changes() (only the fields that differ from f), dirty() }.
export function liveFields(f) {
    const start = {};
    const inputs = {};
    for (const k of LIVE_TIMES) {
        start[k] = localInputValue(f[k], k === 'est_dep' ? f.dep_tz : f.arr_tz);
        inputs[k] = h('input', { type: 'datetime-local', name: k, value: start[k], 'data-key': `f-${k}` });
    }
    for (const k of LIVE_TEXT) {
        start[k] = f[k] || '';
        inputs[k] = h('input', { type: 'text', name: k, value: start[k], autocomplete: 'off', spellcheck: 'false', maxlength: k === 'aircraft_reg' ? '12' : '10', 'data-key': `f-${k}` });
    }
    const value = (k) => (LIVE_TIMES.includes(k) ? inputs[k].value.trim() : inputs[k].value.trim().toUpperCase());
    const norm = (k, v) => (LIVE_TIMES.includes(k) ? v : v.toUpperCase());
    const changes = () => Object.fromEntries(LIVE_NAMES.filter((k) => value(k) !== norm(k, start[k])).map((k) => [k, value(k) || null]));
    const open = LIVE_NAMES.some((k) => start[k] || (f.locked_fields || []).includes(k));
    const el = h('details', { class: 'flight-extra live-edit', open },
        h('summary', { text: 'Live details by hand (optional)' }),
        h('div', { class: 'group-grid' },
            liveField('est_dep', LIVE_TITLE.est_dep, inputs.est_dep, 'The clock at the departure airport.'),
            liveField('est_arr', LIVE_TITLE.est_arr, inputs.est_arr, 'The clock at the arrival airport.'),
            liveField('dep_terminal', LIVE_TITLE.dep_terminal, inputs.dep_terminal),
            liveField('dep_gate', LIVE_TITLE.dep_gate, inputs.dep_gate),
            liveField('arr_terminal', LIVE_TITLE.arr_terminal, inputs.arr_terminal),
            liveField('arr_gate', LIVE_TITLE.arr_gate, inputs.arr_gate),
            liveField('baggage_belt', LIVE_TITLE.baggage_belt, inputs.baggage_belt),
            liveField('aircraft_reg', LIVE_TITLE.aircraft_reg, inputs.aircraft_reg, 'For example N123AA.')),
        h('p', { class: 'note lock-hint', text: 'Fields you edit here are locked so sources do not overwrite them.' }),
        f.delay_min != null ? h('p', { class: 'note', text: `Delay is worked out by the hub and cannot be edited: ${delayText(f.delay_min)}.` }) : null);
    return { el, changes, dirty: () => Object.keys(changes()).length > 0 };
}

/* ---------- refresh ---------- */

const RESULT_WORDS = {
    updated: (d) => `updated${d ? `: ${d.split(', ').map((k) => (LIVE_TITLE[k] || k).toLowerCase()).join(', ')}` : ''}`,
    unchanged: () => 'nothing new',
    skipped_recent: (d) => `skipped, looked up recently${d ? ` (${d})` : ''}`,
    skipped_old: () => 'skipped, the flight left over 30 days ago',
    cap_reached: (d) => `skipped, monthly cap reached${d ? ` (${d})` : ''}`,
    not_configured: () => 'not configured, no key is set',
    error: (d) => `failed${d ? `: ${d}` : ''}`,
};
export const resultWords = (r) => (RESULT_WORDS[r.result] || ((d) => `${r.result}${d ? ` ${d}` : ''}`))(r.detail);

export function refreshSummary(res) {
    if (!res.results.length) return 'No source is switched on, so nothing was looked up.';
    if (res.status === 'updated') return `Updated from ${plural(res.sources.length || 1, 'source')}`;
    return 'Nothing new from the sources';
}

// sources: the list from GET /flights/sources (or null when it could not load). Pull sources are the ones a refresh asks.
export function canRefresh(sources) {
    if (!sources) return { ok: true, hint: '' };
    const pull = sources.filter((s) => s.kind === 'pull');
    if (!pull.some((s) => s.enabled)) return { ok: false, hint: 'No source is switched on. Turn one on in Data sources on the Flights tab.' };
    if (!pull.some((s) => s.enabled && s.configured)) return { ok: true, hint: 'No source has a key yet, so a refresh will only say so.' };
    return { ok: true, hint: '' };
}

// Returns the element. onRefresh(force) must return the API answer; after it the caller reloads the flight.
export function refreshBar({ sources, lastResult, labelOf, onRefresh }) {
    const can = canRefresh(sources);
    const force = h('input', { type: 'checkbox', name: 'force', 'data-key': 'refresh-force', id: 'rf-force' });
    const btn = button({
        text: 'Refresh from sources', variant: 'quiet', size: 'small', iconName: 'retry', 'data-key': 'refresh-flight', disabled: !can.ok,
        title: 'Look this flight up now. Hold Shift to force.',
        onClick: async (event) => {
            btn.disabled = true;
            try { await onRefresh(force.checked || event.shiftKey); } finally { btn.disabled = !can.ok; }
        },
    });
    return h('div', { class: 'refresh-bar' },
        h('div', { class: 'row refresh-row' }, btn,
            h('label', { class: 'force-check', for: 'rf-force', title: 'Look up again even if it was checked under 6 hours ago or the flight is over 30 days old' }, force, h('span', { text: 'Force' }))),
        can.hint ? h('p', { class: 'note', 'data-key': 'refresh-hint', text: can.hint }) : null,
        lastResult ? h('div', { class: 'refresh-result', role: 'status', 'data-key': 'refresh-result' },
            h('p', { class: 'note', text: refreshSummary(lastResult) }),
            lastResult.results.length ? h('ul', {}, lastResult.results.map((r) => h('li', {}, h('strong', { text: `${labelOf(r.source)}: ` }), resultWords(r)))) : null) : null);
}

/* ---------- table row extras ---------- */

// Small gate and terminal text for the departure, only when known.
export function gateText(f) {
    const parts = [f.dep_terminal ? `T${f.dep_terminal}` : null, f.dep_gate ? `gate ${f.dep_gate}` : null].filter(Boolean);
    return parts.length ? parts.join(' ') : null;
}

// Appended to the route cell and the status cell of a row.
export function rowExtras(f) {
    const g = gateText(f);
    return { gate: g ? h('span', { class: 'live-note muted', text: g }) : null, delay: delayChip(f) };
}

/* ---------- Data sources card ---------- */

const SOURCE_HINT = {
    aerodatabox: 'Needs AERODATABOX_API_KEY in the hub .env. Looked up when you press Refresh.',
    gmail: 'Filled by the Gmail status scan, no key.',
};

export function sourcesCard(ctx, initial) {
    const root = h('section', { class: 'panel sources-card', 'aria-labelledby': 'src-title' });
    let month = initial.month;
    let rows = initial.sources.map((s) => ({ ...s }));
    let saved = JSON.stringify(rows.map(snapshot));
    let busy = false;
    let error = '';

    function snapshot(s) { return { name: s.name, enabled: Boolean(s.enabled), priority: s.priority, monthly_cap: s.monthly_cap }; }
    const dirty = () => JSON.stringify(rows.map(snapshot)) !== saved;

    function move(i, dir) {
        const j = i + dir;
        if (j < 0 || j >= rows.length) return;
        [rows[i], rows[j]] = [rows[j], rows[i]];
        rows.forEach((s, n) => { s.priority = (n + 1) * 10; });
        paint(`${dir < 0 ? 'up' : 'down'}:${rows[j].name}`);
    }

    async function save() {
        error = '';
        for (const s of rows) {
            if (s.monthly_cap != null && (!Number.isInteger(s.monthly_cap) || s.monthly_cap < 0 || s.monthly_cap > 1000000)) {
                error = `${s.label}: the monthly cap must be a whole number, or empty for no cap.`;
                paint();
                return;
            }
        }
        busy = true;
        paint();
        try {
            const res = await ctx.api('/flights/sources', { method: 'PUT', body: { sources: rows.map(snapshot) } });
            month = res.month;
            rows = res.sources.map((s) => ({ ...s }));
            saved = JSON.stringify(rows.map(snapshot));
            busy = false;
            toast('Data sources saved');
            paint('src-save');
        } catch (err) {
            busy = false;
            if (err.status === 401) return;
            error = `Could not save. ${err.message}`;
            toast(error, { kind: 'bad' });
            paint('src-save');
        }
    }

    function usage(s) {
        if (s.calls_this_month == null) return h('p', { class: 'usage-text muted', text: 'Not counted: pushed in, no lookups.' });
        const used = s.calls_this_month;
        const pct = s.monthly_cap ? Math.min(100, Math.round((used / s.monthly_cap) * 100)) : 0;
        const bar = h('span', { class: `usage-bar${s.monthly_cap && used >= s.monthly_cap ? ' is-full' : ''}`, role: 'img', 'aria-label': s.monthly_cap ? `${pct} percent of the monthly cap used` : 'No cap' }, h('span', { class: 'usage-fill' }));
        bar.firstChild.style.width = `${pct}%`;
        return h('div', { class: 'usage' },
            h('p', { class: 'usage-text', 'data-key': `usage:${s.name}`, text: `${used} / ${s.monthly_cap == null ? 'no cap' : s.monthly_cap} calls this month` }), bar);
    }

    function sourceRow(s, i) {
        const pull = s.kind === 'pull';
        const sw = toggleSwitch({ checked: s.enabled, label: `${s.label} on`, key: `src-on:${s.name}`, onChange: (v) => { s.enabled = v; paint(`src-on:${s.name}`); } });
        const cap = h('input', {
            type: 'number', min: '0', max: '1000000', step: '1', inputmode: 'numeric', name: `cap-${s.name}`, 'data-key': `src-cap:${s.name}`, id: `src-cap-${s.name}`,
            value: s.monthly_cap == null ? '' : String(s.monthly_cap), placeholder: 'No cap',
            oninput: (event) => {
                const t = event.target.value.trim();
                s.monthly_cap = t === '' ? null : /^\d+$/.test(t) ? Number(t) : NaN;
                saveBtn.disabled = busy || !dirty();
            },
        });
        return h('li', { class: `source-row${s.enabled ? '' : ' is-off'}`, 'data-source': s.name },
            h('div', { class: 'source-head' },
                h('strong', { class: 'source-name', text: s.label }),
                chip(s.configured ? 'Configured' : 'Not configured', { cls: s.configured ? 'cfg-yes' : 'cfg-no' }),
                s.verified === false ? chip('Not checked against live data yet', { cls: 'cfg-unverified' }) : null),
            h('p', { class: 'hint note', text: SOURCE_HINT[s.name] || (pull ? 'Looked up when you press Refresh.' : 'Pushed in by a job.') }),
            h('div', { class: 'source-controls' },
                h('div', { class: 'ctl ctl-switch' }, sw, h('span', { class: 'switch-text', text: s.enabled ? 'On' : 'Off' })),
                h('div', { class: 'ctl ctl-priority' },
                    h('span', { class: 'ctl-label', id: `pr-${s.name}`, text: 'Priority' }),
                    h('strong', { class: 'prio-num', 'data-key': `prio:${s.name}`, 'aria-labelledby': `pr-${s.name}`, text: String(s.priority) }),
                    button({ iconName: 'prev', variant: 'ghost', size: 'small', label: `Raise ${s.label}: lower number wins`, 'data-key': `up:${s.name}`, disabled: i === 0, onClick: () => move(i, -1) }),
                    button({ iconName: 'next', variant: 'ghost', size: 'small', label: `Lower ${s.label}`, 'data-key': `down:${s.name}`, disabled: i === rows.length - 1, onClick: () => move(i, 1) })),
                pull ? h('div', { class: 'ctl ctl-cap' }, h('label', { for: `src-cap-${s.name}`, text: 'Monthly cap' }), cap) : null),
            usage(s));
    }

    let saveBtn;
    function paint(focusKey) {
        saveBtn = button({ text: busy ? 'Saving…' : 'Save', size: 'small', 'data-key': 'src-save', disabled: busy || !dirty(), onClick: save });
        root.replaceChildren(
            h('h2', { id: 'src-title', class: 'section-title', text: 'Data sources' }),
            h('p', { class: 'note', text: 'Flights are refreshed on demand only: press Refresh from sources in a flight. Nothing looks them up in the background. Where sources disagree, the lower priority number wins, and a field you edited by hand is never overwritten.' }),
            h('ul', { class: 'source-list' }, rows.map(sourceRow)),
            h('div', { class: 'row source-actions' }, saveBtn,
                dirty() && !busy ? h('span', { class: 'note', text: 'You have unsaved changes.' }) : null,
                month ? h('span', { class: 'muted', text: `Usage month: ${month}` }) : null),
            error ? h('p', { class: 'error', role: 'alert', text: error }) : null);
        if (focusKey) {
            const alt = focusKey.startsWith('up:') ? `down:${focusKey.slice(3)}` : focusKey.startsWith('down:') ? `up:${focusKey.slice(5)}` : null;
            const el = [focusKey, alt].map((k) => k && root.querySelector(`[data-key="${k}"]`)).find((e) => e && !e.disabled);
            if (el) el.focus();
        }
    }
    paint();
    return root;
}
