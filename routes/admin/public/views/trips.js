// Trips: where you went or are going, with the flights, deadlines and notes that belong to each trip.
//   #/trips                  Upcoming trips, soonest first (?tab=ongoing, ?tab=past; cancelled trips are in Past)
//   #/trips/12               that trip's drawer: details and edit, flights, deadlines, items, history, delete
//   #/trips?new=1            the New trip drawer (the palette uses it)
// Above the list, suggested trips made from flights that are on no trip: edit the name, Accept or Dismiss. An item's
// reference (a booking number) is fetched and shown only after Show reference, never in a list. Server text goes in as text.
import {
    h, icon, button, plural, when, ago, emptyState, errorState, toast, confirmDialog, deleteDialog, openDrawer, fact, hidden, actorName, dayLabel,
} from '../ui.js';
import { href, navigate, parse } from '../router.js';

const TABS = [['upcoming', 'Upcoming'], ['ongoing', 'Ongoing'], ['past', 'Past']];
const KINDS = [['leisure', 'Leisure'], ['conference', 'Conference'], ['research', 'Research'], ['family', 'Family'], ['work', 'Work'], ['other', 'Other']];
const KIND = Object.fromEntries(KINDS);
const ITEM_KINDS = [['stay', 'Stay'], ['ground', 'Ground travel'], ['activity', 'Activity'], ['booking', 'Booking'], ['other', 'Other']];
const ITEM_KIND = Object.fromEntries(ITEM_KINDS);
const PHASE = { upcoming: 'Upcoming', ongoing: 'Ongoing', past: 'Past', cancelled: 'Cancelled' };
const PHASE_CLS = { upcoming: 'is-scheduled', ongoing: 'is-active', past: 'is-completed', cancelled: 'is-cancelled' };
const FORM_FIELDS = ['title', 'destination', 'kind', 'start_date', 'end_date', 'notes', 'status_override'];
const ITEM_FIELDS = ['kind', 'title', 'start_date', 'end_date', 'place', 'notes', 'reference'];
const CODE_FIELD = { bad_date: 'end_date', bad_title: 'title', bad_kind: 'kind' };

const tripHref = (id) => href('trips', [String(id)]);
const tabHref = (id, extra = {}) => (id === 'upcoming' ? href('trips', [], extra) : href('trips', [], { tab: id, ...extra }));
const day = (d) => dayLabel(d, { month: 'short', day: 'numeric', year: 'numeric' });
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const fieldError = (message, name) => Object.assign(new Error(message), { field: name });
const arrows = (route) => (route && route.length ? route.join(' → ') : '');

let drawer = null;        // { id, handle, fromList } the trip drawer that matches the URL
let side = null;          // the New trip drawer (not in the URL)
let lastWasList = false;  // the previous render was the plain list (closing the drawer can go back)
let focusAfter = null;    // a data-key to focus once the next render is on screen
let fieldId = 0;

/* ---------- small helpers ---------- */

function dateRange(t) {
    if (t.start_date && t.end_date) return `${day(t.start_date)} to ${day(t.end_date)}${t.nights != null ? `, ${plural(t.nights, 'night')}` : ''}`;
    if (t.start_date) return `From ${day(t.start_date)}`;
    if (t.end_date) return `Until ${day(t.end_date)}`;
    return 'No dates yet';
}

function countdown(t) {
    if (t.phase === 'upcoming') {
        if (t.days_to_start == null) return 'Not dated yet';
        return t.days_to_start === 1 ? 'Starts tomorrow' : `Starts in ${plural(t.days_to_start, 'day')}`;
    }
    if (t.phase === 'ongoing') {
        if (t.nights == null || t.days_left == null) return 'Happening now';
        return `Day ${t.nights + 1 - t.days_left} of ${t.nights + 1}${t.days_left === 0 ? ', the last day' : ''}`;
    }
    return '';
}

const phaseChip = (t) => h('span', { class: `chip status-chip ${PHASE_CLS[t.phase] || ''}` }, h('span', { text: PHASE[t.phase] || t.phase }));
const kindChip = (kind) => h('span', { class: 'chip kind-chip' }, h('span', { text: KIND[kind] || kind }));
const flightLabel = (f) => `${f.airline_iata} ${f.flight_number}  ${f.origin_iata} to ${f.dest_iata}`;
const dateOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function field(label, input, help) {
    const id = input.id || `tf-${++fieldId}`;
    input.id = id;
    const helpId = help ? `${id}-help` : null;
    if (helpId) input.setAttribute('aria-describedby', helpId);
    return h('div', { class: 'field' },
        h('label', { for: id, text: label }), input,
        help ? h('p', { class: 'help', id: helpId, text: help }) : null);
}

const textInput = (name, value, attrs = {}) => h('input', { type: 'text', name, autocomplete: 'off', spellcheck: 'false', value: value == null ? '' : String(value), 'data-key': `f-${name}`, ...attrs });
const select = (name, options, value) => {
    const el = h('select', { name, 'data-key': `f-${name}` }, options.map(([k, label]) => h('option', { value: k, text: label })));
    el.value = value;
    return el;
};
const textarea = (name, value) => {
    const el = h('textarea', { name, rows: '3', maxlength: '2000', class: 'plain', 'data-key': `f-${name}` });
    el.value = value || '';
    return el;
};
const trim = (v) => (v == null ? null : String(v).trim() || null);

/* ---------- the trip form (New trip, and edit in the drawer) ---------- */

function startValues(t) {
    if (!t) return { title: '', destination: '', kind: 'leisure', start_date: '', end_date: '', notes: '', status_override: '' };
    return { title: t.title, destination: t.destination || '', kind: t.kind, start_date: t.start_date || '', end_date: t.end_date || '', notes: t.notes || '', status_override: t.status_override || '' };
}

const clean = (v) => ({ title: String(v.title || '').trim(), destination: trim(v.destination), kind: v.kind, start_date: trim(v.start_date), end_date: trim(v.end_date), notes: trim(v.notes), status_override: v.status_override || null });

function tripForm({ values, mode, submit, onSave, onCancel, onDirty }) {
    const base = clean(values);
    const f = {};
    f.title = textInput('title', values.title, { maxlength: '120', placeholder: 'Chicago conference' });
    f.destination = textInput('destination', values.destination, { maxlength: '120', placeholder: 'Chicago, USA' });
    f.kind = select('kind', KINDS, values.kind);
    f.start_date = textInput('start_date', values.start_date, { type: 'date' });
    f.end_date = textInput('end_date', values.end_date, { type: 'date' });
    f.notes = textarea('notes', values.notes);
    const cancelled = h('input', { type: 'checkbox', name: 'status_override', 'data-key': 'f-status_override', id: `tf-${++fieldId}` });
    cancelled.checked = values.status_override === 'cancelled';
    const current = () => ({ title: f.title.value, destination: f.destination.value, kind: f.kind.value, start_date: f.start_date.value, end_date: f.end_date.value, notes: f.notes.value, status_override: cancelled.checked ? 'cancelled' : null });
    const dirty = () => { const now = clean(current()); return FORM_FIELDS.some((k) => !Object.is(now[k], base[k])); };
    const error = h('p', { class: 'error', role: 'alert' });
    const save = button({ text: submit, type: 'submit', size: 'small', 'data-key': 'tf-save' });
    const form = h('form', {
        class: 'place-form flight-form trip-form',
        novalidate: true,
        oninput: () => onDirty && onDirty(),
        onchange: () => onDirty && onDirty(),
        onsubmit: async (event) => {
            event.preventDefault();
            error.replaceChildren();
            save.disabled = true;
            try {
                const now = clean(current());
                if (!now.title) throw fieldError('Give the trip a title.', 'title');
                if (now.start_date && now.end_date && now.end_date < now.start_date) throw fieldError('The end date cannot be before the start date.', 'end_date');
                const body = mode === 'create'
                    ? Object.fromEntries(FORM_FIELDS.filter((k) => now[k] != null && k !== 'status_override').map((k) => [k, now[k]]))
                    : Object.fromEntries(FORM_FIELDS.filter((k) => !Object.is(now[k], base[k])).map((k) => [k, now[k]]));
                await onSave(body);
            } catch (err) {
                error.textContent = err.message;
                const name = err.field || CODE_FIELD[err.code];
                const bad = name && form.querySelector(`[name="${name}"]`);
                if (bad) bad.focus();
                save.disabled = false;
            }
        },
    },
    h('fieldset', { class: 'flight-group' }, h('legend', { text: 'Trip' }), h('div', { class: 'group-grid' },
        h('div', { class: 'wide-field' }, field('Title', f.title, 'A name you will recognise, for example Spring break.')),
        field('Destination (optional)', f.destination),
        field('Kind', f.kind),
        field('Start date', f.start_date, 'The first day. Leave empty if you do not know yet.'),
        field('End date', f.end_date),
        h('div', { class: 'wide-field' }, field('Notes', f.notes)),
        mode === 'edit' ? h('div', { class: 'wide-field' }, h('div', { class: 'check-field' },
            h('label', { class: 'check', for: cancelled.id }, cancelled, h('span', { text: 'This trip is cancelled' })),
            h('p', { class: 'help', text: 'A cancelled trip moves to Past with a Cancelled chip. Its flights stay linked.' }))) : null)),
    error,
    h('div', { class: 'row' }, save, onCancel ? button({ text: 'Cancel', variant: 'quiet', size: 'small', onClick: onCancel }) : null));
    return { el: form, dirty, save };
}

/* ---------- an item form (inline in the drawer) ---------- */

function itemForm({ values, mode, onSave, onCancel }) {
    const f = {};
    f.kind = select('kind', ITEM_KINDS, values.kind);
    f.title = textInput('title', values.title, { maxlength: '120', placeholder: 'Hotel near the venue' });
    f.start_date = textInput('start_date', values.start_date, { type: 'date' });
    f.end_date = textInput('end_date', values.end_date, { type: 'date' });
    f.place = textInput('place', values.place, { maxlength: '120' });
    f.notes = textarea('notes', values.notes);
    f.reference = textInput('reference', values.reference, { type: 'password', maxlength: '120' });
    const refLabel = h('span', { text: 'Show' });
    const toggle = h('button', { type: 'button', class: 'btn quiet small', 'data-key': 'ref-toggle', 'aria-pressed': 'false', 'aria-label': 'Show the reference',
        onclick: () => {
            const show = f.reference.type === 'password';
            f.reference.type = show ? 'text' : 'password';
            refLabel.textContent = show ? 'Hide' : 'Show';
            toggle.setAttribute('aria-pressed', String(show));
            toggle.setAttribute('aria-label', show ? 'Hide the reference' : 'Show the reference');
        } }, icon('keys'), refLabel);
    const refId = `tf-${++fieldId}`;
    f.reference.id = refId;
    const base = { kind: values.kind, title: values.title, start_date: trim(values.start_date), end_date: trim(values.end_date), place: trim(values.place), notes: trim(values.notes), reference: trim(values.reference) };
    const now = () => ({ kind: f.kind.value, title: f.title.value.trim(), start_date: trim(f.start_date.value), end_date: trim(f.end_date.value), place: trim(f.place.value), notes: trim(f.notes.value), reference: trim(f.reference.value) });
    const error = h('p', { class: 'error', role: 'alert' });
    const save = button({ text: mode === 'create' ? 'Add item' : 'Save item', type: 'submit', size: 'small', 'data-key': 'item-save' });
    const form = h('form', {
        class: 'place-form flight-form trip-item-form', novalidate: true, 'aria-label': mode === 'create' ? 'New item' : `Edit ${values.title}`,
        onsubmit: async (event) => {
            event.preventDefault();
            error.replaceChildren();
            save.disabled = true;
            try {
                const v = now();
                if (!v.title) throw fieldError('Give the item a title.', 'title');
                if (v.start_date && v.end_date && v.end_date < v.start_date) throw fieldError('The end date cannot be before the start date.', 'end_date');
                const body = mode === 'create'
                    ? Object.fromEntries(ITEM_FIELDS.filter((k) => v[k] != null).map((k) => [k, v[k]]))
                    : Object.fromEntries(ITEM_FIELDS.filter((k) => !Object.is(v[k], base[k])).map((k) => [k, v[k]]));
                if (mode === 'edit' && !Object.keys(body).length) { toast('Nothing changed', { kind: 'info' }); save.disabled = false; return; }
                await onSave(body);
            } catch (err) {
                error.textContent = err.message;
                const name = err.field || CODE_FIELD[err.code];
                const bad = name && form.querySelector(`[name="${name}"]`);
                if (bad) bad.focus();
                save.disabled = false;
            }
        },
    },
    h('div', { class: 'group-grid' },
        h('div', { class: 'wide-field' }, field('Title', f.title)),
        field('Kind', f.kind),
        field('Place (optional)', f.place),
        field('From (optional)', f.start_date),
        field('To (optional)', f.end_date),
        h('div', { class: 'wide-field' }, h('div', { class: 'field' },
            h('label', { for: refId, text: 'Reference (optional)' }),
            h('div', { class: 'ref-row' }, f.reference, toggle),
            h('p', { class: 'help', text: 'A booking or confirmation number. Hidden by default, and never shown in the list.' }))),
        h('div', { class: 'wide-field' }, field('Notes', f.notes))),
    error,
    h('div', { class: 'row' }, save, button({ text: 'Cancel', variant: 'quiet', size: 'small', onClick: onCancel })));
    return { el: form, dirty: () => ITEM_FIELDS.some((k) => !Object.is(now()[k], base[k])), first: f.title };
}

/* ---------- compare two revisions ---------- */

function snapshotLines(t) {
    return [
        `Title: ${t.title}`,
        `Destination: ${t.destination || 'none'}`,
        `Kind: ${KIND[t.kind] || t.kind}`,
        `Start: ${t.start_date || 'not set'}`,
        `End: ${t.end_date || 'not set'}`,
        `Cancelled: ${t.status_override === 'cancelled' ? 'yes' : 'no'}`,
        `Notes: ${t.notes || 'none'}`,
    ];
}

function diffLines(older, newer) {
    const a = snapshotLines(older);
    const b = snapshotLines(newer);
    return [...a.filter((l) => !b.includes(l)).map((l) => ['del', l]), ...b.map((l) => [a.includes(l) ? 'same' : 'add', l])];
}

/* ---------- delete ---------- */

async function deleteIt(ctx, t) {
    let pre;
    try { pre = await ctx.api(`/trips/${t.id}/delete-preview`); } catch (err) { if (err.status !== 401) toast(`Could not check what a delete would take. ${err.message}`, { kind: 'bad' }); return null; }
    const c = pre.counts;
    const out = await deleteDialog({
        title: `Delete the trip ${pre.label}?`,
        goes: [`The trip ${pre.label}`, plural(c.items, 'item'), c.deadlines ? `Its link on ${plural(c.deadlines, 'deadline')} (the deadlines stay)` : null, 'Its history'].filter(Boolean),
        stays: [c.flights ? `The ${plural(c.flights, 'flight')} on it, if you take them off below (they stay in your flights and the Passport)` : 'Your flights', 'Anything outside this hub: the hotel, the booking itself'],
        options: c.flights ? [{ name: 'unassign', label: `Take ${plural(c.flights, 'flight')} off the trip and delete it`, checked: false, help: 'Without this the delete is refused while flights are on the trip.' }] : [],
        run: (o) => ctx.api(`/trips/${t.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup, unassign: o.unassign === true } }),
    });
    if (out) toast(`Deleted the trip ${out.label || pre.label}`);
    return out;
}

/* ---------- the trip drawer ---------- */

function closeDrawerTo(fromList) {
    if (fromList && history.length > 1) history.back();
    else navigate(href('trips'), { replace: true });
}

function tripDrawer(ctx, id, fromList, mark) {
    let trip = null;
    let form = null;
    let pool = { flights: [], trips: [], failed: false }; // flights and trips for the picker
    let editing = null;      // an item id, 'new', or null
    let itemFormNow = null;  // the open item form
    const shown = new Map(); // item id -> reference text, only after Show reference

    const handle = openDrawer({
        title: 'Trip',
        subtitle: 'Loading…',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !((form && form.dirty()) || (itemFormNow && itemFormNow.dirty())) || confirmDialog({ title: 'Discard your changes?', body: 'The trip keeps what was last saved.', confirm: 'Discard', danger: true }),
        onClose: () => { if (drawer && drawer.handle === handle) { drawer = null; closeDrawerTo(fromList); } },
        returnFocus: () => document.querySelector(`[data-key="trip:${id}"]`) || document.querySelector('[data-key="new-trip"]'),
    });

    const focusKey = (key) => {
        const el = key && handle.body.querySelector(`[data-key="${key}"]`);
        if (el) el.focus(); else handle.el.querySelector('.drawer-head button').focus();
    };

    async function changed(key) { await load(key); ctx.rerender(); }

    async function load(key) {
        const top = handle.body.scrollTop;
        try {
            const [t, flights, trips] = await Promise.all([ctx.api(`/trips/${id}`), ctx.api('/flights?limit=500').catch(() => null), ctx.api('/trips?limit=200').catch(() => null)]);
            // References stay out of memory until Show reference or Edit asks for them.
            trip = { ...t, items: t.items.map(({ reference: _ref, ...rest }) => rest) };
            pool = { flights: flights ? flights.flights : [], trips: trips ? trips.trips : [], failed: !flights };
        } catch (err) {
            if (err.status === 401) return;
            if (err.status === 404) {
                toast('That trip is gone or never existed.', { kind: 'info' });
                drawer = null; handle.close(true); closeDrawerTo(fromList);
                return;
            }
            handle.setTitle('Trip', '');
            handle.setContent(errorState({ err, what: 'This trip', retry: () => load(key) }));
            return;
        }
        handle.setTitle(trip.title, `${PHASE[trip.phase]}${trip.destination ? `, ${trip.destination}` : ''}, revision ${trip.rev}`);
        handle.setContent(content());
        handle.body.scrollTop = top;
        if (key) focusKey(key);
    }

    const guard = (fn, key) => async () => {
        if (((form && form.dirty()) || (itemFormNow && itemFormNow.dirty())) && !(await confirmDialog({ title: 'Discard your changes?', body: 'This reloads the trip. What you typed and did not save is lost.', confirm: 'Continue', danger: true }))) return;
        form = null; itemFormNow = null; editing = null;
        await fn();
        await changed(key);
    };

    /* details */
    function details() {
        form = tripForm({
            values: startValues(trip), mode: 'edit', submit: 'Save changes',
            onSave: async (body) => {
                if (!Object.keys(body).length) { toast('Nothing changed', { kind: 'info' }); form.save.disabled = false; return; }
                const res = await ctx.api(`/trips/${trip.id}`, { method: 'PATCH', body });
                toast(res.status === 'unchanged' ? 'Nothing changed' : 'Changes saved', { kind: res.status === 'unchanged' ? 'info' : 'good' });
                form = null;
                await changed('tf-save');
            },
        });
        return form.el;
    }

    /* flights */
    function flightsSection() {
        const unlink = async (f) => {
            try {
                await ctx.api(`/trips/${trip.id}/flights/${f.id}`, { method: 'DELETE' });
                toast(`${flightLabel(f)} is off this trip`);
                await changed('flight-picker');
            } catch (err) { if (err.status !== 401) toast(`Could not take it off. ${err.message}`, { kind: 'bad' }); }
        };
        const titleOf = (tid) => (pool.trips.find((t) => t.id === tid) || { title: `trip ${tid}` }).title;
        const free = pool.flights.filter((f) => f.trip_id !== trip.id);
        const picker = h('select', { id: 'td-picker', name: 'flight', 'data-key': 'flight-picker', 'aria-label': 'Flight to put on this trip' },
            h('option', { value: '', text: free.length ? 'Choose a flight…' : 'No other flights' }));
        const optFor = (f) => h('option', { value: String(f.id), text: `${flightLabel(f)}, ${day(f.dep_local_date)}${f.status === 'cancelled' ? ' (cancelled)' : ''}${f.trip_id ? ` (on ${titleOf(f.trip_id)})` : ''}` });
        const loose = free.filter((f) => !f.trip_id);
        const onOther = free.filter((f) => f.trip_id);
        if (loose.length) picker.append(h('optgroup', { label: 'Not on a trip' }, loose.map(optFor)));
        if (onOther.length) picker.append(h('optgroup', { label: 'On another trip (linking moves it here)' }, onOther.map(optFor)));
        const help = h('p', { class: 'help', 'aria-live': 'polite' });
        picker.addEventListener('change', () => {
            const f = free.find((x) => String(x.id) === picker.value);
            help.textContent = f && f.trip_id ? `This flight is on ${titleOf(f.trip_id)} now. Linking it moves it here and takes it off that trip.` : '';
        });
        const link = button({ text: 'Add to this trip', size: 'small', iconName: 'plus', 'data-key': 'link-flight', onClick: async () => {
            if (!picker.value) { toast('Choose a flight first', { kind: 'info' }); picker.focus(); return; }
            try {
                const res = await ctx.api(`/trips/${trip.id}/flights`, { method: 'POST', body: { flight_id: Number(picker.value) } });
                toast(res.status === 'moved' ? `Moved ${res.flight} here from ${res.moved_from ? res.moved_from.title : 'another trip'}` : res.status === 'unchanged' ? 'That flight was already here' : `${res.flight} is on this trip`);
                await changed('flight-picker');
            } catch (err) { if (err.status !== 401) toast(`Could not add the flight. ${err.message}`, { kind: 'bad' }); }
        } });
        return h('section', { class: 'drawer-section', 'aria-labelledby': 'td-flights' },
            h('h3', { id: 'td-flights', text: `Flights, ${trip.flights.length}` }),
            trip.flights.length ? h('ul', { class: 'trip-rows' }, trip.flights.map((f) => h('li', { 'data-flight': String(f.id) },
                h('div', {}, h('a', { class: 'link', href: href('flights', [String(f.id)]), text: flightLabel(f) }), ' ',
                    h('span', { class: 'muted', text: day(f.dep_local_date) }), f.status === 'cancelled' ? h('span', { class: 'chip status-chip is-cancelled', text: 'Cancelled' }) : null),
                button({ text: 'Unlink', variant: 'quiet', size: 'small', label: `Take ${flightLabel(f)} off this trip`, onClick: () => unlink(f) }))))
                : h('p', { class: 'muted', text: 'No flights on this trip yet.' }),
            pool.failed ? h('p', { class: 'note', text: 'Could not load your flights, so the picker is empty. Reload the trip to try again.' })
                : h('div', { class: 'field' }, h('label', { for: 'td-picker', text: 'Put a flight on this trip' }), h('div', { class: 'row' }, picker, link), help));
    }

    /* deadlines (read only) */
    function deadlinesSection() {
        return h('section', { class: 'drawer-section', 'aria-labelledby': 'td-deadlines' },
            h('h3', { id: 'td-deadlines', text: `Deadlines, ${trip.deadlines.length}` }),
            trip.deadlines.length ? h('ul', { class: 'trip-rows' }, trip.deadlines.map((d) => h('li', {},
                h('a', { class: 'link', href: href('deadlines', [String(d.id)]), text: d.title }),
                h('span', { class: 'muted', text: `${cap(d.kind)}, ${d.status === 'active' ? `due ${day(d.due_date)}${d.days_left != null ? `, ${d.days_left < 0 ? `${plural(-d.days_left, 'day')} overdue` : d.days_left === 0 ? 'today' : `in ${plural(d.days_left, 'day')}`}` : ''}` : d.status}` }))))
                : h('p', { class: 'muted' }, 'No deadlines are linked to this trip. To link one, open it in ', h('a', { class: 'link', href: href('deadlines'), text: 'Deadlines' }), ' and set its trip.'),
            trip.deadlines.length ? h('p', { class: 'note' }, 'Change these in ', h('a', { class: 'link', href: href('deadlines'), text: 'Deadlines' }), '.') : null);
    }

    /* items */
    async function reference(item) {
        const res = await ctx.api(`/trips/${trip.id}/items`);
        const hit = res.items.find((x) => x.id === item.id);
        return hit ? hit.reference || '' : '';
    }

    function itemRow(item) {
        const key = `item:${item.id}`;
        const sub = [item.place, item.start_date ? (item.end_date && item.end_date !== item.start_date ? `${day(item.start_date)} to ${day(item.end_date)}` : day(item.start_date)) : null].filter(Boolean).join(', ');
        const refNow = shown.get(item.id);
        const refBox = h('span', { class: 'item-ref', 'aria-live': 'polite' });
        const refBtn = !item.has_reference ? null : button({ text: refNow != null ? 'Hide reference' : 'Show reference', variant: 'quiet', size: 'small', label: `${refNow != null ? 'Hide' : 'Show'} the reference for ${item.title}`, 'data-key': `ref:${item.id}`,
            onClick: async () => {
                const label = (show) => { refBtn.querySelector('span').textContent = show ? 'Hide reference' : 'Show reference'; refBtn.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} the reference for ${item.title}`); };
                if (shown.has(item.id)) { shown.delete(item.id); refBox.textContent = ''; label(false); return; }
                try {
                    shown.set(item.id, await reference(item));
                    refBox.textContent = shown.get(item.id) || '(empty)';
                    label(true);
                } catch (err) { if (err.status !== 401) toast(`Could not load the reference. ${err.message}`, { kind: 'bad' }); }
            } });
        if (refNow != null) refBox.textContent = refNow || '(empty)';
        return h('li', { 'data-item': String(item.id) },
            h('div', { class: 'trip-item-main' },
                h('p', {}, h('strong', { text: item.title }), ' ', h('span', { class: 'chip kind-chip' }, h('span', { text: ITEM_KIND[item.kind] || item.kind }))),
                sub ? h('p', { class: 'muted', text: sub }) : null,
                item.notes ? h('p', { class: 'trip-item-notes', text: item.notes }) : null,
                item.has_reference ? h('p', {}, h('span', { class: 'muted', text: 'Reference saved. ' }), refBox) : null),
            h('div', { class: 'rev-actions' }, refBtn,
                button({ text: 'Edit', variant: 'quiet', size: 'small', label: `Edit ${item.title}`, 'data-key': key, onClick: guard(() => { editing = item.id; }, key) }),
                button({ text: 'Remove', variant: 'quiet-danger', size: 'small', label: `Remove ${item.title}`, onClick: async () => {
                    const ok = await confirmDialog({ title: `Remove ${item.title}?`, body: 'Items have no history, so this cannot be undone.', confirm: 'Remove', danger: true });
                    if (!ok) return;
                    try { await ctx.api(`/trips/${trip.id}/items/${item.id}`, { method: 'DELETE' }); toast(`${item.title} removed`); shown.delete(item.id); await changed('add-item'); } catch (err) { if (err.status !== 401) toast(`Could not remove it. ${err.message}`, { kind: 'bad' }); }
                } })));
    }

    async function openItemForm(item, host) {
        let values = { kind: 'stay', title: '', start_date: '', end_date: '', place: '', notes: '', reference: '' };
        if (item) {
            let ref = '';
            if (item.has_reference) { try { ref = await reference(item); } catch (err) { if (err.status !== 401) toast(`Could not load the reference. ${err.message}`, { kind: 'bad' }); return; } }
            values = { kind: item.kind, title: item.title, start_date: item.start_date || '', end_date: item.end_date || '', place: item.place || '', notes: item.notes || '', reference: ref };
        }
        const mode = item ? 'edit' : 'create';
        itemFormNow = itemForm({
            values, mode,
            onCancel: () => { itemFormNow = null; editing = null; load(item ? `item:${item.id}` : 'add-item'); },
            onSave: async (body) => {
                if (item) await ctx.api(`/trips/${trip.id}/items/${item.id}`, { method: 'PATCH', body });
                else await ctx.api(`/trips/${trip.id}/items`, { method: 'POST', body });
                toast(item ? 'Item saved' : 'Item added');
                itemFormNow = null; editing = null;
                shown.delete(item ? item.id : -1);
                await changed(item ? `item:${item.id}` : 'add-item');
            },
        });
        host.replaceChildren(itemFormNow.el);
        itemFormNow.first.focus();
    }

    function itemsSection() {
        const host = h('div', { class: 'item-form-host' });
        const rows = trip.items.map((it) => {
            if (editing !== it.id) return itemRow(it);
            const li = h('li', { class: 'trip-item-edit' });
            queueMicrotask(() => openItemForm(it, li));
            return li;
        });
        if (editing === 'new') queueMicrotask(() => openItemForm(null, host));
        return h('section', { class: 'drawer-section', 'aria-labelledby': 'td-items' },
            h('h3', { id: 'td-items', text: `Items, ${trip.items.length}` }),
            h('p', { class: 'note', text: 'A small itinerary: stays, rides, activities and bookings. Items can be outside the trip dates.' }),
            rows.length ? h('ul', { class: 'trip-rows' }, rows) : h('p', { class: 'muted', text: 'No items yet.' }),
            host,
            button({ text: 'Add item', variant: 'quiet', size: 'small', iconName: 'plus', 'data-key': 'add-item', onClick: guard(() => { editing = 'new'; }, null) }));
    }

    /* history */
    async function restore(rev) {
        const ok = await confirmDialog({ title: `Restore revision ${rev}?`, body: `The fields of revision ${rev} become current, as a new revision. What you see now stays in the history.`, confirm: 'Restore' });
        if (!ok) return;
        try {
            const res = await ctx.api(`/trips/${trip.id}/restore`, { method: 'POST', body: { rev } });
            toast(res.status === 'unchanged' ? 'That revision is the same as the current one' : `Revision ${rev} restored`, { kind: res.status === 'unchanged' ? 'info' : 'good' });
            form = null;
            changed('history');
        } catch (err) { toast(`Could not restore. ${err.message}`, { kind: 'bad' }); }
    }

    async function compare(rev) {
        handle.setContent(h('p', { class: 'muted', text: 'Loading…' }));
        try {
            const older = await ctx.api(`/trips/${trip.id}?rev=${rev}`);
            const parts = diffLines(older, trip);
            const n = parts.filter(([k]) => k !== 'same').length;
            const back = button({ text: 'Back to the trip', variant: 'ghost', size: 'small', iconName: 'prev', onClick: () => load('history') });
            handle.setTitle(trip.title, `Revision ${rev} and the current one`);
            handle.setContent(
                h('div', { class: 'compare-top' }, back, button({ text: `Restore revision ${rev}`, variant: 'quiet', size: 'small', onClick: () => restore(rev) })),
                h('p', { class: 'note', text: n ? `${plural(n, 'line')} differ. Lines only in revision ${rev} are struck through; lines added since are marked with a plus.` : 'Revision and current are the same.' }),
                h('div', { class: 'diff diff-plain' }, parts.map(([k, text]) => h('p', { class: k }, k === 'add' ? hidden('Added: ') : k === 'del' ? hidden('Removed: ') : null, text))));
            back.focus();
        } catch (err) { if (err.status !== 401) handle.setContent(errorState({ err, what: 'That revision', retry: () => compare(rev) })); }
    }

    function historySection() {
        return h('section', { class: 'drawer-section', 'aria-labelledby': 'td-history' },
            h('h3', { id: 'td-history', tabindex: '-1', 'data-key': 'history', text: `History, ${plural(trip.history.length, 'revision')}` }),
            h('p', { class: 'note', text: 'Every change to the trip is kept. Restoring adds a new revision, so nothing is lost. Flights, deadlines and items are not part of a revision.' }),
            h('ol', { class: 'rev-list', reversed: true }, trip.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
                h('div', { class: 'rev-main' },
                    h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                    h('p', { class: 'rev-what', text: `${{ create: 'Created', edit: 'Edited', restore: 'Restored', migration: 'Carried over from Flights' }[r.source] || cap(r.source)} by ${actorName(r.actor)}${r.note ? `: ${r.note}` : ''}` }),
                    h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
                r.current ? null : h('div', { class: 'rev-actions' },
                    button({ text: 'Compare', variant: 'quiet', size: 'small', label: `Compare revision ${r.rev} with the current one`, onClick: () => compare(r.rev) }),
                    button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) }))))));
    }

    function content() {
        form = null;
        return [
            h('section', { class: 'drawer-section', 'aria-labelledby': 'td-details' },
                h('h3', { id: 'td-details', text: 'Details' }),
                h('p', { class: 'trip-state' }, phaseChip(trip), ' ', kindChip(trip.kind), ' ', h('span', { class: 'muted', text: [dateRange(trip), countdown(trip)].filter(Boolean).join(', ') })),
                details(),
                h('dl', { class: 'facts' },
                    fact('Flights', trip.flight_count ? `${plural(trip.flight_count, 'flight')}${trip.route.length ? `, ${arrows(trip.route)}` : ''}${trip.distance_km ? `, ${trip.distance_km.toLocaleString()} km` : ''}` : 'none'),
                    fact('Last changed', `${ago(trip.updated_at)} by ${actorName(trip.updated_by)}`))),
            flightsSection(),
            deadlinesSection(),
            itemsSection(),
            historySection(),
            h('section', { class: 'drawer-section danger-zone' },
                h('p', { class: 'note', text: 'Delete permanently removes the trip, its items and its history. Flights and deadlines stay, without the link.' }),
                button({ text: 'Delete permanently', variant: 'quiet-danger', iconName: 'trash', 'data-key': 'drawer-delete', onClick: async () => {
                    if (!(await deleteIt(ctx, trip))) return;
                    form = null; itemFormNow = null; drawer = null;
                    handle.close(true);
                    closeDrawerTo(fromList);
                    ctx.rerender();
                } })),
        ];
    }

    mark.handle = handle;
    load();
}

// Opens, keeps or closes the drawer so it matches the URL.
function syncDrawer(ctx) {
    const raw = ctx.route.parts[0];
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (raw && !id) { navigate(href('trips'), { replace: true }); return; }
    if ((drawer ? drawer.id : null) === id) return;
    if (drawer) { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
    if (!id) return;
    const mark = { id, handle: null, fromList: lastWasList };
    drawer = mark;
    setTimeout(() => { if (drawer === mark) tripDrawer(ctx, id, mark.fromList, mark); }, 0);
}

/* ---------- New trip ---------- */

function closeSide(force = true) {
    if (side) { const s = side; side = null; s.close(force); }
}

function newTrip(ctx) {
    if (side) return;
    let form = null;
    const handle = openDrawer({
        title: 'New trip',
        subtitle: 'A title is enough. Add dates now or later, and put flights on it from the trip.',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard this trip?', body: 'Nothing has been saved yet.', confirm: 'Discard', danger: true }),
        onClose: () => { if (side === handle) side = null; },
        returnFocus: () => document.querySelector('[data-key="new-trip"]') || document.querySelector('[data-key="empty-new"]'),
    });
    side = handle;
    form = tripForm({
        values: startValues(null), mode: 'create', submit: 'Add trip', onCancel: () => handle.close(),
        onSave: async (body) => {
            const res = await ctx.api('/trips', { method: 'POST', body });
            toast(`${res.title} added`);
            form = null; side = null;
            handle.close(true);
            focusAfter = `trip:${res.id}`;
            ctx.rerender();
        },
    });
    handle.setContent(form.el);
    const first = handle.body.querySelector('input');
    if (first) first.focus();
}

/* ---------- suggestions ---------- */

function suggestions(ctx, data) {
    if (!data) return null;
    const after = (key) => { focusAfter = key; ctx.rerender(); };
    if (data.needs_home_airport) {
        return h('p', { class: 'note', 'data-key': 'needs-home' }, 'Set your home airport in the ', h('a', { class: 'link', href: href('flights'), text: 'Flights settings' }), ' so trips can be suggested.');
    }
    const restoreBtn = data.dismissed ? button({ text: `Show ${plural(data.dismissed, 'dismissed suggestion')} again`, variant: 'ghost', size: 'small', 'data-key': 'restore-dismissed', onClick: async () => {
        try { const r = await ctx.api('/trips/suggestions/restore-dismissed', { method: 'POST' }); toast(r.status === 'restored' ? `Brought back ${plural(r.restored, 'suggestion')}` : 'Nothing was dismissed', { kind: r.status === 'restored' ? 'good' : 'info' }); after('tab:upcoming'); } catch (err) { if (err.status !== 401) toast(err.message, { kind: 'bad' }); }
    } }) : null;
    if (!data.suggestions.length) return restoreBtn ? h('p', { class: 'note' }, 'No suggested trips right now. ', restoreBtn) : null;
    const fail = (err) => {
        if (err.status === 401) return;
        toast(err.code === 'stale_suggestion' ? 'Your flights changed since this was suggested. The list is updated.' : err.message, { kind: 'bad' });
        if (err.code === 'stale_suggestion') after('tab:upcoming');
    };
    return h('section', { class: 'panel trip-suggest', 'aria-labelledby': 'sug-title' },
        h('h2', { id: 'sug-title', class: 'section-title', text: `Suggested trips, ${data.suggestions.length}` }),
        h('p', { class: 'note', text: `Made from flights that are on no trip, grouped by trips that start and end at ${data.home_airport || 'home'}. Rename a suggestion before you accept it.` }),
        h('ul', { class: 'trip-rows' }, data.suggestions.map((s) => {
            const input = h('input', { type: 'text', value: s.title, maxlength: '120', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Trip name for ${s.title}`, 'data-key': `sug-title:${s.key}` });
            const accept = button({ text: 'Accept', size: 'small', iconName: 'check', label: `Accept ${s.title} as a trip`, 'data-key': `sug-accept:${s.key}`, onClick: async () => {
                accept.disabled = true;
                try {
                    const res = await ctx.api('/trips/suggestions/accept', { method: 'POST', body: { key: s.key, title: input.value.trim() || s.title } });
                    toast(`${res.title} added with ${plural(res.flight_ids.length, 'flight')}`);
                    after(`trip:${res.id}`);
                } catch (err) { accept.disabled = false; fail(err); }
            } });
            const dismiss = button({ text: 'Dismiss', variant: 'quiet', size: 'small', label: `Dismiss the suggestion ${s.title}`, 'data-key': `sug-dismiss:${s.key}`, onClick: async () => {
                dismiss.disabled = true;
                try { await ctx.api('/trips/suggestions/dismiss', { method: 'POST', body: { key: s.key } }); toast(`${s.title} dismissed`, { kind: 'info' }); after('tab:upcoming'); } catch (err) { dismiss.disabled = false; fail(err); }
            } });
            return h('li', { class: 'sug-item', 'data-key': `sug:${s.key}` },
                h('div', { class: 'sug-main' }, input,
                    h('p', { class: 'muted', text: `${s.start_date} to ${s.end_date}, ${plural(s.flight_count, 'flight')}, ${arrows(s.route)}` })),
                h('div', { class: 'row' }, accept, dismiss));
        })),
        restoreBtn);
}

/* ---------- the list ---------- */

function tabBar(current, counts) {
    const list = h('div', { class: 'vtabs', role: 'tablist', 'aria-label': 'Trips sections' });
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

function tripCard(t) {
    const link = h('a', { class: 'row-link trip-title', href: tripHref(t.id), 'data-key': `trip:${t.id}` }, t.title);
    const count = countdown(t);
    return h('li', { class: `trip-card${t.phase === 'cancelled' ? ' is-cancelled' : ''}`, 'data-id': String(t.id), onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('div', { class: 'trip-head' }, link, h('span', { class: 'row' }, phaseChip(t), kindChip(t.kind))),
        t.destination && t.destination !== t.title ? h('p', { class: 'muted', text: t.destination }) : null,
        h('p', { class: 'trip-meta' },
            h('span', { text: dateRange(t) }),
            count ? h('strong', { class: 'trip-count', text: count }) : null,
            h('span', { text: t.flight_count ? `${plural(t.flight_count, 'flight')}${t.route.length ? `: ${arrows(t.route)}` : ''}` : 'No flights' }),
            t.item_count ? h('span', { text: plural(t.item_count, 'item') }) : null));
}

function listTab(ctx, tab, rows, total) {
    const add = button({ text: 'New trip', size: 'small', iconName: 'plus', 'data-key': 'empty-new', onClick: () => newTrip(ctx) });
    const EMPTY = {
        upcoming: ['No trips coming up.', 'Add a trip, or accept a suggestion made from your flights.'],
        ongoing: ['You are not on a trip right now.', 'A trip shows here from its start date until its end date.'],
        past: ['No past trips yet.', 'Trips that ended, and cancelled ones, land here.'],
    };
    const body = rows.length ? h('ul', { class: 'trip-cards' }, rows.map(tripCard))
        : emptyState({ title: EMPTY[tab][0], text: EMPTY[tab][1], iconName: 'calendar', action: tab === 'upcoming' ? add : null });
    return h('div', { class: 'tab-panel', id: `panel-${tab}`, role: 'tabpanel', 'aria-labelledby': `tab-${tab}` },
        h('section', { 'aria-label': `${cap(tab)} trips`, class: 'trips-list' },
            rows.length ? h('h2', { class: 'section-title', text: plural(rows.length, 'trip') }) : null,
            total > 200 ? h('p', { class: 'note', text: `Showing the first 200 of ${total.toLocaleString()} trips.` }) : null,
            body));
}

export async function render(ctx) {
    const q = ctx.route.query;
    const idRaw = ctx.route.parts[0];
    const asked = q.get('tab');
    const tab = TABS.some(([id]) => id === asked) ? asked : 'upcoming';

    const [list, sug] = await Promise.all([ctx.api('/trips?limit=200'), ctx.api('/trips/suggestions').catch(() => null)]);
    const groups = { upcoming: [], ongoing: [], past: [] };
    for (const t of list.trips) groups[t.phase === 'cancelled' ? 'past' : t.phase].push(t);
    // Soonest first for what is coming or happening; newest first for what is over. Undated trips go last.
    const key = (t) => t.start_date || t.end_date || '9999';
    groups.upcoming.sort((a, b) => dateOrder(key(a), key(b)) || a.id - b.id);
    groups.ongoing.sort((a, b) => dateOrder(a.end_date || '9999', b.end_date || '9999') || a.id - b.id);
    groups.past.sort((a, b) => dateOrder(key(b), key(a)) || b.id - a.id);
    const counts = { upcoming: groups.upcoming.length, ongoing: groups.ongoing.length, past: groups.past.length };

    syncDrawer(ctx);
    lastWasList = !idRaw;
    ctx.onCleanup(() => {
        if (drawer && parse().name !== 'trips') { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
        if (side && parse().name !== 'trips') closeSide();
    });
    if (q.get('new') === '1' && !idRaw) {
        navigate(tabHref(tab), { replace: true });
        setTimeout(() => newTrip(ctx), 0);
    }
    if (focusAfter) {
        const want = focusAfter;
        focusAfter = null;
        setTimeout(() => {
            const el = document.querySelector(`[data-key="${want}"]`) || document.querySelector(`[data-key="tab:${tab}"]`);
            if (el) el.focus();
        }, 0);
    }

    const add = button({ text: 'New trip', iconName: 'plus', 'data-key': 'new-trip', onClick: () => newTrip(ctx) });
    return h('div', { class: 'view trips' },
        h('div', { class: 'view-intro row-between' },
            h('p', { class: 'lede', text: 'Your trips, with the flights, deadlines and notes that belong to each. Flights that are on no trip can be suggested as one.' }),
            add),
        suggestions(ctx, sug),
        tabBar(tab, counts),
        listTab(ctx, tab, groups[tab], list.total));
}
