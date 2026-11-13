// Deadlines: dates you must not miss (documents, insurance, licences, subscriptions, memberships, bills, casual tasks).
//   #/deadlines                      Upcoming: active items, soonest first (?kind= ?q= ?overdue=1 narrow it)
//   #/deadlines?tab=all              every item, active, done and ended (?status=active|done|ended as well)
//   #/deadlines?tab=done             finished and ended items, with Reopen
//   #/deadlines/12                   that item's drawer: details and edit, history (compare, restore), done, end
//   #/deadlines?new=1                the Add deadline drawer (the palette uses it)
// The reference (a document or policy number) is masked until you press Show and appears only in the drawer and the
// forms, never in a table, a toast or the palette. Server text goes in as text. Nothing is ever deleted.
import {
    h, icon, button, plural, when, ago, emptyState, errorState, toast, confirmDialog, deleteDialog, openDrawer, chipNav, fact, hidden, actorName, dayLabel, pageHeader } from '../ui.js';
import { href, navigate, parse } from '../router.js';

const TABS = [['upcoming', 'Upcoming'], ['all', 'All'], ['done', 'Done']];
const KINDS = [['document', 'Document'], ['insurance', 'Insurance'], ['license', 'Licence'], ['subscription', 'Subscription'],
    ['membership', 'Membership'], ['bill', 'Bill'], ['task', 'Task'], ['other', 'Other']];
const KIND = Object.fromEntries(KINDS);
const MONEY_KINDS = ['subscription', 'membership', 'bill'];
// Start warning and urgent days a kind begins with (the same words the briefing uses).
const WINDOWS = { document: [90, 14], license: [60, 14], insurance: [30, 7], subscription: [7, 3], membership: [14, 3], bill: [7, 2], task: [7, 2], other: [7, 2] };
const STATUS = { active: 'Active', done: 'Done', ended: 'Ended' };
const CYCLES = [['weekly', 'Every week'], ['monthly', 'Every month'], ['quarterly', 'Every 3 months'], ['yearly', 'Every year']];
const PER = { weekly: 'per week', monthly: 'per month', quarterly: 'per quarter', yearly: 'per year' };
const PER_MONTH = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const REPEATS = [['none', 'Does not repeat'], ['yearly', 'Every year'], ['monthly', 'Every month'], ['every_n_months', 'Every N months']];
const FORM_FIELDS = ['title', 'kind', 'due_date', 'due_time', 'repeat_kind', 'repeat_n', 'lead_days', 'urgent_days', 'issuer', 'reference',
    'amount_cents', 'currency', 'cycle', 'auto_renew', 'cancel_by', 'trip_id', 'notes'];
const MONEY_FIELDS = ['amount_cents', 'currency', 'cycle', 'auto_renew', 'cancel_by'];
// The API names a problem by code, not by field: this is the field to focus.
const CODE_FIELD = { bad_title: 'title', bad_date: 'due_date', bad_time: 'due_time', bad_repeat_n: 'repeat_n', bad_repeat: 'repeat_kind', bad_window: 'lead_days',
    bad_currency: 'currency', bad_trip: 'trip_id', bad_amount_cents: 'amount_cents', bad_lead_days: 'lead_days', bad_urgent_days: 'urgent_days' };

const deadlineHref = (id) => href('deadlines', [String(id)]);
const day = (d) => dayLabel(d, { month: 'short', day: 'numeric', year: 'numeric' });
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const fieldError = (message, name) => Object.assign(new Error(message), { field: name });

let drawer = null;        // { id, handle, fromList } the item drawer that matches the URL
let side = null;          // the Add deadline drawer (not in the URL)
let lastWasList = false;  // the previous render was the plain list (closing the drawer can go back)
let focusAfter = null;    // a data-key to focus once the next render is on screen

/* ---------- small helpers ---------- */

function dueText(d) {
    if (d.status !== 'active') return d.status === 'done' && d.done_at ? `finished ${ago(d.done_at)}` : STATUS[d.status].toLowerCase();
    const n = d.days_left;
    if (n < 0) return `overdue by ${plural(-n, 'day')}`;
    if (n === 0) return 'due today';
    return `in ${plural(n, 'day')}`;
}

// Later, Soon, Urgent, Overdue: the word and the look follow the item's own windows.
function windowChip(d) {
    if (d.status !== 'active') return null;
    const [cls, word] = d.overdue ? ['overdue', 'Overdue'] : d.window === 'urgent' ? ['urgent', 'Urgent'] : d.window === 'attention' ? ['soon', 'Soon'] : ['later', 'Later'];
    return h('span', { class: `chip win-chip win-${cls}` }, h('span', { text: word }));
}

const kindChip = (kind) => h('span', { class: 'chip kind-chip' }, h('span', { text: KIND[kind] || kind }));
const statusChip = (status) => h('span', { class: `chip status-chip is-${status}` }, h('span', { text: STATUS[status] || status }));

function repeatText(d) {
    if (d.repeat_kind === 'yearly') return 'every year';
    if (d.repeat_kind === 'monthly') return 'every month';
    if (d.repeat_kind === 'every_n_months') return `every ${plural(d.repeat_n, 'month')}`;
    return '';
}

function money(cents, currency) {
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
    } catch (e) {
        return `${(cents / 100).toFixed(2)} ${currency}`;
    }
}

const amountText = (d) => (d.amount_cents != null && d.currency ? `${money(d.amount_cents, d.currency)}${d.cycle ? ` ${PER[d.cycle]}` : ''}` : '');

let fieldId = 0;
function field(label, input, help) {
    const id = input.id || `df-${++fieldId}`;
    input.id = id;
    const helpId = help ? `${id}-help` : null;
    if (helpId) input.setAttribute('aria-describedby', helpId);
    return h('div', { class: 'field' },
        h('label', { for: id, text: label }), input,
        help ? h('p', { class: 'help', id: helpId, text: help }) : null);
}

const textInput = (name, value, attrs = {}) => h('input', { type: 'text', name, autocomplete: 'off', spellcheck: 'false', value: value == null ? '' : String(value), 'data-key': `f-${name}`, ...attrs });

function windowSentence(lead, urgent) {
    if (!Number.isInteger(lead) || !Number.isInteger(urgent)) return 'Give both numbers as whole days.';
    if (urgent > lead) return 'Urgent cannot start earlier than the start warning.';
    const before = (n) => (n === 0 ? 'on the day' : `${plural(n, 'day')} before`);
    return `You will see it from ${before(lead)}, urgent from ${before(urgent)}.`;
}

/* ---------- tabs (a real tablist, as in Places and Flights) ---------- */

const tabHref = (id, extra = {}) => (id === 'upcoming' ? href('deadlines', [], extra) : href('deadlines', [], { tab: id, ...extra }));

function tabBar(current, counts) {
    const list = h('div', { class: 'vtabs', role: 'tablist', 'aria-label': 'Deadlines sections' });
    const tabs = TABS.map(([id, label]) => {
        const on = id === current;
        const target = tabHref(id);
        return h('button', {
            type: 'button', role: 'tab', class: 'vtab', id: `tab-${id}`, 'data-key': `tab:${id}`,
            'aria-selected': String(on), 'aria-controls': on ? `panel-${id}` : null, tabindex: on ? '0' : '-1', 'data-href': target,
            onclick: () => { if (!on) navigate(target); },
        }, h('span', { text: label }), h('span', { class: 'vcount', 'data-count': id, text: String(counts[id]) }));
    });
    list.append(...tabs);
    list.addEventListener('keydown', (event) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (j === undefined) return;
        event.preventDefault();
        const next = tabs[(j + tabs.length) % tabs.length];
        next.focus();
        if (next.getAttribute('aria-selected') !== 'true') navigate(next.dataset.href);
    });
    return list;
}

/* ---------- the reference field (masked until Show) ---------- */

function refField(value) {
    const input = textInput('reference', value, { type: 'password', maxlength: '120', autocomplete: 'off' });
    const label = h('span', { text: 'Show' });
    const toggle = h('button', {
        type: 'button', class: 'btn quiet small', 'data-key': 'ref-toggle', 'aria-pressed': 'false', 'aria-label': 'Show the reference',
        onclick: () => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            label.textContent = show ? 'Hide' : 'Show';
            toggle.setAttribute('aria-pressed', String(show));
            toggle.setAttribute('aria-label', show ? 'Hide the reference' : 'Show the reference');
        },
    }, icon('keys'), label);
    const id = `df-ref-${++fieldId}`;
    input.id = id;
    return h('div', { class: 'field' },
        h('label', { for: id, text: 'Reference' }),
        h('div', { class: 'ref-row' }, input, toggle),
        h('p', { class: 'help', text: 'A policy, licence or account number. Hidden by default. Only you and keys with the deadlines read scope can see it.' }));
}

/* ---------- the deadline form (Add, and edit in the drawer) ---------- */

// The values the form starts from: an item, or nothing (a new one).
function startValues(d) {
    if (!d) return { title: '', kind: 'document', due_date: '', due_time: '', repeat_kind: 'none', repeat_n: '', lead_days: '90', urgent_days: '14', issuer: '', reference: '', amount: '', currency: 'USD', cycle: '', auto_renew: '', cancel_by: '', trip_id: '', notes: '' };
    return {
        title: d.title, kind: d.kind, due_date: d.due_date, due_time: d.due_time || '', repeat_kind: d.repeat_kind, repeat_n: d.repeat_n == null ? '' : String(d.repeat_n),
        lead_days: String(d.lead_days), urgent_days: String(d.urgent_days), issuer: d.issuer || '', reference: d.reference || '',
        amount: d.amount_cents == null ? '' : (d.amount_cents / 100).toFixed(2), currency: d.currency || (MONEY_KINDS.includes(d.kind) ? 'USD' : ''), cycle: d.cycle || '',
        auto_renew: d.auto_renew == null ? '' : d.auto_renew ? 'yes' : 'no', cancel_by: d.cancel_by || '', trip_id: d.trip_id == null ? '' : String(d.trip_id), notes: d.notes || '',
    };
}

// What the form would send, every field normalised (null = empty). Fields that do not belong to the chosen kind or
// repeat are null, so changing the kind clears what no longer applies.
function clean(v) {
    const t = (s) => (s == null || String(s).trim() === '' ? null : String(s).trim());
    const money = MONEY_KINDS.includes(v.kind);
    const whole = (s) => (/^\d+$/.test(String(s).trim()) ? Number(s) : NaN);
    const amountRaw = money ? t(v.amount) : null;
    let cents = null;
    if (amountRaw != null) {
        if (!/^\d+([.,]\d{1,2})?$/.test(amountRaw)) cents = NaN;
        else cents = Math.round(Number(amountRaw.replace(',', '.')) * 100);
    }
    return {
        title: t(v.title),
        kind: v.kind,
        due_date: t(v.due_date),
        due_time: t(v.due_time),
        repeat_kind: v.repeat_kind || 'none',
        repeat_n: v.repeat_kind === 'every_n_months' ? (t(v.repeat_n) == null ? null : whole(v.repeat_n)) : null,
        lead_days: t(v.lead_days) == null ? null : whole(v.lead_days),
        urgent_days: t(v.urgent_days) == null ? null : whole(v.urgent_days),
        issuer: t(v.issuer),
        reference: t(v.reference),
        amount_cents: cents,
        currency: money ? (t(v.currency) && t(v.currency).toUpperCase()) : null,
        cycle: money ? t(v.cycle) : null,
        auto_renew: money ? (v.auto_renew === 'yes' ? true : v.auto_renew === 'no' ? false : null) : null,
        cancel_by: money ? t(v.cancel_by) : null,
        trip_id: t(v.trip_id) == null ? null : whole(v.trip_id),
        notes: t(v.notes),
    };
}

function deadlineForm(ctx, { values, mode, submit, onSave, onCancel, onDirty }) {
    const base = clean(values);
    const f = {};
    const tx = (name, label, attrs, help) => { f[name] = textInput(name, values[name], attrs); return field(label, f[name], help); };
    const sel = (name, options, value) => {
        const el = h('select', { name, 'data-key': `f-${name}` }, options.map(([k, label]) => h('option', { value: k, text: label })));
        el.value = value;
        f[name] = el;
        return el;
    };

    const kind = sel('kind', KINDS, values.kind);
    const repeat = sel('repeat_kind', REPEATS, values.repeat_kind);
    const cycle = sel('cycle', [['', 'Not set'], ...CYCLES], values.cycle);
    const autoRenew = sel('auto_renew', [['', 'Not set'], ['yes', 'Yes, it renews by itself'], ['no', 'No, I have to renew it']], values.auto_renew);
    const notes = h('textarea', { name: 'notes', rows: '3', maxlength: '2000', class: 'plain', 'data-key': 'f-notes' });
    notes.value = values.notes || '';
    f.notes = notes;
    const ref = refField(values.reference);
    f.reference = ref.querySelector('input');

    const dueField = field('Due date', textInput('due_date', values.due_date, { type: 'date' }), 'The day it must be done by, or renews.');
    f.due_date = dueField.querySelector('input');
    const timeField = field('Due time (optional)', textInput('due_time', values.due_time, { type: 'time' }));
    f.due_time = timeField.querySelector('input');
    const nField = field('Months between', textInput('repeat_n', values.repeat_n, { type: 'number', min: '1', max: '600', inputmode: 'numeric' }), 'For Every N months: 3 means every quarter.');
    f.repeat_n = nField.querySelector('input');
    const lead = textInput('lead_days', values.lead_days, { type: 'number', min: '0', max: '730', inputmode: 'numeric' });
    const urgent = textInput('urgent_days', values.urgent_days, { type: 'number', min: '0', max: '730', inputmode: 'numeric' });
    f.lead_days = lead;
    f.urgent_days = urgent;
    const sentence = h('p', { class: 'window-sentence', 'data-key': 'window-sentence', 'aria-live': 'polite' });

    const moneyGroup = h('fieldset', { class: 'flight-group money-group', 'data-key': 'money' }, h('legend', { text: 'Money' }),
        h('div', { class: 'group-grid' },
            tx('amount', 'Amount', { inputmode: 'decimal', placeholder: '9.99' }, 'What it costs each time. A planned amount, not a payment.'),
            tx('currency', 'Currency', { maxlength: '3', autocapitalize: 'characters', class: 'iata' }, 'Three letters, like USD.'),
            field('Billing cycle', cycle),
            field('Renews by itself', autoRenew),
            tx('cancel_by', 'Cancel by', { type: 'date' }, 'The last day to cancel before it renews.')));

    // Window numbers follow the kind until the person types their own.
    let touched = Boolean(values.touched);
    const defaultsOf = (k) => WINDOWS[k] || WINDOWS.other;
    const paint = () => {
        const money = MONEY_KINDS.includes(kind.value);
        moneyGroup.hidden = !money;
        nField.hidden = repeat.value !== 'every_n_months';
        sentence.textContent = windowSentence(/^\d+$/.test(lead.value.trim()) ? Number(lead.value) : NaN, /^\d+$/.test(urgent.value.trim()) ? Number(urgent.value) : NaN);
        sentence.classList.toggle('is-bad', /cannot|whole/.test(sentence.textContent));
    };
    const [dl, du] = defaultsOf(values.kind);
    if (mode === 'edit' && (Number(values.lead_days) !== dl || Number(values.urgent_days) !== du)) touched = true;
    const markTouched = () => { touched = true; };
    lead.addEventListener('input', markTouched);
    urgent.addEventListener('input', markTouched);
    kind.addEventListener('change', () => {
        if (!touched) {
            const [a, b] = defaultsOf(kind.value);
            lead.value = String(a);
            urgent.value = String(b);
        }
        if (MONEY_KINDS.includes(kind.value) && !f.currency.value.trim()) f.currency.value = 'USD';
        paint();
    });
    repeat.addEventListener('change', () => { paint(); if (!nField.hidden && !f.repeat_n.value) f.repeat_n.focus(); });
    lead.addEventListener('input', paint);
    urgent.addEventListener('input', paint);

    const error = h('p', { class: 'error', role: 'alert' });
    const save = button({ text: submit, type: 'submit', size: 'small', 'data-key': 'df-save' });

    const current = () => ({
        title: f.title.value, kind: kind.value, due_date: f.due_date.value, due_time: f.due_time.value, repeat_kind: repeat.value, repeat_n: f.repeat_n.value,
        lead_days: lead.value, urgent_days: urgent.value, issuer: f.issuer.value, reference: f.reference.value, amount: f.amount.value, currency: f.currency.value,
        cycle: cycle.value, auto_renew: autoRenew.value, cancel_by: f.cancel_by.value, trip_id: f.trip_id.value, notes: notes.value,
    });
    const dirty = () => {
        const now = clean(current());
        return FORM_FIELDS.some((k) => !Object.is(now[k], base[k]));
    };

    const group = (title, ...kids) => h('fieldset', { class: 'flight-group' }, h('legend', { text: title }), h('div', { class: 'group-grid' }, kids));
    const form = h('form', {
        class: 'place-form flight-form deadline-form',
        novalidate: true,
        oninput: () => onDirty && onDirty(),
        onchange: () => onDirty && onDirty(),
        onsubmit: async (event) => {
            event.preventDefault();
            error.replaceChildren();
            save.disabled = true;
            try {
                const now = clean(current());
                if (!now.title) throw fieldError('Give it a title.', 'title');
                if (!now.due_date) throw fieldError('Give the due date.', 'due_date');
                if (now.repeat_kind === 'every_n_months' && !(Number.isInteger(now.repeat_n) && now.repeat_n >= 1 && now.repeat_n <= 600)) throw fieldError('Give the number of months between repeats, from 1 to 600.', 'repeat_n');
                if (!Number.isInteger(now.lead_days) || now.lead_days > 730) throw fieldError('Start warning is a whole number of days, 0 to 730.', 'lead_days');
                if (!Number.isInteger(now.urgent_days) || now.urgent_days > 730) throw fieldError('Urgent is a whole number of days, 0 to 730.', 'urgent_days');
                if (now.urgent_days > now.lead_days) throw fieldError('Urgent cannot start earlier than the start warning.', 'urgent_days');
                if (Number.isNaN(now.amount_cents)) throw fieldError('The amount is a number like 9.99.', 'amount');
                if (now.amount_cents != null && !now.currency) throw fieldError('Give the currency, for example USD.', 'currency');
                if (now.trip_id != null && !(Number.isInteger(now.trip_id) && now.trip_id > 0)) throw fieldError('The trip id is a positive whole number.', 'trip_id');
                let body;
                if (mode === 'create') {
                    body = Object.fromEntries(FORM_FIELDS.filter((k) => now[k] != null && !(k === 'repeat_kind' && now[k] === 'none')).map((k) => [k, now[k]]));
                } else {
                    body = Object.fromEntries(FORM_FIELDS.filter((k) => !Object.is(now[k], base[k])).map((k) => [k, now[k]]));
                }
                await onSave(body, { now });
            } catch (err) {
                error.textContent = err.message;
                const name = err.field || CODE_FIELD[err.code];
                const bad = name && form.querySelector(`[name="${name === 'amount_cents' ? 'amount' : name}"]`);
                if (bad && !bad.closest('[hidden]')) bad.focus();
                save.disabled = false;
            }
        },
    },
    group('What',
        h('div', { class: 'wide-field' }, tx('title', 'Title', { maxlength: '120', placeholder: 'Passport renewal' })),
        field('Kind', kind, 'Decides which fields show and how early the warning starts.'),
        tx('issuer', 'Issuer (optional)', { maxlength: '120' }, 'Who it is with, for example the DMV or your insurer.')),
    group('When',
        dueField, timeField,
        field('Repeats', repeat), nField),
    group('Warnings',
        field('Start warning (days before)', lead, 'The briefing mentions it from this far ahead.'),
        field('Urgent (days before)', urgent, 'It turns urgent this far ahead.'),
        h('div', { class: 'wide-field' }, sentence)),
    moneyGroup,
    group('More',
        ref,
        tx('trip_id', 'Trip id (flights trips)', { type: 'number', min: '1', inputmode: 'numeric' }, 'Optional. The number of a trip in Flights.'),
        h('div', { class: 'wide-field' }, field('Notes', notes))),
    error,
    h('div', { class: 'row' }, save, onCancel ? button({ text: 'Cancel', variant: 'quiet', size: 'small', onClick: onCancel }) : null));
    paint();
    return { el: form, dirty, save };
}

/* ---------- compare two revisions ---------- */

function snapshotLines(d) {
    return [
        `Title: ${d.title}`,
        `Kind: ${KIND[d.kind] || d.kind}`,
        `Status: ${STATUS[d.status] || d.status}`,
        `Due: ${d.due_date}${d.due_time ? ` ${d.due_time}` : ''}`,
        `Repeats: ${repeatText(d) || 'no'}`,
        `Start warning: ${plural(d.lead_days, 'day')} before`,
        `Urgent: ${plural(d.urgent_days, 'day')} before`,
        `Issuer: ${d.issuer || 'none'}`,
        `Reference: ${d.reference ? 'set' : 'none'}`,
        `Amount: ${amountText(d) || 'none'}`,
        `Renews by itself: ${d.auto_renew == null ? 'not set' : d.auto_renew ? 'yes' : 'no'}`,
        `Cancel by: ${d.cancel_by || 'none'}`,
        `Trip id: ${d.trip_id == null ? 'none' : d.trip_id}`,
        `Notes: ${d.notes || 'none'}`,
    ];
}

function diffLines(older, newer) {
    const a = snapshotLines(older);
    const b = snapshotLines(newer);
    if (older.reference && newer.reference && older.reference !== newer.reference) {
        a[a.indexOf('Reference: set')] += ' (older value)';
        b[b.indexOf('Reference: set')] += ' (changed)';
    }
    return [...a.filter((l) => !b.includes(l)).map((l) => ['del', l]), ...b.map((l) => [a.includes(l) ? 'same' : 'add', l])];
}

/* ---------- actions shared by the list and the drawer ---------- */

// Done: a repeating item moves to its next date and stays active; a one-off moves to the Done tab.
async function markDone(ctx, d) {
    try {
        const res = await ctx.api(`/deadlines/${d.id}/done`, { method: 'POST' });
        toast(res.status === 'rolled' ? `${d.title} done. Next due ${day(res.next_due)}` : `${d.title} done`);
        return true;
    } catch (err) {
        if (err.status !== 401) toast(`Could not mark it done. ${err.message}`, { kind: 'bad' });
        return false;
    }
}

async function reopen(ctx, d) {
    try {
        await ctx.api(`/deadlines/${d.id}`, { method: 'PATCH', body: { status: 'active' } });
        toast(`${d.title} is active again`);
        return true;
    } catch (err) {
        if (err.status !== 401) toast(`Could not reopen it. ${err.message}`, { kind: 'bad' });
        return false;
    }
}

async function endIt(ctx, d) {
    const ok = await confirmDialog({
        title: `End ${d.title}?`,
        body: ['It stays in your list and its history, marked Ended, and no more reminders come.', 'You can reopen it at any time.'],
        confirm: 'End it',
        danger: true,
    });
    if (!ok) return false;
    try {
        await ctx.api(`/deadlines/${d.id}/end`, { method: 'POST' });
        toast(`${d.title} ended`);
        return true;
    } catch (err) {
        if (err.status !== 401) toast(`Could not end it. ${err.message}`, { kind: 'bad' });
        return false;
    }
}

// Permanent delete: the dialog says what goes and offers a backup first. Resolves the answer, or null when cancelled.
async function deleteIt(ctx, d) {
    let pre;
    try { pre = await ctx.api(`/deadlines/${d.id}/delete-preview`); } catch (err) { if (err.status !== 401) toast(`Could not check what a delete would take. ${err.message}`, { kind: 'bad' }); return null; }
    const out = await deleteDialog({
        title: `Delete ${pre.label}?`,
        goes: [`The deadline ${pre.label}`, plural(pre.counts.revisions, 'revision'), 'Any reminder for it in the briefing and on Today'],
        stays: ['Anything outside this hub: the bill, the policy or the subscription itself'],
        run: (o) => ctx.api(`/deadlines/${d.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
    });
    if (out) toast(`Deleted ${out.label}`);
    return out;
}

/* ---------- the deadline drawer ---------- */

function closeDrawerTo(fromList) {
    if (fromList && history.length > 1) history.back();
    else navigate(href('deadlines'), { replace: true });
}

function deadlineDrawer(ctx, id, fromList, mark) {
    let item = null;
    let form = null;

    const handle = openDrawer({
        title: 'Deadline',
        subtitle: 'Loading…',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard your changes?', body: 'The deadline keeps what was last saved.', confirm: 'Discard', danger: true }),
        onClose: () => {
            const mine = drawer && drawer.handle === handle;
            if (mine) { drawer = null; closeDrawerTo(fromList); }
        },
        returnFocus: () => document.querySelector(`[data-key="deadline:${id}"]`) || document.querySelector('[data-key="new-deadline"]'),
    });

    const focusKey = (key) => {
        const el = key && handle.body.querySelector(`[data-key="${key}"]`);
        if (el) el.focus();
        else handle.el.querySelector('.drawer-head button').focus();
    };

    async function changed(key) {
        await load(key);
        ctx.rerender();
    }

    async function load(key) {
        const top = handle.body.scrollTop;
        try {
            item = await ctx.api(`/deadlines/${id}`);
        } catch (err) {
            if (err.status === 401) return;
            if (err.status === 404) {
                toast('That deadline is gone or never existed.', { kind: 'info' });
                drawer = null;
                handle.close(true);
                closeDrawerTo(fromList);
                return;
            }
            handle.setTitle('Deadline', '');
            handle.setContent(errorState({ err, what: 'This deadline', retry: () => load(key) }));
            return;
        }
        handle.setTitle(item.title, `${item.status === 'active' ? `Due ${day(item.due_date)}, ${dueText(item)}` : STATUS[item.status]}, revision ${item.rev}`);
        handle.setContent(content());
        handle.body.scrollTop = top;
        if (key) focusKey(key);
    }

    function details() {
        form = deadlineForm(ctx, {
            values: startValues(item),
            mode: 'edit',
            submit: 'Save changes',
            onSave: async (body) => {
                if (!Object.keys(body).length) { toast('Nothing changed', { kind: 'info' }); form.save.disabled = false; return; }
                const res = await ctx.api(`/deadlines/${item.id}`, { method: 'PATCH', body });
                toast(res.status === 'unchanged' ? 'Nothing changed' : 'Changes saved', { kind: res.status === 'unchanged' ? 'info' : 'good' });
                form = null;
                await changed('df-save');
            },
        });
        return form.el;
    }

    async function restore(rev) {
        const ok = await confirmDialog({
            title: `Restore revision ${rev}?`,
            body: `The fields of revision ${rev} become current, as a new revision. What you see now stays in the history.`,
            confirm: 'Restore',
        });
        if (!ok) return;
        try {
            const res = await ctx.api(`/deadlines/${item.id}/restore`, { method: 'POST', body: { rev } });
            toast(res.status === 'unchanged' ? 'That revision is the same as the current one' : `Revision ${rev} restored`, { kind: res.status === 'unchanged' ? 'info' : 'good' });
            form = null;
            changed('history');
        } catch (err) {
            toast(`Could not restore. ${err.message}`, { kind: 'bad' });
        }
    }

    async function compare(rev) {
        handle.setContent(h('p', { class: 'muted', text: 'Loading…' }));
        try {
            const older = await ctx.api(`/deadlines/${item.id}?rev=${rev}`);
            const parts = diffLines(older, item);
            const changedN = parts.filter(([k]) => k !== 'same').length;
            const back = button({ text: 'Back to the deadline', variant: 'ghost', size: 'small', iconName: 'prev', onClick: () => load('history') });
            handle.setTitle(item.title, `Revision ${rev} and the current one`);
            handle.setContent(
                h('div', { class: 'compare-top' }, back, button({ text: `Restore revision ${rev}`, variant: 'quiet', size: 'small', onClick: () => restore(rev) })),
                h('p', { class: 'note', text: changedN ? `${plural(changedN, 'line')} differ. Lines only in revision ${rev} are struck through; lines added since are marked with a plus.` : 'Revision and current are the same.' }),
                h('div', { class: 'diff diff-plain' }, parts.map(([k, text]) => h('p', { class: k }, k === 'add' ? hidden('Added: ') : k === 'del' ? hidden('Removed: ') : null, text))));
            back.focus();
        } catch (err) {
            if (err.status !== 401) handle.setContent(errorState({ err, what: 'That revision', retry: () => compare(rev) }));
        }
    }

    function content() {
        const act = (fn, key) => async () => { if (form && form.dirty() && !(await confirmDialog({ title: 'Discard your changes?', body: 'This reloads the deadline. What you typed and did not save is lost.', confirm: 'Continue and discard', danger: true }))) return; if (await fn()) { form = null; changed(key); } };
        const active = item.status === 'active';
        const buttons = active
            ? [button({ text: item.repeat_kind === 'none' ? 'Mark done' : 'Done, roll to next date', iconName: 'check', 'data-key': 'drawer-done', onClick: act(() => markDone(ctx, item), 'drawer-done') }),
                button({ text: 'End this deadline', variant: 'danger', iconName: 'close', 'data-key': 'drawer-end', onClick: act(() => endIt(ctx, item), 'history') })]
            : [button({ text: 'Reopen', iconName: 'retry', 'data-key': 'drawer-reopen', onClick: act(() => reopen(ctx, item), 'history') })];
        buttons.push(button({ text: 'Delete permanently', variant: 'quiet-danger', iconName: 'trash', 'data-key': 'drawer-delete', onClick: async () => {
            if (!(await deleteIt(ctx, item))) return;
            form = null;
            drawer = null;
            handle.close(true);
            closeDrawerTo(fromList);
            ctx.rerender();
        } }));
        return [
            h('section', { class: 'drawer-section', 'aria-labelledby': 'dd-state' },
                h('h3', { id: 'dd-state', text: 'Status' }),
                h('p', { class: 'deadline-state' }, statusChip(item.status), ' ', windowChip(item), ' ', h('span', { class: 'muted', text: active ? `${day(item.due_date)}, ${dueText(item)}` : (item.done_at ? `Last done ${when(item.done_at)}` : '') })),
                h('div', { class: 'row' }, buttons)),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'dd-details' },
                h('h3', { id: 'dd-details', text: 'Details' }),
                details(),
                h('dl', { class: 'facts' },
                    fact('Added', when(item.created_at)),
                    item.done_at ? fact('Last done', when(item.done_at)) : null,
                    fact('Last changed', `${ago(item.updated_at)} by ${actorName(item.updated_by)}`))),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'dd-history' },
                h('h3', { id: 'dd-history', tabindex: '-1', 'data-key': 'history', text: `History, ${plural(item.history.length, 'revision')}` }),
                h('p', { class: 'note', text: 'Every change is kept. Restoring adds a new revision, so nothing is lost.' }),
                h('ol', { class: 'rev-list', reversed: true }, item.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
                    h('div', { class: 'rev-main' },
                        h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                        h('p', { class: 'rev-what', text: `${{ create: 'Created', edit: 'Edited', restore: 'Restored', done: 'Marked done', end: 'Ended' }[r.source] || cap(r.source)} by ${actorName(r.actor)}${r.note ? `: ${r.note}` : ''}.` }),
                        h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
                    r.current ? null : h('div', { class: 'rev-actions' },
                        button({ text: 'Compare', variant: 'quiet', size: 'small', label: `Compare revision ${r.rev} with the current one`, onClick: () => compare(r.rev) }),
                        button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) })))))),
            h('section', { class: 'drawer-section danger-zone' },
                h('p', { class: 'note', text: 'Ending a deadline keeps it and its history but stops the reminders. Delete permanently removes it and its history for good.' })),
        ];
    }

    mark.handle = handle;
    load();
}

// Opens, keeps or closes the drawer so it matches the URL.
function syncDrawer(ctx) {
    const raw = ctx.route.parts[0];
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (raw && !id) { navigate(href('deadlines'), { replace: true }); return; }
    if ((drawer ? drawer.id : null) === id) return;
    if (drawer) { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
    if (!id) return;
    // Claim the id at once: a second render before the timer fires must not open a second drawer.
    const mark = { id, handle: null, fromList: lastWasList };
    drawer = mark;
    setTimeout(() => { if (drawer === mark) deadlineDrawer(ctx, id, mark.fromList, mark); }, 0);
}

/* ---------- Add deadline ---------- */

function closeSide(force = true) {
    if (side) { const s = side; side = null; s.close(force); }
}

function addDeadline(ctx) {
    if (side) return;
    let form = null;
    const handle = openDrawer({
        title: 'Add a deadline',
        subtitle: 'A date you must not miss. The kind picks the fields and how early the warning starts.',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard this deadline?', body: 'Nothing has been saved yet.', confirm: 'Discard', danger: true }),
        onClose: () => { if (side === handle) side = null; },
        returnFocus: () => document.querySelector('[data-key="new-deadline"]') || document.querySelector('[data-key="empty-new"]'),
    });
    side = handle;
    form = deadlineForm(ctx, {
        values: startValues(null),
        mode: 'create',
        submit: 'Add deadline',
        onCancel: () => handle.close(),
        onSave: async (body) => {
            const res = await ctx.api('/deadlines', { method: 'POST', body });
            toast(`${res.title} added`);
            form = null;
            side = null;
            handle.close(true);
            focusAfter = 'tab:upcoming';
            ctx.rerender();
        },
    });
    handle.setContent(form.el);
    const first = handle.body.querySelector('input');
    if (first) first.focus();
}

/* ---------- the lists ---------- */

function actionsFor(ctx, d) {
    const after = () => { focusAfter = `tab:${parse().query.get('tab') || 'upcoming'}`; ctx.rerender(); };
    if (d.status === 'active') {
        return [
            button({ text: 'Done', variant: 'quiet', size: 'small', iconName: 'check', label: `Mark ${d.title} done`, 'data-key': `done:${d.id}`, onClick: async () => { if (await markDone(ctx, d)) after(); } }),
            h('a', { class: 'btn quiet small', href: deadlineHref(d.id), 'aria-label': `Edit ${d.title}`, text: 'Edit' }),
        ];
    }
    return [
        button({ text: 'Reopen', variant: 'quiet', size: 'small', iconName: 'retry', label: `Reopen ${d.title}`, 'data-key': `reopen:${d.id}`, onClick: async () => { if (await reopen(ctx, d)) after(); } }),
        h('a', { class: 'btn quiet small', href: deadlineHref(d.id), 'aria-label': `Open ${d.title}`, text: 'Open' }),
        button({ text: 'Delete', variant: 'quiet-danger', size: 'small', iconName: 'trash', label: `Delete ${d.title} permanently`, 'data-key': `delete:${d.id}`, onClick: async () => { if (await deleteIt(ctx, d)) after(); } }),
    ];
}

function deadlineRow(ctx, d, { showStatus }) {
    const link = h('a', { class: 'row-link', href: deadlineHref(d.id), 'data-key': `deadline:${d.id}` }, d.title);
    const active = d.status === 'active';
    return h('tr', { class: active && d.overdue ? 'is-overdue' : '', 'data-id': String(d.id), onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('td', { class: 'cell-main' }, link, d.issuer ? h('span', { class: 'muted row-issuer', text: d.issuer }) : null),
        h('td', { 'data-label': 'Kind' }, kindChip(d.kind)),
        h('td', { 'data-label': 'Due' }, active ? [h('strong', { text: day(d.due_date) }), d.due_time ? h('span', { class: 'muted', text: ` ${d.due_time}` }) : null, h('span', { class: 'muted due-rel', text: ` ${dueText(d)}` })]
            : [h('span', { text: day(d.due_date) }), h('span', { class: 'muted due-rel', text: ` ${dueText(d)}` })]),
        h('td', { 'data-label': showStatus ? 'Status' : 'When' }, showStatus ? [statusChip(d.status), ' ', windowChip(d)] : windowChip(d) || statusChip(d.status)),
        h('td', { 'data-label': 'Repeats', class: repeatText(d) ? '' : 'is-empty', text: repeatText(d) }),
        h('td', { 'data-label': 'Amount', class: amountText(d) ? 'num' : 'num is-empty', text: amountText(d) }),
        h('td', { class: 'cell-side' }, h('div', { class: 'row-actions' }, actionsFor(ctx, d))));
}

function table(ctx, rows, opts) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'stack deadlines-table' },
        h('thead', {}, h('tr', {},
            h('th', { scope: 'col', text: 'Deadline' }),
            h('th', { scope: 'col', text: 'Kind' }),
            h('th', { scope: 'col', text: 'Due' }),
            h('th', { scope: 'col', text: opts.showStatus ? 'Status' : 'When' }),
            h('th', { scope: 'col', text: 'Repeats' }),
            h('th', { scope: 'col', class: 'num', text: 'Amount' }),
            h('th', { scope: 'col' }, hidden('Actions')))),
        h('tbody', {}, rows.map((d) => deadlineRow(ctx, d, opts)))));
}

// Planned amounts per month from amount and cycle, one line per currency, and the next three renewals.
// This is the schedule, not a record of payments.
function subscriptionsStrip(active) {
    const priced = active.filter((d) => MONEY_KINDS.includes(d.kind) && d.amount_cents != null && d.currency);
    if (!priced.length) return null;
    const perMonth = new Map();
    let loose = 0;
    for (const d of priced) {
        if (!d.cycle) { loose += 1; continue; }
        perMonth.set(d.currency, (perMonth.get(d.currency) || 0) + d.amount_cents * PER_MONTH[d.cycle]);
    }
    const next = priced.slice().sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id - b.id)).slice(0, 3);
    return h('section', { class: 'panel subs-strip', 'aria-labelledby': 'subs-title', 'data-key': 'subs' },
        h('h2', { id: 'subs-title', class: 'section-title', text: 'Subscriptions' }),
        h('ul', { class: 'subs-totals' }, [...perMonth.entries()].map(([cur, cents]) => h('li', { 'data-currency': cur }, h('strong', { text: `${money_(cents, cur)}` }), ' per month'))),
        h('ul', { class: 'subs-next' }, next.map((d) => h('li', {}, h('a', { class: 'link', href: deadlineHref(d.id), text: d.title }), h('span', { class: 'muted', text: ` ${day(d.due_date)}${amountText(d) ? `, ${amountText(d)}` : ''}` })))),
        h('p', { class: 'note', text: `Planned amounts, not payments.${loose ? ` ${plural(loose, 'item')} without a billing cycle ${loose === 1 ? 'is' : 'are'} left out of the total.` : ''}` }));
}
const money_ = (cents, cur) => money(Math.round(cents), cur);

function filterBar(ctx, f, base, { kindsOf, statusFilter }) {
    const query = (patch) => ({ ...base, kind: f.kind, q: f.q, overdue: f.overdue ? '1' : '', status: f.status, ...patch });
    const items = [{ id: '', label: 'All kinds', href: href('deadlines', [], query({ kind: '' })) },
        ...KINDS.filter(([k]) => kindsOf.has(k)).map(([k, label]) => ({ id: k, label, href: href('deadlines', [], query({ kind: k })) }))];
    const search = h('input', { type: 'search', name: 'q', value: f.q, placeholder: 'Search deadlines', 'aria-label': 'Search deadlines by title, issuer or kind', 'data-key': 'd-search', enterkeyhint: 'search' });
    const searchForm = h('form', { class: 'search-form', role: 'search', onsubmit: (event) => { event.preventDefault(); navigate(href('deadlines', [], query({ q: search.value.trim() }))); } },
        icon('search', 'search-icon'), search,
        f.q ? h('a', { class: 'btn ghost small', href: href('deadlines', [], query({ q: '' })), text: 'Clear' }) : null);
    const overdue = base.tab === 'upcoming' ? h('a', { class: 'chip-link', 'data-key': 'only-overdue', href: href('deadlines', [], query({ overdue: f.overdue ? '' : '1' })), 'aria-current': f.overdue ? 'true' : null },
        f.overdue ? icon('check') : null, h('span', { text: 'Show overdue only' })) : null;
    return h('div', { class: 'toolbar filter-bar' },
        h('div', { class: 'filters' },
            items.length > 2 ? chipNav({ label: 'Filter by kind', items, current: f.kind }) : null,
            overdue,
            statusFilter ? chipNav({ label: 'Filter by status', current: f.status, items: [{ id: '', label: 'Any status', href: href('deadlines', [], query({ status: '' })) },
                ...Object.entries(STATUS).map(([k, label]) => ({ id: k, label, href: href('deadlines', [], query({ status: k })) }))] }) : null),
        searchForm);
}

function listTab(ctx, tab, data) {
    const q = ctx.route.query;
    const f = { kind: KIND[q.get('kind')] ? q.get('kind') : '', q: (q.get('q') || '').trim(), overdue: q.get('overdue') === '1' && tab === 'upcoming', status: STATUS[q.get('status')] && tab === 'all' ? q.get('status') : '' };
    const all = data.rows;
    const needle = f.q.toLowerCase();
    const shown = all.filter((d) => (!f.kind || d.kind === f.kind) && (!f.overdue || d.overdue) && (!f.status || d.status === f.status)
        && (!needle || [d.title, d.issuer, KIND[d.kind], d.kind].some((t) => t && String(t).toLowerCase().includes(needle))));
    const filtered = Boolean(f.kind || f.q || f.overdue || f.status);
    const showStatus = tab !== 'upcoming';

    const kindsOf = new Set(all.map((d) => d.kind));
    const addButton = button({ text: 'Add deadline', size: 'small', iconName: 'plus', 'data-key': 'empty-new', onClick: () => addDeadline(ctx) });
    let body;
    if (!all.length) {
        body = tab === 'done'
            ? emptyState({ title: 'Nothing finished yet.', text: 'Deadlines you finish or end land here, and can be reopened.', iconName: 'check' })
            : emptyState({ title: tab === 'all' ? 'No deadlines yet.' : 'Nothing is coming up.', text: 'Add the dates you must not miss: a passport, a policy, a subscription, a bill.', iconName: 'deadlines', action: addButton });
    } else if (!shown.length) {
        body = emptyState({
            title: 'No deadline matches.',
            text: 'Try other words or clear a filter.',
            iconName: 'search',
            action: h('a', { class: 'btn quiet small', href: tabHref(tab), text: 'Show every deadline' }),
        });
    } else body = table(ctx, shown, { showStatus });

    const headTitle = { upcoming: 'Active deadlines', all: 'Every deadline', done: 'Done and ended' }[tab];
    return h('div', { class: 'tab-panel', id: `panel-${tab}`, role: 'tabpanel', 'aria-labelledby': `tab-${tab}` },
        tab === 'upcoming' ? subscriptionsStrip(data.activeAll) : null,
        all.length ? filterBar(ctx, f, { tab }, { kindsOf, statusFilter: tab === 'all' }) : null,
        h('section', { 'aria-labelledby': all.length ? 'd-count' : null, 'aria-label': all.length ? null : headTitle, class: 'deadlines-list' },
            all.length ? h('h2', { id: 'd-count', class: 'section-title', text: filtered ? `${shown.length} of ${plural(all.length, 'deadline')}` : plural(all.length, 'deadline') }) : null,
            data.more ? h('p', { class: 'note', text: `Showing the first ${all.length} of ${data.total.toLocaleString()} deadlines.` }) : null,
            body));
}

export async function render(ctx) {
    const q = ctx.route.query;
    const idRaw = ctx.route.parts[0];
    const asked = q.get('tab');
    const tab = TABS.some(([id]) => id === asked) ? asked : 'upcoming';

    // Active items always load (the tab counts, the strip and the badge need them); done and ended ones are cheap to count.
    const [active, done, ended] = await Promise.all([
        ctx.api('/deadlines?status=active&limit=200'),
        ctx.api(`/deadlines?status=done&limit=${tab === 'upcoming' ? 1 : 200}`),
        ctx.api(`/deadlines?status=ended&limit=${tab === 'upcoming' ? 1 : 200}`),
    ]);
    const counts = { upcoming: active.total, all: active.total + done.total + ended.total, done: done.total + ended.total };
    const finished = [...done.deadlines, ...ended.deadlines].sort((a, b) => ((b.done_at || b.updated_at) < (a.done_at || a.updated_at) ? -1 : 1));
    const data = tab === 'upcoming'
        ? { rows: active.deadlines, activeAll: active.deadlines, total: active.total, more: active.total > active.deadlines.length }
        : tab === 'done'
            ? { rows: finished, activeAll: [], total: counts.done, more: counts.done > finished.length }
            : { rows: [...active.deadlines, ...finished].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id - b.id)), activeAll: [], total: counts.all, more: counts.all > active.deadlines.length + finished.length };

    syncDrawer(ctx);
    lastWasList = !idRaw;
    ctx.onCleanup(() => {
        if (drawer && parse().name !== 'deadlines') { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
        if (side && parse().name !== 'deadlines') closeSide();
    });
    if (q.get('new') === '1' && !idRaw) {
        navigate(tabHref(tab), { replace: true });
        setTimeout(() => addDeadline(ctx), 0);
    }
    if (focusAfter) {
        const key = focusAfter;
        focusAfter = null;
        setTimeout(() => {
            const el = document.querySelector(`[data-key="${key}"]`) || document.querySelector(`[data-key="tab:${tab}"]`);
            if (el) el.focus();
        }, 0);
    }

    const urgentN = active.deadlines.filter((d) => d.window === 'urgent').length;
    const add = button({ text: 'Add deadline', iconName: 'plus', 'data-key': 'new-deadline', onClick: () => addDeadline(ctx) });
    return h('div', { class: 'view deadlines' },
        pageHeader({ lede: `Dates you must not miss: renewals, expiries, bills and tasks. Each one has its own warning window and shows up in your briefing from its start-warning date.${urgentN ? ` ${plural(urgentN, 'item')} ${urgentN === 1 ? 'is' : 'are'} overdue or urgent now.` : ''}`, actions: add }),
        tabBar(tab, counts),
        listTab(ctx, tab, data));
}
