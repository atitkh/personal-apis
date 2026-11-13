// Lifelog: what you did and where, as raw lines (observations) and the episodes made from them.
//   #/lifelog                      today (in the hub time zone)
//   #/lifelog/2026-11-13           one day: 24-hour strip, episodes, summary, raw lines (collapsed), search
//   #/lifelog/episode/12?date=...  that episode's drawer over its day (add ?date= to keep the day behind it)
//   #/lifelog?q=biryani            search across all days (raw lines and episodes)
//   #/lifelog?new=episode|note     the New episode / Add note dialog (the palette uses it)
// The most private page: raw lines can describe people and places. Server text only ever goes in as text. Nothing
// here is kept in browser storage. Episodes are never deleted here (the API has no such call);
// "Forget a time range" under Manage is the one way anything goes.
import {
    h, button, plural, when, ago, emptyState, errorState, toast, confirmDialog, formDialog, deleteDialog, openDrawer, fact, hidden,
    actorName, dayLabel, pageHeader, formActions, bytes } from '../ui.js';
import { href, navigate, parse } from '../router.js';

const KINDS = ['eat', 'drink', 'sleep', 'sit', 'walk', 'move', 'work', 'exercise', 'place_item', 'see', 'other'];
const KIND_HUE = { eat: 'amber', drink: 'cobalt', sleep: 'plum', sit: 'neutral', walk: 'teal', move: 'cobalt', work: 'brick', exercise: 'rose', place_item: 'neutral', see: 'teal', other: 'neutral' };
const HUES = ['amber', 'cobalt', 'teal', 'plum', 'rose', 'brick'];
const SLUG = /^[a-z][a-z0-9_-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LANE = 26;           // px per lane in the strip
const DENSITY_PAGES = 5;   // the tick row reads at most 5 x 200 lines of a day
const REV_WHAT = { create: 'Created', edit: 'Edited', restore: 'Restored' };

const hue = (k) => KIND_HUE[k] || (k ? HUES[[...k].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length] : 'neutral');
const kindLabel = (k) => (k ? k.replace(/_/g, ' ') : 'no kind');
const fieldError = (message, name) => Object.assign(new Error(message), { field: name });
const trim = (v) => (v == null ? null : String(v).trim() || null);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

let tz = 'UTC';           // the hub time zone, read from the settings on each render
let drawer = null;        // { id, handle, fromList } the episode drawer that matches the URL
let side = false;         // a New episode / Add note / Forget dialog is open
let lastWasList = false;  // the previous render was a plain day (closing the drawer can go back)
let panel = { date: null, open: false, source: '', kind: '' }; // the raw-lines panel, in memory only
let fieldId = 0;

/* ---------- time in the hub zone (dates are local dates there) ---------- */

const zoneParts = (ms, zone = tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
}).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const offsetAt = (ms) => { const s = Math.floor(ms / 1000) * 1000; const p = zoneParts(s); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - s; };
const dateOf = (ms) => { const p = zoneParts(ms); return `${p.year}-${p.month}-${p.day}`; };
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export function startOfDay(date) {
    const [y, m, d] = date.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    let t = guess - offsetAt(guess);
    t = guess - offsetAt(t);
    return t;
}
export const toLocalInput = (iso) => { const p = zoneParts(Date.parse(iso)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
export function fromLocalInput(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
    if (!m) return null;
    const g = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    let t = g - offsetAt(g);
    t = g - offsetAt(t);
    return new Date(t).toISOString();
}
const clocks = new Map();
function clock(iso, secs = false) {
    const key = `${tz}|${secs}`;
    if (!clocks.has(key)) clocks.set(key, new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}) }));
    return clocks.get(key).format(new Date(iso));
}
const range = (e) => (e.end_at ? `${clock(e.start_at)} to ${clock(e.end_at)}` : clock(e.start_at));
const minutes = (n) => (n == null ? '' : n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`);
const dayHref = (d) => href('lifelog', [d]);
const episodeHref = (id, d) => href('lifelog', ['episode', String(id)], { date: d });

/* ---------- small pieces ---------- */

const kindChip = (k) => h('span', { class: 'chip kind-chip' }, h('span', { class: `swatch hue-${hue(k)}`, 'aria-hidden': 'true' }), h('span', { text: kindLabel(k) }));
const sourceChip = (s) => h('span', { class: 'chip source-chip', title: 'Source' }, h('span', { text: s }));

function field(label, input, help) {
    const id = input.id || `lf-${++fieldId}`;
    input.id = id;
    const helpId = help ? `${id}-help` : null;
    if (helpId) input.setAttribute('aria-describedby', helpId);
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('p', { class: 'help', id: helpId, text: help }) : null);
}
const textInput = (name, value, attrs = {}) => h('input', { type: 'text', name, autocomplete: 'off', spellcheck: 'false', value: value == null ? '' : String(value), 'data-key': `f-${name}`, ...attrs });
const textarea = (name, value, rows = '3') => { const el = h('textarea', { name, rows, maxlength: '2000', class: 'plain', 'data-key': `f-${name}` }); el.value = value || ''; return el; };

// A kind select with the suggested kinds and a custom slug.
function kindPicker(value, optional = false) {
    const known = KINDS.includes(value);
    const select = h('select', { name: 'kind', 'data-key': 'f-kind' },
        optional ? h('option', { value: '', text: 'No kind' }) : null,
        KINDS.map((k) => h('option', { value: k, text: cap(kindLabel(k)) })),
        h('option', { value: '__custom', text: 'Custom…' }));
    const custom = h('input', { type: 'text', name: 'kind_custom', maxlength: '40', placeholder: 'a lowercase word, like cook', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Custom kind', 'data-key': 'f-kind-custom' });
    select.value = value && !known ? '__custom' : (value || (optional ? '' : 'other'));
    if (value && !known) custom.value = value;
    const sync = () => { custom.hidden = select.value !== '__custom'; };
    select.addEventListener('change', sync);
    sync();
    return {
        select, custom,
        raw: () => `${select.value}|${select.value === '__custom' ? custom.value.trim() : ''}`,
        get() {
            if (select.value !== '__custom') return select.value || null;
            const v = custom.value.trim().toLowerCase();
            if (!SLUG.test(v)) throw fieldError('A custom kind is a lowercase word like cook: letters, digits, - or _.', 'kind_custom');
            return v;
        },
    };
}

/* ---------- the episode fields (New episode dialog and the drawer form) ---------- */

function episodeFields(v, { cancelled = false } = {}) {
    const kind = kindPicker(v.kind);
    const title = textInput('title', v.title, { maxlength: '120', placeholder: 'Ate lunch' });
    const start = textInput('start', v.start, { type: 'datetime-local' });
    const end = textInput('end', v.end, { type: 'datetime-local' });
    const place = textInput('place', v.place, { maxlength: '120', placeholder: 'kitchen' });
    const detail = textarea('detail', v.detail);
    const conf = textInput('confidence', v.confidence, { type: 'number', min: '0', max: '1', step: '0.05', inputmode: 'decimal' });
    const box = h('input', { type: 'checkbox', name: 'cancelled', id: `lf-${++fieldId}`, 'data-key': 'f-cancelled' });
    box.checked = cancelled;
    const wrapKind = field('Kind', kind.select);
    wrapKind.append(kind.custom);
    const nodes = [
        field('Title', title, 'What happened, in a few words.'),
        wrapKind,
        field('Start', start, `Time in ${tz}.`),
        field('End (optional)', end),
        field('Place (optional)', place),
        field('Detail (optional)', detail),
        field('Confidence (optional)', conf, 'A number from 0 to 1.'),
    ];
    return {
        nodes, cancelled: box, els: { title, start, end },
        raw: () => JSON.stringify([kind.raw(), title.value, start.value, end.value, place.value, detail.value, conf.value, box.checked]),
        read() {
            const t = title.value.trim();
            if (!t) throw fieldError('Give the episode a title.', 'title');
            const startAt = fromLocalInput(start.value);
            if (!startAt) throw fieldError('Pick a start time.', 'start');
            const endAt = end.value ? fromLocalInput(end.value) : null;
            if (endAt && endAt < startAt) throw fieldError('The end cannot be before the start.', 'end');
            let c = null;
            if (conf.value.trim() !== '') {
                c = Number(conf.value);
                if (!Number.isFinite(c) || c < 0 || c > 1) throw fieldError('Confidence is a number from 0 to 1.', 'confidence');
            }
            return { kind: kind.get(), title: t, start_at: startAt, end_at: endAt, place: trim(place.value), detail: trim(detail.value), confidence: c, status: box.checked ? 'cancelled' : 'active' };
        },
    };
}

const nowInput = (date) => (!date || date === dateOf(Date.now()) ? toLocalInput(new Date().toISOString()) : `${date}T12:00`);

// After a change: same day -> refresh, another day -> go there.
function afterAdd(ctx, day, current) {
    if (day && day !== current && parse().name === 'lifelog') navigate(dayHref(day));
    else ctx.rerender();
}

async function newEpisode(ctx, date) {
    if (side) return;
    side = true;
    const f = episodeFields({ kind: 'other', title: '', start: nowInput(date), end: '', place: '', detail: '', confidence: '' });
    try {
        await formDialog({
            title: 'New episode', cls: 'lifelog-dialog',
            intro: 'An episode is one thing that happened: ate lunch, a walk, a night of sleep. It needs a title and a start; lines can be linked to it later.',
            fields: f.nodes, submit: 'Add episode',
            onSubmit: async () => {
                const v = f.read();
                const body = Object.fromEntries(Object.entries(v).filter(([k, x]) => x != null && k !== 'status'));
                await ctx.api('/lifelog/episodes', { method: 'POST', body });
                toast('Episode added');
                afterAdd(ctx, dateOf(Date.parse(v.start_at)), date);
            },
        });
    } finally { side = false; }
}

async function addNote(ctx, date) {
    if (side) return;
    side = true;
    const at = textInput('at', nowInput(date), { type: 'datetime-local' });
    const text = textarea('text', '', '4');
    const kind = kindPicker('', true);
    const place = textInput('place', '', { maxlength: '120', placeholder: 'kitchen' });
    const wrapKind = field('Kind (optional)', kind.select);
    wrapKind.append(kind.custom);
    try {
        await formDialog({
            title: 'Add note', cls: 'lifelog-dialog',
            intro: 'A note is one raw line from you, stored with the source dashboard. It is never edited afterwards.',
            fields: [field('Note', text, 'Up to 2000 characters, plain text.'), field('When', at, `Time in ${tz}.`), wrapKind, field('Place (optional)', place)],
            submit: 'Add note',
            onSubmit: async () => {
                const t = text.value.trim();
                if (!t) throw fieldError('Write the note first.', 'text');
                const iso = fromLocalInput(at.value);
                if (!iso) throw fieldError('Pick a time.', 'at');
                const body = { at: iso, text: t };
                const k = kind.get();
                if (k) body.kind = k;
                if (trim(place.value)) body.place = trim(place.value);
                await ctx.api('/lifelog/observations', { method: 'POST', body });
                toast('Note added');
                afterAdd(ctx, dateOf(Date.parse(iso)), date);
            },
        });
    } finally { side = false; }
}

/* ---------- forget a time range (admin only) ---------- */

async function forgetRange(ctx, date, sources) {
    if (side) return;
    side = true;
    try {
        const from = textInput('from', `${date}T00:00`, { type: 'datetime-local' });
        const to = textInput('to', `${date}T23:59`, { type: 'datetime-local' });
        const src = h('select', { name: 'source', 'data-key': 'f-source' }, h('option', { value: '', text: 'All sources' }), sources.map((s) => h('option', { value: s.label, text: s.label })));
        const preview = h('p', { class: 'note lifelog-preview', role: 'status', 'aria-live': 'polite', 'data-key': 'forget-preview', text: 'Pick a range to see what it would remove.' });
        const bounds = () => {
            const a = fromLocalInput(from.value);
            const b = fromLocalInput(to.value);
            if (!a || !b) throw fieldError('Pick both a start and an end.', 'from');
            const hi = new Date(Date.parse(b) + 59999).toISOString(); // the end minute counts in full
            if (hi < a) throw fieldError('The end is before the start.', 'to');
            return { from: a, to: hi, source: src.value || null };
        };
        const ask = async () => {
            const r = bounds();
            const qs = new URLSearchParams({ from: r.from, to: r.to, ...(r.source ? { source: r.source } : {}) });
            return { r, pre: await ctx.api(`/lifelog/forget-preview?${qs}`) };
        };
        let seq = 0;
        let timer = null;
        const update = () => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
                const mine = ++seq;
                try {
                    const { pre } = await ask();
                    if (mine !== seq) return;
                    const c = pre.counts;
                    preview.textContent = `This range holds ${plural(c.observations, 'raw line')}, ${plural(c.episodes, 'episode')} lying fully inside it and ${plural(c.links, 'link')}.`;
                } catch (err) { if (mine === seq) preview.textContent = err.message; }
            }, 250);
        };
        for (const el of [from, to, src]) { el.addEventListener('input', update); el.addEventListener('change', update); }
        update();
        const picked = await formDialog({
            title: 'Forget a time range', cls: 'lifelog-dialog',
            intro: 'Pick the range to remove. Nothing is deleted yet: the next step shows what goes and asks you to confirm.',
            fields: [field('From', from, `Time in ${tz}.`), field('To', to, 'This minute is included.'), field('Only this source (optional)', src), preview],
            submit: 'Continue',
            onSubmit: async () => {
                const got = await ask();
                const c = got.pre.counts;
                if (!c.observations && !c.episodes) throw fieldError('There is nothing in that range.', 'from');
                return got;
            },
        });
        clearTimeout(timer);
        if (!picked) return;
        const { r, pre } = picked;
        const c = pre.counts;
        const out = await deleteDialog({
            title: 'Forget this time range?',
            goes: [plural(c.observations, 'raw line'), `${plural(c.episodes, 'episode')} lying fully inside the range`, `${plural(c.links, 'link')} between lines and episodes`, 'Their entries in search'],
            stays: ['Episodes that only overlap the range (they stay, without the links to lines that go)', 'Anything outside the range or, when a source is chosen, from other sources'],
            warn: `Range: ${when(r.from)} to ${when(r.to)}${r.source ? `, only lines from ${r.source}` : ''}.`,
            run: (o) => ctx.api('/lifelog/observations', { method: 'DELETE', body: { from: r.from, to: r.to, ...(r.source ? { source: r.source } : {}), confirm: true, backup: o.backup } }),
        });
        if (out) {
            toast(`Forgot ${plural(out.counts.observations, 'raw line')}, ${plural(out.counts.episodes, 'episode')} and ${plural(out.counts.links, 'link')}`);
            if (drawer) { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
            if (parse().parts[0] === 'episode') navigate(dayHref(date), { replace: true }); else ctx.rerender();
        }
    } finally { side = false; }
}

/* ---------- raw lines (paged lists) ---------- */

function lineRow(o, { showDate, select }) {
    const li = h('li', { class: 'lifelog-line' });
    if (select) li.append(h('input', { type: 'checkbox', value: String(o.id), 'aria-label': `Select the line at ${clock(o.at, true)}`, 'data-key': `pick:${o.id}` }));
    const time = h('time', { datetime: o.at, class: 'line-time' }, showDate ? [h('a', { class: 'row-link', href: dayHref(o.local_date), text: o.local_date }), ' '] : null, clock(o.at, true));
    li.append(h('div', { class: 'line-main' },
        h('p', { class: 'line-head' }, time, ' ', sourceChip(o.source), o.kind ? kindChip(o.kind) : null),
        h('p', { class: 'line-text', text: o.text }),
        o.place ? h('p', { class: 'line-place muted', text: o.place }) : null));
    return li;
}

// A paged list of raw lines. params() -> the filters; showDate adds the day link; select adds checkboxes; skip hides ids.
function linesList(ctx, { params, showDate = false, select = false, skip = new Set(), empty = 'No raw lines match.' }) {
    const list = h('ul', { class: 'lifelog-lines' });
    const status = h('p', { class: 'muted lifelog-status', role: 'status' });
    const more = button({ text: 'Show more', variant: 'quiet', size: 'small', 'data-key': 'lines-more', onClick: () => load(false) });
    more.hidden = true;
    let offset = 0;
    let seq = 0;
    async function load(reset) {
        const mine = ++seq;
        if (reset) { offset = 0; list.replaceChildren(); }
        status.textContent = 'Loading…';
        more.hidden = true;
        try {
            const qs = new URLSearchParams({ ...params(), limit: '50', offset: String(offset) });
            const r = await ctx.api(`/lifelog/observations?${qs}`);
            if (mine !== seq) return;
            offset += r.observations.length;
            for (const o of r.observations) if (!skip.has(o.id)) list.append(lineRow(o, { showDate, select }));
            status.textContent = r.total ? `Showing ${Math.min(offset, r.total)} of ${plural(r.total, 'line')}` : empty;
            more.hidden = offset >= r.total;
        } catch (err) { if (mine === seq && err.status !== 401) status.textContent = `Could not load the lines. ${err.message}`; }
    }
    return { el: h('div', { class: 'lifelog-lines-wrap' }, status, list, more), load, picked: () => [...list.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
}

function rawPanel(ctx, date, day) {
    if (panel.date !== date) panel = { date, open: false, source: '', kind: '' };
    const n = day.observations.count;
    const body = h('div', { class: 'lifelog-raw-body', id: 'll-raw', hidden: true });
    const toggle = button({ text: `Show raw lines (${n})`, variant: 'quiet', iconName: 'next', 'data-key': 'raw-toggle', 'aria-expanded': 'false', 'aria-controls': 'll-raw', onClick: () => flip() });
    const label = toggle.querySelector('span');
    let list = null;
    const option = (v, text) => h('option', { value: v, text });
    function open() {
        const src = h('select', { name: 'source', 'aria-label': 'Filter by source', 'data-key': 'raw-source' }, option('', 'All sources'), day.observations.by_source.filter((s) => s.source).map((s) => option(s.source, `${s.source} (${s.count})`)));
        const knd = h('select', { name: 'kind', 'aria-label': 'Filter by kind', 'data-key': 'raw-kind' }, option('', 'All kinds'), day.observations.by_kind.filter((k) => k.kind).map((k) => option(k.kind, `${kindLabel(k.kind)} (${k.count})`)));
        src.value = panel.source; knd.value = panel.kind;
        list = linesList(ctx, { params: () => ({ local_date: date, order: 'asc', ...(panel.source ? { source: panel.source } : {}), ...(panel.kind ? { kind: panel.kind } : {}) }) });
        const change = () => { panel.source = src.value; panel.kind = knd.value; list.load(true); };
        src.addEventListener('change', change); knd.addEventListener('change', change);
        body.replaceChildren(h('div', { class: 'lifelog-filters' }, src, knd), list.el);
        body.hidden = false; toggle.setAttribute('aria-expanded', 'true'); label.textContent = `Hide raw lines (${n})`; panel.open = true;
        list.load(true);
    }
    function flip() {
        if (panel.open) { panel.open = false; body.hidden = true; toggle.setAttribute('aria-expanded', 'false'); label.textContent = `Show raw lines (${n})`; } else open();
    }
    if (!n) { toggle.disabled = true; label.textContent = 'No raw lines this day'; } else if (panel.open) open();
    return h('section', { class: 'lifelog-raw', 'aria-label': 'Raw lines' }, toggle, body);
}

/* ---------- the day: strip, episodes, summary ---------- */

async function density(ctx, date, count) {
    if (!count) return null;
    const pages = Math.min(DENSITY_PAGES, Math.ceil(count / 200));
    const res = await Promise.all(Array.from({ length: pages }, (_, i) => ctx.api(`/lifelog/observations?local_date=${date}&order=asc&limit=200&offset=${i * 200}`).catch(() => null)));
    const start = startOfDay(date);
    const span = startOfDay(addDays(date, 1)) - start;
    const bins = Array(24).fill(0);
    let seen = 0;
    for (const r of res) for (const o of (r ? r.observations : [])) { bins[Math.min(23, Math.max(0, Math.floor(((Date.parse(o.at) - start) / span) * 24)))] += 1; seen += 1; }
    return { bins, seen, partial: seen < count, start, span };
}

function strip(date, episodes, dens) {
    const start = startOfDay(date);
    const span = startOfDay(addDays(date, 1)) - start;
    const pos = (iso) => Math.min(1, Math.max(0, (Date.parse(iso) - start) / span));
    const items = episodes.map((e) => { const a = pos(e.start_at); return { e, a, b: Math.max(e.end_at ? pos(e.end_at) : a, a + 0.008) }; }).sort((x, y) => x.a - y.a);
    const ends = [];
    for (const it of items) {
        let lane = ends.findIndex((end) => end <= it.a);
        if (lane < 0) { lane = ends.length; ends.push(0); }
        ends[lane] = it.b;
        it.lane = lane;
    }
    const lanes = Math.max(1, ends.length);
    const max = dens ? Math.max(...dens.bins, 1) : 1;
    const busiest = dens ? dens.bins.indexOf(Math.max(...dens.bins)) : 0;
    return h('div', { class: 'lifelog-strip', role: 'group', 'aria-label': `24-hour timeline for ${date}` },
        h('div', { class: 'lifelog-lanes', style: `height:${lanes * LANE}px` }, items.map(({ e, a, b, lane }) => h('a', {
            class: `lifelog-block hue-${hue(e.kind)}${e.status === 'cancelled' ? ' is-cancelled' : ''}`,
            style: `left:${(a * 100).toFixed(3)}%;width:${((b - a) * 100).toFixed(3)}%;top:${lane * LANE}px`,
            href: episodeHref(e.id, date), 'data-key': `block:${e.id}`,
            'aria-label': `${e.title}, ${kindLabel(e.kind)}, ${range(e)}${e.status === 'cancelled' ? ', cancelled' : ''}`, title: `${e.title}: ${range(e)}`,
        }, h('span', { class: 'block-text', text: e.title })))),
        h('div', { class: 'lifelog-ticks', role: 'img', 'aria-label': dens ? `Raw lines per hour. Busiest hour starts at ${String(busiest).padStart(2, '0')}:00 with ${dens.bins[busiest]} lines${dens.partial ? '; based on the first lines of the day' : ''}.` : 'No raw lines this day.' },
            Array.from({ length: 24 }, (_, i) => h('span', { class: 'lifelog-tick', style: `--d:${dens ? (dens.bins[i] / max).toFixed(2) : 0}`, title: `${String(i).padStart(2, '0')}:00, ${plural(dens ? dens.bins[i] : 0, 'line')}` }))),
        h('div', { class: 'lifelog-hours', 'aria-hidden': 'true' }, [0, 3, 6, 9, 12, 15, 18, 21, 24].map((x) => h('span', { style: `left:${(x / 24) * 100}%`, text: String(x).padStart(2, '0') }))));
}

function episodeRow(e, date) {
    const cancelled = e.status === 'cancelled';
    return h('li', { class: `lifelog-episode${cancelled ? ' is-cancelled' : ''}` },
        h('p', { class: 'ep-time' }, range(e), e.duration_min != null ? h('span', { class: 'muted', text: ` · ${minutes(e.duration_min)}` }) : null),
        h('div', { class: 'ep-main' },
            h('p', { class: 'ep-title' }, h('a', { class: 'row-link', href: episodeHref(e.id, date), 'data-key': `episode:${e.id}`, text: e.title }), ' ', kindChip(e.kind), ' ', sourceChip(e.source),
                cancelled ? h('span', { class: 'chip status-chip is-cancelled' }, h('span', { text: 'Cancelled' })) : null),
            h('p', { class: 'ep-meta muted' }, [e.place, e.confidence != null ? `confidence ${Math.round(e.confidence * 100)}%` : null, e.observation_count ? plural(e.observation_count, 'linked line') : null].filter(Boolean).join(' · '))));
}

function summary(day) {
    const o = day.observations;
    if (!o.count) return h('p', { class: 'lifelog-summary muted', text: 'No raw lines this day.' });
    const by = (rows, key, fmt) => rows.map((r) => `${fmt(r[key])} ${r.count}`).join(', ');
    return h('p', { class: 'lifelog-summary' },
        h('strong', { text: plural(o.count, 'raw line') }), ` from ${by(o.by_source, 'source', (s) => s || 'unknown')}. Kinds: ${by(o.by_kind, 'kind', (k) => kindLabel(k))}. First ${clock(o.first_at)}, last ${clock(o.last_at)}.`);
}

/* ---------- sources and storage ---------- */

function sourcesPanel(sources) {
    return h('section', { class: 'lifelog-sources', 'aria-labelledby': 'll-sources' },
        h('h3', { id: 'll-sources', text: 'Sources' }),
        sources && sources.length
            ? h('div', { class: 'table-wrap' }, h('table', { class: 'lifelog-source-table' },
                h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Source' }), h('th', { scope: 'col', class: 'num', text: 'Lines' }), h('th', { scope: 'col', text: 'Last seen' }))),
                h('tbody', {}, sources.map((s) => h('tr', {}, h('th', { scope: 'row', text: s.label }), h('td', { class: 'num', text: s.count.toLocaleString() }), h('td', {}, h('time', { datetime: s.last_seen, text: when(s.last_seen) }), ` (${ago(s.last_seen)})`))))))
            : h('p', { class: 'muted', text: sources ? 'No source has sent anything yet.' : 'The source list did not load.' }));
}

function storageLine(st) {
    if (!st) return h('p', { class: 'note lifelog-storage', text: 'Storage numbers did not load.' });
    return h('p', { class: 'note lifelog-storage', 'data-key': 'storage' },
        `Storage: ${plural(st.observations, 'raw line')} and ${plural(st.episodes, 'episode')}, about ${bytes(st.approx_bytes)} of text`,
        st.oldest ? `, from ${when(st.oldest)} to ${when(st.newest)}` : '', '. Nothing expires; Forget a time range is the only way anything is removed.');
}

/* ---------- the episode drawer ---------- */

function closeDrawerTo(fromList, date) {
    if (fromList && history.length > 1) history.back();
    else navigate(dayHref(date), { replace: true });
}

function snapshotLines(e) {
    return [`Kind: ${kindLabel(e.kind)}`, `Title: ${e.title}`, `Start: ${when(e.start_at)}`, `End: ${e.end_at ? when(e.end_at) : 'not set'}`, `Place: ${e.place || 'none'}`, `Confidence: ${e.confidence != null ? e.confidence : 'not set'}`, `Cancelled: ${e.status === 'cancelled' ? 'yes' : 'no'}`];
}

function episodeDrawer(ctx, id, date, fromList, mark) {
    let ep = null;
    let form = null;
    let linker = null;
    const handle = openDrawer({
        title: 'Episode', subtitle: 'Loading…', content: h('p', { class: 'muted', text: 'Loading…' }), wide: true,
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard your changes?', body: 'The episode keeps what was last saved.', confirm: 'Discard', danger: true }),
        onClose: () => { if (drawer && drawer.handle === handle) { drawer = null; closeDrawerTo(fromList, date); } },
        returnFocus: () => document.querySelector(`[data-key="episode:${id}"]`) || document.querySelector(`[data-key="block:${id}"]`) || document.querySelector('[data-key="new-episode"]'),
    });
    const focusKey = (key) => { const el = key && handle.body.querySelector(`[data-key="${key}"]`); if (el) el.focus(); else handle.el.querySelector('.drawer-head button').focus(); };
    const changed = async (key) => { await load(key); ctx.rerender(); };

    async function load(key) {
        const top = handle.body.scrollTop;
        try {
            ep = await ctx.api(`/lifelog/episodes/${id}`);
        } catch (err) {
            if (err.status === 401) return;
            if (err.status === 404) { toast('That episode is gone or never existed.', { kind: 'info' }); drawer = null; handle.close(true); closeDrawerTo(fromList, date); return; }
            handle.setTitle('Episode', '');
            handle.setContent(errorState({ err, what: 'This episode', retry: () => load(key) }));
            return;
        }
        handle.setTitle(ep.title, `${cap(kindLabel(ep.kind))}, ${ep.local_date}, revision ${ep.rev}`);
        handle.setContent(content());
        handle.body.scrollTop = top;
        if (key) focusKey(key);
    }

    function details() {
        const values = { kind: ep.kind, title: ep.title, start: toLocalInput(ep.start_at), end: ep.end_at ? toLocalInput(ep.end_at) : '', place: ep.place || '', detail: ep.detail || '', confidence: ep.confidence == null ? '' : String(ep.confidence) };
        const f = episodeFields(values, { cancelled: ep.status === 'cancelled' });
        const base = f.raw();
        const error = h('p', { class: 'error', role: 'alert' });
        const save = button({ text: 'Save changes', type: 'submit', size: 'small', 'data-key': 'ef-save' });
        const form1 = h('form', { class: 'place-form flight-form lifelog-form', novalidate: true,
            onsubmit: async (event) => {
                event.preventDefault();
                error.replaceChildren();
                save.disabled = true;
                try {
                    const v = f.read();
                    const was = { kind: ep.kind, title: ep.title, start_at: ep.start_at, end_at: ep.end_at, place: ep.place, detail: ep.detail, confidence: ep.confidence, status: ep.status };
                    const body = Object.fromEntries(Object.keys(was).filter((k) => !Object.is(v[k], was[k]) && !(k === 'start_at' && Date.parse(v[k]) === Date.parse(was[k])) && !(k === 'end_at' && v[k] && was[k] && Date.parse(v[k]) === Date.parse(was[k]))).map((k) => [k, v[k]]));
                    if (!Object.keys(body).length) { toast('Nothing changed', { kind: 'info' }); save.disabled = false; return; }
                    const res = await ctx.api(`/lifelog/episodes/${ep.id}`, { method: 'PATCH', body });
                    toast(res.status === 'unchanged' ? 'Nothing changed' : 'Changes saved', { kind: res.status === 'unchanged' ? 'info' : 'good' });
                    form = null;
                    await changed('ef-save');
                } catch (err) {
                    error.textContent = err.message;
                    const bad = err.field && form1.querySelector(`[name="${err.field}"]`);
                    if (bad) bad.focus();
                    save.disabled = false;
                }
            } },
        h('fieldset', { class: 'flight-group' }, h('legend', { text: 'Episode' }), h('div', { class: 'group-grid' },
            f.nodes.map((n, i) => h('div', { class: i === 0 || i === 5 ? 'wide-field' : '' }, n)),
            h('div', { class: 'wide-field' }, h('div', { class: 'check-field' },
                h('label', { class: 'check', for: f.cancelled.id }, f.cancelled, h('span', { text: 'This episode is cancelled' })),
                h('p', { class: 'help', text: 'A cancelled episode stays in the day, shown muted. Cancel instead of delete.' }))))),
        error, formActions(save));
        form = { dirty: () => f.raw() !== base };
        return form1;
    }

    async function unlink(o) {
        try {
            await ctx.api(`/lifelog/episodes/${ep.id}/observations/unlink`, { method: 'POST', body: { observation_ids: [o.id] } });
            toast('Line unlinked');
            linker = null;
            await changed('links');
        } catch (err) { toast(`Could not unlink. ${err.message}`, { kind: 'bad' }); }
    }

    function linksSection() {
        const box = h('div', { class: 'lifelog-linker' });
        const open = button({ text: 'Link lines from this day', variant: 'quiet', size: 'small', iconName: 'plus', 'data-key': 'link-open', onClick: () => {
            const have = new Set(ep.observations.map((o) => o.id));
            linker = linesList(ctx, { params: () => ({ local_date: ep.local_date, order: 'asc' }), select: true, skip: have, empty: 'No other lines on this day.' });
            const go = button({ text: 'Link selected', size: 'small', 'data-key': 'link-go', onClick: async () => {
                const ids = linker.picked();
                if (!ids.length) { toast('Tick at least one line first', { kind: 'info' }); return; }
                try {
                    await ctx.api(`/lifelog/episodes/${ep.id}/observations`, { method: 'POST', body: { observation_ids: ids } });
                    toast(`${plural(ids.length, 'line')} linked`);
                    linker = null;
                    await changed('links');
                } catch (err) { toast(`Could not link. ${err.message}`, { kind: 'bad' }); }
            } });
            box.replaceChildren(linker.el, formActions(go, button({ text: 'Cancel', variant: 'quiet', size: 'small', onClick: () => { linker = null; box.replaceChildren(open); open.focus(); } })));
            linker.load(true);
        } });
        box.append(open);
        return h('section', { class: 'drawer-section', 'aria-labelledby': 'ed-links' },
            h('h3', { id: 'ed-links', tabindex: '-1', 'data-key': 'links', text: `Linked lines, ${ep.observation_count}` }),
            h('p', { class: 'note', text: 'The raw lines behind this episode. Unlinking keeps the line; it only takes it off the episode.' }),
            ep.observations.length
                ? h('ul', { class: 'lifelog-lines' }, ep.observations.map((o) => { const li = lineRow(o, { showDate: false, select: false }); li.append(button({ text: 'Unlink', variant: 'quiet', size: 'small', label: `Unlink the line at ${clock(o.at, true)}`, onClick: () => unlink(o) })); return li; }))
                : h('p', { class: 'muted', text: 'No lines linked yet.' }),
            box);
    }

    async function restore(rev) {
        const ok = await confirmDialog({ title: `Restore revision ${rev}?`, body: `The fields of revision ${rev} become current, as a new revision. What you see now stays in the history. Linked lines are not part of a revision.`, confirm: 'Restore' });
        if (!ok) return;
        try {
            const res = await ctx.api(`/lifelog/episodes/${ep.id}/restore`, { method: 'POST', body: { rev } });
            toast(res.status === 'unchanged' ? 'That revision is the same as the current one' : `Revision ${rev} restored`, { kind: res.status === 'unchanged' ? 'info' : 'good' });
            form = null;
            changed('history');
        } catch (err) { toast(`Could not restore. ${err.message}`, { kind: 'bad' }); }
    }

    async function compare(rev) {
        handle.setContent(h('p', { class: 'muted', text: 'Loading…' }));
        try {
            const older = await ctx.api(`/lifelog/episodes/${ep.id}?rev=${rev}`);
            const a = snapshotLines(older);
            const b = snapshotLines(ep);
            const parts = [...a.filter((l) => !b.includes(l)).map((l) => ['del', l]), ...b.map((l) => [a.includes(l) ? 'same' : 'add', l])];
            const back = button({ text: 'Back to the episode', variant: 'ghost', size: 'small', iconName: 'prev', onClick: () => load('history') });
            handle.setContent(
                h('div', { class: 'compare-top' }, back, button({ text: `Restore revision ${rev}`, variant: 'quiet', size: 'small', onClick: () => restore(rev) })),
                h('div', { class: 'diff diff-plain' }, parts.map(([k, text]) => h('p', { class: k }, k === 'add' ? hidden('Added: ') : k === 'del' ? hidden('Removed: ') : null, text))));
            back.focus();
        } catch (err) { if (err.status !== 401) handle.setContent(errorState({ err, what: 'That revision', retry: () => compare(rev) })); }
    }

    function historySection() {
        return h('section', { class: 'drawer-section', 'aria-labelledby': 'ed-history' },
            h('h3', { id: 'ed-history', tabindex: '-1', 'data-key': 'history', text: `History, ${plural(ep.history.length, 'revision')}` }),
            h('p', { class: 'note', text: 'Every change is kept. Restoring adds a new revision, so nothing is lost.' }),
            h('ol', { class: 'rev-list', reversed: true }, ep.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
                h('div', { class: 'rev-main' },
                    h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                    h('p', { class: 'rev-what', text: `${REV_WHAT[r.source] || cap(r.source)} by ${actorName(r.actor)}${r.note ? `: ${r.note}` : ''}` }),
                    h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
                r.current ? null : h('div', { class: 'rev-actions' },
                    button({ text: 'Compare', variant: 'quiet', size: 'small', label: `Compare revision ${r.rev} with the current one`, onClick: () => compare(r.rev) }),
                    button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) }))))));
    }

    function content() {
        form = null;
        return [
            h('section', { class: 'drawer-section', 'aria-labelledby': 'ed-details' },
                h('h3', { id: 'ed-details', text: 'Details' }),
                h('p', { class: 'lifelog-state' }, kindChip(ep.kind), ' ', sourceChip(ep.source), ep.status === 'cancelled' ? h('span', { class: 'chip status-chip is-cancelled' }, h('span', { text: 'Cancelled' })) : null,
                    ' ', h('span', { class: 'muted', text: `${range(ep)}${ep.duration_min != null ? `, ${minutes(ep.duration_min)}` : ''}` })),
                details(),
                h('dl', { class: 'facts' }, fact('Last changed', `${ago(ep.updated_at)} by ${actorName(ep.updated_by)}`))),
            linksSection(),
            historySection(),
            h('section', { class: 'drawer-section' },
                h('p', { class: 'note', text: 'Episodes are never deleted here: cancel one instead. To remove a whole span of lines and episodes, use Manage, Forget a time range.' })),
        ];
    }

    mark.handle = handle;
    load();
}

function syncDrawer(ctx, id, date) {
    if ((drawer ? drawer.id : null) === id) return;
    if (drawer) { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
    if (!id) return;
    const mark = { id, handle: null, fromList: lastWasList };
    drawer = mark;
    setTimeout(() => { if (drawer === mark) episodeDrawer(ctx, id, date, mark.fromList, mark); }, 0);
}

/* ---------- the page ---------- */

function dayBar(ctx, date, isToday) {
    const input = h('input', { type: 'date', value: date, 'aria-label': 'Go to a day', 'data-key': 'date-input', class: 'lifelog-date' });
    input.addEventListener('change', () => { if (DATE.test(input.value)) navigate(dayHref(input.value)); });
    const search = h('input', { type: 'search', name: 'q', placeholder: 'Search all days', 'aria-label': 'Search raw lines and episodes on all days', 'data-key': 'search', autocomplete: 'off', spellcheck: 'false', maxlength: '120', value: ctx.route.query.get('q') || '' });
    return h('div', { class: 'toolbar lifelog-bar' },
        h('div', { class: 'row lifelog-nav' },
            button({ variant: 'quiet', iconName: 'prev', label: 'Previous day', 'data-key': 'prev', onClick: () => navigate(dayHref(addDays(date, -1))) }),
            input,
            button({ variant: 'quiet', iconName: 'next', label: 'Next day', 'data-key': 'next', onClick: () => navigate(dayHref(addDays(date, 1))) }),
            button({ text: 'Today', variant: 'quiet', 'data-key': 'today', disabled: isToday, onClick: () => navigate(href('lifelog')) })),
        h('form', { class: 'lifelog-search', role: 'search', onsubmit: (event) => {
            event.preventDefault();
            const v = search.value.trim();
            navigate(v ? href('lifelog', [], { q: v }) : dayHref(date));
        } }, search, button({ text: 'Search', variant: 'quiet', type: 'submit', 'data-key': 'search-go' })));
}

function manageMenu(ctx, date, sources) {
    const item = button({ text: 'Forget a time range…', variant: 'quiet-danger', iconName: 'trash', 'data-key': 'forget', onClick: () => { menu.open = false; forgetRange(ctx, date, sources || []); } });
    const menu = h('details', { class: 'lifelog-menu', 'data-key': 'manage' },
        h('summary', { class: 'btn quiet' }, h('span', { text: 'Manage' })),
        h('div', { class: 'lifelog-menu-list' }, item));
    const away = (event) => { if (menu.open && !menu.contains(event.target)) menu.open = false; };
    document.addEventListener('click', away);
    menu.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu.open) { event.stopPropagation(); menu.open = false; menu.querySelector('summary').focus(); } });
    ctx.onCleanup(() => document.removeEventListener('click', away));
    return menu;
}

async function searchResults(ctx, q) {
    const eps = await ctx.api(`/lifelog/episodes?${new URLSearchParams({ q, limit: '20', status: 'all' })}`).catch((err) => ({ error: err, episodes: [], total: 0 }));
    const lines = linesList(ctx, { params: () => ({ q, order: 'desc' }), showDate: true, empty: 'No raw lines match that search.' });
    setTimeout(() => lines.load(true), 0);
    return h('div', { class: 'lifelog-results' },
        h('p', { class: 'lifelog-summary' }, h('strong', { text: `Search: ${q}` }), ' on all days. ', h('a', { class: 'row-link', href: href('lifelog'), 'data-key': 'search-clear', text: 'Back to today' })),
        h('section', { 'aria-labelledby': 'll-res-eps' }, h('h3', { id: 'll-res-eps', text: `Episodes, ${eps.total}` }),
            eps.error ? h('p', { class: 'error', text: eps.error.message })
                : eps.episodes.length ? h('ol', { class: 'lifelog-episodes' }, eps.episodes.map((e) => h('li', { class: 'lifelog-episode' }, h('p', { class: 'ep-time' }, h('a', { class: 'row-link', href: dayHref(e.local_date), text: e.local_date }), ` ${clock(e.start_at)}`), episodeRow(e, e.local_date).lastChild)))
                    : h('p', { class: 'muted', text: 'No episode matches.' })),
        h('section', { 'aria-labelledby': 'll-res-obs' }, h('h3', { id: 'll-res-obs', text: 'Raw lines' }), lines.el));
}

export async function render(ctx) {
    const { parts, query } = ctx.route;
    const conf = await ctx.api('/settings').catch(() => null);
    tz = (conf && conf.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const today = dateOf(Date.now());

    let episodeId = null;
    let date = null;
    if (parts[0] === 'episode') {
        if (/^\d+$/.test(parts[1] || '') && parts.length === 2) episodeId = Number(parts[1]); else navigate(href('lifelog'), { replace: true });
        date = DATE.test(query.get('date') || '') ? query.get('date') : null;
        if (episodeId && !date) { const e = await ctx.api(`/lifelog/episodes/${episodeId}`).catch(() => null); date = e ? e.local_date : null; }
    } else if (parts[0]) {
        if (DATE.test(parts[0]) && parts.length === 1) date = parts[0]; else navigate(href('lifelog'), { replace: true });
    }
    date = date || today;
    const q = (query.get('q') || '').trim();

    const [day, sources, stats] = await Promise.all([
        ctx.api(`/lifelog/day/${date}`),
        ctx.api('/lifelog/sources').then((r) => r.sources).catch(() => null),
        ctx.api('/lifelog/stats').catch(() => null),
    ]);
    const dens = q ? null : await density(ctx, date, day.observations.count);

    syncDrawer(ctx, episodeId, date);
    lastWasList = !episodeId;
    ctx.onCleanup(() => { if (drawer && parse().name !== 'lifelog') { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); } });
    const want = query.get('new');
    if ((want === 'episode' || want === 'note') && !episodeId) {
        navigate(parts.length ? dayHref(date) : href('lifelog'), { replace: true });
        setTimeout(() => (want === 'episode' ? newEpisode(ctx, date) : addNote(ctx, date)), 0);
    }

    const actions = [
        button({ text: 'New episode', iconName: 'plus', 'data-key': 'new-episode', onClick: () => newEpisode(ctx, date) }),
        button({ text: 'Add note', variant: 'quiet', iconName: 'plus', 'data-key': 'add-note', onClick: () => addNote(ctx, date) }),
        manageMenu(ctx, date, sources),
    ];
    const dayView = () => {
        const episodes = day.episodes;
        return [
            h('h3', { class: 'lifelog-day', 'data-key': 'day-title', text: dayLabel(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + (date === today ? ' (today)' : '') }),
            episodes.length || day.observations.count ? strip(date, episodes, dens) : null,
            episodes.length
                ? h('ol', { class: 'lifelog-episodes', 'aria-label': 'Episodes' }, episodes.map((e) => episodeRow(e, date)))
                : emptyState({ title: day.observations.count ? 'No episodes for this day yet' : 'Nothing logged for this day', text: day.observations.count ? 'The raw lines are below. Add an episode to name what happened.' : 'Add a note or an episode, or pick another day.',
                    action: h('div', { class: 'row' }, button({ text: 'New episode', iconName: 'plus', size: 'small', onClick: () => newEpisode(ctx, date) }), button({ text: 'Add note', variant: 'quiet', size: 'small', onClick: () => addNote(ctx, date) })), iconName: 'calendar' }),
            summary(day),
            rawPanel(ctx, date, day),
        ];
    };
    return h('div', { class: 'view lifelog' },
        pageHeader({ lede: 'What you did and where, kept as raw lines from your sources and the episodes made from them. Nothing expires.', actions }),
        h('p', { class: 'note lifelog-privacy', text: 'Raw lines can describe people and places: handle with care.' }),
        dayBar(ctx, date, date === today),
        q ? await searchResults(ctx, q) : dayView(),
        sourcesPanel(sources),
        storageLine(stats));
}
