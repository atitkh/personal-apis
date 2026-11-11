// Flights: your flight history, the Passport, and the found flights that wait for a yes.
//   #/flights                    the Passport (?year=2026 narrows it)
//   #/flights?tab=flights        the flights (table), filters ?year= ?airport= ?airline= ?status= and search ?q=
//   #/flights/12                 that flight's drawer: details and edit, history (compare, restore), cancel
//   #/flights?tab=flights&new=1  the Add flight drawer (the palette uses it)
//   #/flights?tab=found          "Found flights": candidates a job or an agent filed; ?show=accepted|dismissed|all
// Times are shown and typed as the clock at each airport. The booking reference is masked until you press Show and
// appears only in the drawer and the forms, never in a table, a toast or the palette. Server text goes in as text.
import {
    h, icon, button, plural, when, ago, emptyState, errorState, toast, confirmDialog, formDialog, openDrawer,
    chip, chipNav, fact, hidden, actorName, dayLabel,
} from '../ui.js';
import { href, navigate, parse } from '../router.js';
import { passportTab, getUnit, distanceText } from '../passport.js';
import {
    liveDetails, liveFields, addLockNotes, refreshBar, rowExtras, sourcesCard, localInputValue, LIVE_TITLE,
} from '../flightlive.js';

const TABS = [['passport', 'Passport'], ['flights', 'Flights'], ['found', 'Found flights']];
const SHOW = [['pending', 'Waiting'], ['accepted', 'Added'], ['dismissed', 'Dismissed'], ['all', 'All']];
const STATUS = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled' };
// A flight's status is automatic (scheduled until it has landed, then completed) unless set to completed or cancelled by hand.
// `status` in every answer is the effective one, `status_override` the hand-set one (null = automatic). The form's Status
// select is auto / completed / cancelled; the server also accepts 'auto'. The filter on the Flights tab is the effective status.
const autoStatus = (f) => {
    const end = f.actual_arr || f.sched_arr || f.sched_dep;
    return end && Date.parse(end) < Date.now() ? 'completed' : 'scheduled';
};
const statusChoices = (f) => ({ auto: f ? `Automatic (${STATUS[autoStatus(f)].toLowerCase()})` : 'Automatic', completed: 'Completed', cancelled: 'Cancelled' });
const SOURCE = { manual: 'Added by hand', gmail: 'Found in email', calendar: 'Found in the calendar', feed: 'From a feed' };
const FORM_FIELDS = ['airline_iata', 'airline_name', 'flight_number', 'origin_iata', 'dest_iata', 'sched_dep', 'sched_arr', 'actual_dep', 'actual_arr',
    'aircraft_type', 'cabin', 'seat', 'booking_ref', 'status', 'trip_id', 'notes'];
const FIELD_TITLE = {
    airline_iata: 'Airline code', airline_name: 'Airline', flight_number: 'Flight number', origin_iata: 'From', dest_iata: 'To',
    sched_dep: 'Departs', sched_arr: 'Arrives', actual_dep: 'Actual departure', actual_arr: 'Actual arrival', aircraft_type: 'Aircraft',
    cabin: 'Cabin', seat: 'Seat', booking_ref: 'Booking reference', status: 'Status', trip_id: 'Trip', notes: 'Notes',
};

const flightHref = (id) => href('flights', [String(id)]);
const tabHref = (id) => (id === 'passport' ? href('flights') : href('flights', [], { tab: id }));
const flightName = (f) => `${f.airline_iata} ${f.flight_number}`;
const day = (d) => dayLabel(d, { month: 'short', day: 'numeric', year: 'numeric' });
const clock = (local) => (local ? local.slice(11, 16) : '');
const localDay = (local) => (local ? dayLabel(local.slice(0, 10), { month: 'short', day: 'numeric' }) : '');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

let drawer = null;        // { id, handle, fromList } the flight drawer that matches the URL
let side = null;          // the Add flight or Check-before-adding drawer (not in the URL)
let lastWasList = false;  // the previous render was the plain list (closing the drawer can go back)
let focusAfter = null;    // a data-key to focus once the next render is on screen

const fieldError = (message, name) => Object.assign(new Error(message), { field: name });

/* ---------- small helpers ---------- */

// "2026-03-01T08:00" as the clock reads in zone tz, from a UTC instant.
function localInput(iso, tz) {
    if (!iso) return '';
    try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
            timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
        return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    } catch (e) {
        return String(iso).slice(0, 16);
    }
}

function until(f) {
    const dep = Date.parse(f.sched_dep);
    const arr = f.sched_arr ? Date.parse(f.sched_arr) : null;
    const now = Date.now();
    if (dep <= now) return arr && arr > now ? 'In the air' : 'Departing';
    const mins = Math.round((dep - now) / 60000);
    if (mins < 60) return `in ${plural(mins, 'minute')}`;
    if (mins < 48 * 60) return `in ${plural(Math.round(mins / 60), 'hour')}`;
    return `in ${plural(Math.round(mins / 1440), 'day')}`;
}

let fieldId = 0;
function field(label, input, help) {
    const id = input.id || `ff-${++fieldId}`;
    input.id = id;
    const helpId = help ? `${id}-help` : null;
    if (helpId) input.setAttribute('aria-describedby', helpId);
    return h('div', { class: 'field' },
        h('label', { for: id, text: label }), input,
        help ? h('p', { class: 'help', id: helpId, text: help }) : null);
}

const textInput = (name, value, attrs = {}) => h('input', { type: 'text', name, autocomplete: 'off', spellcheck: 'false', value: value || '', 'data-key': `f-${name}`, ...attrs });

/* ---------- tabs (a real tablist, as in Places) ---------- */

function tabBar(current, pending) {
    const list = h('div', { class: 'vtabs', role: 'tablist', 'aria-label': 'Flights sections' });
    const tabs = TABS.map(([id, label]) => {
        const on = id === current;
        const target = tabHref(id);
        return h('button', {
            type: 'button',
            role: 'tab',
            class: 'vtab',
            id: `tab-${id}`,
            'data-key': `tab:${id}`,
            'aria-selected': String(on),
            'aria-controls': on ? `panel-${id}` : null,
            tabindex: on ? '0' : '-1',
            'data-href': target,
            onclick: () => { if (!on) navigate(target); },
        }, h('span', { text: label }),
        id === 'found' && pending ? [h('span', { class: 'badge', 'aria-hidden': 'true', text: String(pending) }), hidden(`, ${pending} waiting`)] : null);
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

/* ---------- airport field with autocomplete (a native datalist fed by the airport search) ---------- */

let listSeq = 0;
function airportField(api, { label, name, value, help }) {
    const listId = `apl-${++listSeq}`;
    const input = textInput(name, value, { maxlength: '40', list: listId, class: 'iata', autocapitalize: 'characters' });
    const dl = h('datalist', { id: listId });
    const hint = h('p', { class: 'help airport-hint', 'aria-live': 'polite' });
    let results = [];
    let timer = null;
    let seq = 0;

    const paint = (rows) => {
        results = rows;
        dl.replaceChildren(...rows.map((a) => h('option', { value: a.iata, label: `${a.city || a.name}, ${a.country}: ${a.name}`, text: `${a.iata} ${a.city || ''} ${a.name}` })));
    };
    const search = async (q) => {
        const mine = ++seq;
        try {
            const res = await api(`/flights/airports?q=${encodeURIComponent(q)}`);
            if (mine === seq) paint(res.airports);
            return res.airports;
        } catch (e) {
            return [];
        }
    };
    const check = async () => {
        const v = input.value.trim();
        if (!v) { hint.textContent = help || ''; return; }
        if (!/^[A-Za-z]{3}$/.test(v)) { hint.textContent = 'Pick an airport from the list or type its 3-letter code.'; return; }
        const code = v.toUpperCase();
        let a = results.find((x) => x.iata === code);
        if (!a) a = (await search(code)).find((x) => x.iata === code);
        hint.textContent = a
            ? `${a.name}, ${a.city || a.country}. Times here are ${a.tz || 'in an unknown zone'}.`
            : `The hub does not know ${code}. It can still be saved, but times cannot be entered for it.`;
        hint.classList.toggle('warn-text', !a);
    };
    input.addEventListener('input', () => {
        clearTimeout(timer);
        const v = input.value.trim();
        if (v.length < 2) { paint([]); return; }
        timer = setTimeout(() => search(v), 150);
    });
    input.addEventListener('change', check);
    input.addEventListener('blur', check);
    hint.textContent = help || '';
    const el = h('div', { class: 'field airport-field' }, h('label', { for: `ff-${name}-${listId}`, text: label }), input, dl, hint);
    input.id = `ff-${name}-${listId}`;
    hint.id = `${input.id}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    if (value) check();
    return {
        el,
        input,
        read() {
            const v = input.value.trim();
            if (!v) return '';
            if (/^[A-Za-z]{3}$/.test(v)) return v.toUpperCase();
            throw fieldError('Type the 3-letter code or pick an airport from the list.', name);
        },
    };
}

/* ---------- booking reference: masked until Show ---------- */

function refField(value) {
    const input = textInput('booking_ref', value, { type: 'password', maxlength: '20', autocapitalize: 'characters' });
    const label = h('span', { text: 'Show' });
    const toggle = h('button', {
        type: 'button', class: 'btn quiet small', 'data-key': 'ref-toggle', 'aria-pressed': 'false', 'aria-label': 'Show the booking reference',
        onclick: () => {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            label.textContent = show ? 'Hide' : 'Show';
            toggle.setAttribute('aria-pressed', String(show));
            toggle.setAttribute('aria-label', show ? 'Hide the booking reference' : 'Show the booking reference');
        },
    }, icon('keys'), label);
    const id = `ff-ref-${++fieldId}`;
    input.id = id;
    return h('div', { class: 'field' },
        h('label', { for: id, text: 'Booking reference' }),
        h('div', { class: 'ref-row' }, input, toggle),
        h('p', { class: 'help', text: 'Hidden by default. Only you and keys with the flights read scope can see it.' }));
}

/* ---------- the flight form (Add, edit in the drawer, check before adding) ---------- */

// The values the form starts from. `f` is a flight, a candidate (candidate: true) or nothing.
function startValues(f, { candidate = false } = {}) {
    const v = Object.fromEntries(FORM_FIELDS.map((k) => [k, '']));
    v.status = 'auto';
    if (!f) return v;
    Object.assign(v, {
        airline_iata: f.airline_iata || '',
        airline_name: f.airline_name || '',
        flight_number: f.flight_number || '',
        origin_iata: f.origin_iata || '',
        dest_iata: f.dest_iata || '',
        sched_dep: f.dep_local || '',
        sched_arr: f.arr_local || '',
        actual_dep: candidate ? '' : localInput(f.actual_dep, f.dep_tz),
        actual_arr: candidate ? '' : localInput(f.actual_arr, f.arr_tz),
        aircraft_type: f.aircraft_type || '',
        cabin: f.cabin || '',
        seat: f.seat || '',
        booking_ref: f.booking_ref || '',
        status: (candidate ? f.flight_status : f.status_override) || 'auto',
        trip_id: !candidate && f.trip_id ? String(f.trip_id) : '',
        notes: f.notes || '',
    });
    // What Automatic resolves to is shown in the select; not a form field, so never sent.
    v.statusOf = { actual_arr: candidate ? null : f.actual_arr, sched_arr: f.sched_arr, sched_dep: f.sched_dep };
    return v;
}

// Empty text becomes null, codes are upper case, the trip is a number.
function clean(v) {
    const t = (s) => (s == null || String(s).trim() === '' ? null : String(s).trim());
    return {
        airline_iata: t(v.airline_iata) && t(v.airline_iata).toUpperCase(),
        airline_name: t(v.airline_name),
        flight_number: t(v.flight_number),
        origin_iata: t(v.origin_iata) && t(v.origin_iata).toUpperCase(),
        dest_iata: t(v.dest_iata) && t(v.dest_iata).toUpperCase(),
        sched_dep: t(v.sched_dep),
        sched_arr: t(v.sched_arr),
        actual_dep: t(v.actual_dep),
        actual_arr: t(v.actual_arr),
        aircraft_type: t(v.aircraft_type),
        cabin: t(v.cabin),
        seat: t(v.seat) && t(v.seat).toUpperCase(),
        booking_ref: t(v.booking_ref) && t(v.booking_ref).toUpperCase(),
        status: v.status || 'auto',
        trip_id: v.trip_id && /^\d+$/.test(String(v.trip_id)) ? Number(v.trip_id) : null,
        notes: t(v.notes),
    };
}

// mode: 'create' sends every filled field, 'edit' and 'accept' send only the fields the person changed (so a time
// they did not touch keeps its instant even when an airport changes).
function flightForm(ctx, { values, trips, mode, submit, onSave, onCancel, onDirty, live }) {
    const base = clean(values);
    const f = {};
    const from = airportField(ctx.api, { label: 'From', name: 'origin_iata', value: values.origin_iata, help: 'Airport code or city.' });
    const to = airportField(ctx.api, { label: 'To', name: 'dest_iata', value: values.dest_iata, help: 'Airport code or city.' });
    const dt = (name, label, help) => { f[name] = textInput(name, values[name], { type: 'datetime-local' }); return field(label, f[name], help); };
    const tx = (name, label, attrs, help) => { f[name] = textInput(name, values[name], attrs); return field(label, f[name], help); };

    const status = h('select', { name: 'status', 'data-key': 'f-status' }, Object.entries(statusChoices(values.statusOf)).map(([k, label]) => h('option', { value: k, text: label })));
    status.value = values.status || 'auto';
    const trip = h('select', { name: 'trip_id', 'data-key': 'f-trip' },
        h('option', { value: '', text: 'No trip' }),
        trips.map((t) => h('option', { value: String(t.id), text: `${t.title}${t.start_date ? ` (${t.start_date})` : ''}` })),
        h('option', { value: '__new', text: 'New trip…' }));
    trip.value = values.trip_id && trips.some((t) => String(t.id) === String(values.trip_id)) ? String(values.trip_id) : '';
    const newTrip = textInput('new_trip', '', { maxlength: '80', placeholder: 'Trip name, for example Spring break' });
    const newTripField = field('New trip name', newTrip, 'Creates the trip and puts this flight on it.');
    newTripField.hidden = true;
    trip.addEventListener('change', () => { newTripField.hidden = trip.value !== '__new'; if (!newTripField.hidden) newTrip.focus(); });
    const ref = refField(values.booking_ref);
    const notes = h('textarea', { name: 'notes', rows: '3', maxlength: '2000', class: 'plain', 'data-key': 'f-notes' });
    notes.value = values.notes || '';

    const error = h('p', { class: 'error', role: 'alert' });
    const save = button({ text: submit, type: 'submit', size: 'small', 'data-key': 'ff-save' });
    // Edit mode only: the live fields (estimated times, terminals, gates, belt, registration) and the lock notes.
    const extra = live ? liveFields(live.flight) : null;

    const current = () => ({
        airline_iata: f.airline_iata.value, airline_name: f.airline_name.value, flight_number: f.flight_number.value,
        origin_iata: from.input.value, dest_iata: to.input.value,
        sched_dep: f.sched_dep.value, sched_arr: f.sched_arr.value, actual_dep: f.actual_dep.value, actual_arr: f.actual_arr.value,
        aircraft_type: f.aircraft_type.value, cabin: f.cabin.value, seat: f.seat.value, booking_ref: ref.querySelector('input').value,
        status: status.value, trip_id: trip.value === '__new' ? '__new' : trip.value, notes: notes.value,
    });
    const dirty = () => {
        const now = clean(current());
        return trip.value === '__new' || FORM_FIELDS.some((k) => now[k] !== base[k]) || Boolean(extra && extra.dirty());
    };

    const group = (title, ...kids) => h('fieldset', { class: 'flight-group' }, h('legend', { text: title }), h('div', { class: 'group-grid' }, kids));
    const form = h('form', {
        class: 'place-form flight-form',
        novalidate: true,
        oninput: () => onDirty && onDirty(),
        onchange: () => onDirty && onDirty(),
        onsubmit: async (event) => {
            event.preventDefault();
            error.replaceChildren();
            save.disabled = true;
            try {
                const origin = from.read();
                const dest = to.read();
                const now = clean({ ...current(), origin_iata: origin, dest_iata: dest });
                if (!now.airline_iata) throw fieldError('Give the airline code, for example AA.', 'airline_iata');
                if (!now.flight_number) throw fieldError('Give the flight number.', 'flight_number');
                if (!now.origin_iata) throw fieldError('Pick the airport it leaves from.', 'origin_iata');
                if (!now.dest_iata) throw fieldError('Pick the airport it lands at.', 'dest_iata');
                if (!now.sched_dep) throw fieldError('Give the departure time.', 'sched_dep');
                if (trip.value === '__new') {
                    const title = newTrip.value.trim();
                    if (!title) throw fieldError('Name the new trip, or pick another option.', 'new_trip');
                    const made = await ctx.api('/flights/trips', { method: 'POST', body: { title } });
                    now.trip_id = made.id;
                }
                let body;
                if (mode === 'create') {
                    body = Object.fromEntries(FORM_FIELDS.filter((k) => now[k] != null).map((k) => [k, now[k]]));
                } else {
                    body = Object.fromEntries(FORM_FIELDS.filter((k) => now[k] !== base[k]).map((k) => [k, now[k]]));
                    if (extra) Object.assign(body, extra.changes());
                }
                await onSave(body, { now });
            } catch (err) {
                if (err.code === 'duplicate' && err.data && err.data.id) {
                    error.replaceChildren('This flight is already in your flights. ', h('a', { class: 'link', href: flightHref(err.data.id), text: 'Open it' }), '.');
                } else error.textContent = err.message;
                const bad = err.field && form.querySelector(`[name="${err.field}"]`);
                if (bad) bad.focus();
                save.disabled = false;
            }
        },
    },
    group('Flight',
        tx('airline_iata', 'Airline code', { maxlength: '3', autocapitalize: 'characters', class: 'iata' }, 'Two or three letters, like AA.'),
        tx('airline_name', 'Airline name', { maxlength: '80' }, 'Optional, for example American.'),
        tx('flight_number', 'Flight number', { maxlength: '5', inputmode: 'numeric' }, 'Digits, like 1234.')),
    group('Route and times',
        from.el, to.el,
        dt('sched_dep', 'Departs', 'The clock at the departure airport.'),
        dt('sched_arr', 'Arrives', 'The clock at the arrival airport. Changing an airport does not move a time you leave alone.')),
    group('Details',
        field('Status', status, 'Automatic is scheduled until the flight has landed, then completed. Cancelled keeps the flight and its history but leaves it out of the Passport.'),
        field('Trip', trip),
        newTripField,
        tx('aircraft_type', 'Aircraft', { maxlength: '40' }, 'For example B738.'),
        tx('cabin', 'Cabin', { maxlength: '30' }),
        tx('seat', 'Seat', { maxlength: '8' }),
        ref,
        h('div', { class: 'wide-field' }, field('Notes', notes))),
    h('details', { class: 'flight-extra', open: Boolean(live && (values.actual_dep || values.actual_arr || (live.flight.locked_fields || []).some((k) => k === 'actual_dep' || k === 'actual_arr'))) },
        h('summary', { text: 'Actual times (optional)' }),
        h('div', { class: 'group-grid' },
            dt('actual_dep', 'Actual departure', 'The clock at the departure airport.'),
            dt('actual_arr', 'Actual arrival', 'The clock at the arrival airport.'))),
    extra ? extra.el : null,
    error,
    h('div', { class: 'row' }, save, onCancel ? button({ text: 'Cancel', variant: 'quiet', size: 'small', onClick: onCancel }) : null));
    if (live) addLockNotes(form, live.flight.locked_fields || [], live.onUnlock);
    return { el: form, dirty, save };
}

/* ---------- compare two revisions ---------- */

// Live details lines, only for a flight that has any (older flights keep their old compare view).
function liveSnapshot(f) {
    const times = [['est_dep', f.dep_tz], ['est_arr', f.arr_tz]].filter(([k]) => f[k]).map(([k, tz]) => `${LIVE_TITLE[k]}: ${localInputValue(f[k], tz).replace('T', ' ')}`);
    const text = ['dep_terminal', 'dep_gate', 'arr_terminal', 'arr_gate', 'baggage_belt', 'aircraft_reg'].filter((k) => f[k]).map((k) => `${LIVE_TITLE[k]}: ${f[k]}`);
    return [...times, ...text, ...(f.delay_min != null ? [`Delay: ${f.delay_min} min`] : [])];
}

function snapshotLines(f, tripName) {
    return [
        `Flight: ${flightName(f)}${f.airline_name ? `, ${f.airline_name}` : ''}`,
        `Route: ${f.origin_iata} to ${f.dest_iata}`,
        `Departs: ${f.dep_local ? f.dep_local.replace('T', ' ') : 'not set'}`,
        `Arrives: ${f.arr_local ? f.arr_local.replace('T', ' ') : 'not set'}`,
        `Actual departure: ${f.actual_dep ? localInput(f.actual_dep, f.dep_tz).replace('T', ' ') : 'none'}`,
        `Actual arrival: ${f.actual_arr ? localInput(f.actual_arr, f.arr_tz).replace('T', ' ') : 'none'}`,
        `Status: ${STATUS[f.status] || f.status}${f.status_override ? ' (set by hand)' : ' (automatic)'}`,
        `Trip: ${f.trip_id ? tripName(f.trip_id) : 'none'}`,
        `Aircraft: ${f.aircraft_type || 'none'}`,
        ...liveSnapshot(f),
        `Cabin: ${f.cabin || 'none'}`,
        `Seat: ${f.seat || 'none'}`,
        `Booking reference: ${f.booking_ref ? 'set' : 'none'}`,
        `Notes: ${f.notes || 'none'}`,
    ];
}

function diffLines(older, newer, tripName) {
    const a = snapshotLines(older, tripName);
    const b = snapshotLines(newer, tripName);
    if (older.booking_ref && newer.booking_ref && older.booking_ref !== newer.booking_ref) {
        a[a.length - 2] += ' (older value)';
        b[b.length - 2] += ' (changed)';
    }
    return [...a.filter((l) => !b.includes(l)).map((l) => ['del', l]), ...b.map((l) => [a.includes(l) ? 'same' : 'add', l])];
}

/* ---------- the flight drawer ---------- */

function closeDrawerTo(fromList) {
    if (fromList && history.length > 1) history.back();
    else navigate(href('flights', [], { tab: 'flights' }), { replace: true });
}

function flightDrawer(ctx, id, fromList, mark) {
    let flight = null;
    let trips = [];
    let sources = null;      // pull and push sources (null when they could not load)
    let lastRefresh = null;  // the answer of the last Refresh, shown under the button until the drawer closes
    let form = null;
    const tripName = (tid) => (trips.find((t) => t.id === tid) || { title: `trip ${tid}` }).title;

    const handle = openDrawer({
        title: 'Flight',
        subtitle: 'Loading…',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard your changes?', body: 'The flight keeps what was last saved.', confirm: 'Discard', danger: true }),
        onClose: () => {
            const mine = drawer && drawer.handle === handle;
            if (mine) { drawer = null; closeDrawerTo(fromList); }
        },
        returnFocus: () => document.querySelector(`[data-key="flight:${id}"]`) || document.querySelector('[data-key="new-flight"]'),
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
            [flight, trips, sources] = await Promise.all([ctx.api(`/flights/${id}`), ctx.api('/flights/trips').then((r) => r.trips),
                ctx.api('/flights/sources').then((r) => r.sources).catch(() => null)]);
        } catch (err) {
            if (err.status === 401) return;
            if (err.status === 404) {
                toast('That flight is gone or never existed.', { kind: 'info' });
                drawer = null;
                handle.close(true);
                closeDrawerTo(fromList);
                return;
            }
            handle.setTitle('Flight', '');
            handle.setContent(errorState({ err, what: 'This flight', retry: () => load(key) }));
            return;
        }
        handle.setTitle(`${flightName(flight)}  ${flight.origin_iata} to ${flight.dest_iata}`, `${day(flight.dep_local_date)}, ${STATUS[flight.status].toLowerCase()}, revision ${flight.rev}`);
        handle.setContent(content());
        handle.body.scrollTop = top;
        if (key) focusKey(key);
    }

    function details() {
        form = flightForm(ctx, {
            values: startValues(flight),
            trips,
            mode: 'edit',
            live: { flight, onUnlock: unlock },
            submit: 'Save changes',
            onSave: async (body) => {
                if (!Object.keys(body).length) { toast('Nothing changed', { kind: 'info' }); form.save.disabled = false; return; }
                const res = await ctx.api(`/flights/${flight.id}`, { method: 'PATCH', body });
                toast(res.status === 'unchanged' ? 'Nothing changed' : 'Changes saved', { kind: res.status === 'unchanged' ? 'info' : 'good' });
                form = null;
                await changed('ff-save');
            },
        });
        return form.el;
    }

    async function unlock(name) {
        if (form && form.dirty() && !(await confirmDialog({ title: 'Discard your changes?', body: 'Unlocking reloads the flight. What you typed and did not save is lost.', confirm: 'Unlock and discard', danger: true }))) return;
        try {
            await ctx.api(`/flights/${flight.id}`, { method: 'PATCH', body: { unlock: [name] } });
            toast(`${LIVE_TITLE[name] || name} unlocked: sources may fill it again`);
            form = null;
            await changed(`f-${name}`);
        } catch (err) {
            toast(`Could not unlock. ${err.message}`, { kind: 'bad' });
        }
    }

    const sourceLabel = (name) => ((sources || []).find((s) => s.name === name) || { label: name }).label;

    async function refresh(force) {
        if (form && form.dirty() && !(await confirmDialog({ title: 'Discard your changes?', body: 'Refreshing reloads the flight. What you typed and did not save is lost.', confirm: 'Refresh and discard', danger: true }))) return;
        try {
            const res = await ctx.api(`/flights/${flight.id}/refresh`, { method: 'POST', body: force ? { force: true } : {} });
            lastRefresh = res;
            toast(res.status === 'updated' ? `Refreshed: ${res.fields.length ? res.fields.map((k) => (LIVE_TITLE[k] || k).toLowerCase()).join(', ') : 'updated'}` : res.results.length ? 'Refreshed, nothing new' : 'No source is switched on', { kind: res.status === 'updated' ? 'good' : 'info' });
            form = null;
            await changed('refresh-flight');
        } catch (err) {
            if (err.status !== 401) toast(`Could not refresh. ${err.message}`, { kind: 'bad' });
        }
    }

    async function restore(rev) {
        const ok = await confirmDialog({
            title: `Restore revision ${rev}?`,
            body: `The fields of revision ${rev} become current, as a new revision. What you see now stays in the history.`,
            confirm: 'Restore',
        });
        if (!ok) return;
        try {
            const res = await ctx.api(`/flights/${flight.id}/restore`, { method: 'POST', body: { rev } });
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
            const older = await ctx.api(`/flights/${flight.id}?rev=${rev}`);
            const parts = diffLines(older, flight, tripName);
            const changedN = parts.filter(([k]) => k !== 'same').length;
            const back = button({ text: 'Back to the flight', variant: 'ghost', size: 'small', iconName: 'prev', onClick: () => load('history') });
            handle.setTitle(`${flightName(flight)}  ${flight.origin_iata} to ${flight.dest_iata}`, `Revision ${rev} and the current one`);
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
        const cancel = flight.status === 'cancelled' ? null : button({ text: 'Cancel this flight', variant: 'danger', iconName: 'close', 'data-key': 'cancel-flight', onClick: async () => {
            const ok = await confirmDialog({
                title: `Cancel ${flightName(flight)}?`,
                body: ['The flight stays in your list and its history, marked Cancelled, and leaves the Passport.', 'You can set the status back at any time.'],
                confirm: 'Cancel the flight',
                danger: true,
            });
            if (!ok) return;
            try {
                await ctx.api(`/flights/${flight.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
                toast(`${flightName(flight)} cancelled`);
                form = null;
                changed('history');
            } catch (err) {
                toast(`Could not cancel the flight. ${err.message}`, { kind: 'bad' });
            }
        } });

        return [
            h('section', { class: 'drawer-section', 'aria-labelledby': 'fd-live' },
                h('h3', { id: 'fd-live', text: 'Live details' }),
                liveDetails(flight),
                refreshBar({ sources, lastResult: lastRefresh, labelOf: sourceLabel, onRefresh: refresh })),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'fd-details' },
                h('h3', { id: 'fd-details', text: 'Details' }),
                details(),
                h('dl', { class: 'facts' },
                    fact('Distance', flight.distance_km != null ? `${distanceText(flight.distance_km, 'km')} (${distanceText(flight.distance_km, 'mi')})` : 'Unknown: the hub does not know both airports'),
                    fact('Zones', `${flight.dep_tz || 'unknown'} to ${flight.arr_tz || 'unknown'}`),
                    fact('Source', SOURCE[flight.source] || cap(flight.source)),
                    fact('Added', when(flight.created_at)),
                    fact('Last changed', `${ago(flight.updated_at)} by ${actorName(flight.updated_by)}`))),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'fd-history' },
                h('h3', { id: 'fd-history', tabindex: '-1', 'data-key': 'history', text: `History, ${plural(flight.history.length, 'revision')}` }),
                h('p', { class: 'note', text: 'Every change is kept. Restoring adds a new revision, so nothing is lost.' }),
                h('ol', { class: 'rev-list', reversed: true }, flight.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
                    h('div', { class: 'rev-main' },
                        h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                        h('p', { class: 'rev-what', text: `${{ create: 'Created', edit: 'Edited', restore: 'Restored' }[r.source] || cap(r.source)} by ${actorName(r.actor)}${r.note ? `: ${r.note}` : ''}.` }),
                        h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
                    r.current ? null : h('div', { class: 'rev-actions' },
                        button({ text: 'Compare', variant: 'quiet', size: 'small', label: `Compare revision ${r.rev} with the current one`, onClick: () => compare(r.rev) }),
                        button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) })))))),
            h('section', { class: 'drawer-section danger-zone' },
                h('p', { class: 'note', text: flight.status === 'cancelled' ? 'This flight is cancelled. Set the status above to bring it back.' : 'A flight is never deleted. Cancelling keeps it and its history but takes it out of the Passport.' }),
                cancel),
        ];
    }

    mark.handle = handle;
    load();
}

// Opens, keeps or closes the drawer so it matches the URL.
function syncDrawer(ctx) {
    const raw = ctx.route.parts[0];
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (raw && !id) { navigate(href('flights'), { replace: true }); return; }
    if ((drawer ? drawer.id : null) === id) return;
    if (drawer) { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
    if (!id) return;
    // Claim the id at once: a second render before the timer fires must not open a second drawer.
    const mark = { id, handle: null, fromList: lastWasList };
    drawer = mark;
    setTimeout(() => { if (drawer === mark) flightDrawer(ctx, id, mark.fromList, mark); }, 0);
}

/* ---------- Add flight, and Check before adding (a found flight) ---------- */

function closeSide(force = true) {
    if (side) { const s = side; side = null; s.close(force); }
}

async function addFlight(ctx) {
    if (side) return;
    let trips;
    try {
        trips = (await ctx.api('/flights/trips')).trips;
    } catch (err) {
        if (err.status !== 401) toast(`Could not open the form. ${err.message}`, { kind: 'bad' });
        return;
    }
    let form = null;
    const handle = openDrawer({
        title: 'Add a flight',
        subtitle: 'Times are the clock at each airport.',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard this flight?', body: 'Nothing has been saved yet.', confirm: 'Discard', danger: true }),
        onClose: () => { if (side === handle) side = null; },
        returnFocus: () => document.querySelector('[data-key="new-flight"]'),
    });
    side = handle;
    form = flightForm(ctx, {
        values: startValues(null),
        trips,
        mode: 'create',
        submit: 'Add flight',
        onCancel: () => handle.close(),
        onSave: async (body) => {
            const res = await ctx.api('/flights', { method: 'POST', body });
            toast(`Flight ${res.label} added`);
            form = null;
            side = null;
            handle.close(true);
            navigate(flightHref(res.id));
        },
    });
    handle.setContent(form.el);
    const first = handle.body.querySelector('input');
    if (first) first.focus();
}

async function checkAndAccept(ctx, c) {
    if (side) return;
    let trips;
    try {
        trips = (await ctx.api('/flights/trips')).trips;
    } catch (err) {
        if (err.status !== 401) toast(`Could not open the form. ${err.message}`, { kind: 'bad' });
        return;
    }
    let form = null;
    const handle = openDrawer({
        title: 'Check before adding',
        subtitle: `${c.label}, found ${ago(c.created_at)}`,
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard your changes?', body: 'The found flight stays in the queue as it was found.', confirm: 'Discard', danger: true }),
        onClose: () => { if (side === handle) side = null; },
        returnFocus: () => document.querySelector(`[data-key="q:${c.id}:edit"]`) || document.querySelector('[data-key="tab:found"]'),
    });
    side = handle;
    form = flightForm(ctx, {
        values: startValues(c, { candidate: true }),
        trips,
        mode: 'accept',
        submit: 'Add to my flights',
        onCancel: () => handle.close(),
        onSave: async (body) => {
            const res = await ctx.api(`/flights/candidates/${c.id}/accept`, { method: 'POST', body });
            toast(`Flight ${res.flight.label} added`);
            form = null;
            side = null;
            handle.close(true);
            focusAfter = 'tab:found';
            ctx.rerender();
        },
    });
    handle.setContent(
        h('p', { class: 'note', text: `Found ${SOURCE[c.source] ? SOURCE[c.source].replace('Found ', '') : c.source}${c.confidence != null ? `, confidence ${Math.round(c.confidence * 100)}%` : ''}. Change anything that is wrong; whatever you leave alone is added as found.` }),
        form.el);
    const first = handle.body.querySelector('input');
    if (first) first.focus();
}

/* ---------- home airport ---------- */

async function homeDialog(ctx, current) {
    const home = airportField(ctx.api, { label: 'Home airport', name: 'home_airport', value: current || '', help: 'Where most of your trips start. Leave empty to clear it.' });
    const saved = await formDialog({
        title: 'Home airport',
        intro: 'It marks your home on the Passport map. It must be an airport the hub knows.',
        fields: [home.el],
        submit: 'Save',
        onSubmit: async () => {
            const code = home.read();
            const res = await ctx.api('/flights/settings', { method: 'PUT', body: { home_airport: code || null } });
            return res;
        },
    });
    if (!saved) return false;
    toast(saved.home_airport ? `Home airport set to ${saved.home_airport}` : 'Home airport cleared');
    return true;
}

/* ---------- Flights tab ---------- */

function statusChip(status) {
    return h('span', { class: `chip status-chip is-${status}` }, h('span', { text: STATUS[status] || status }));
}

function flightRow(f, unit) {
    const link = h('a', { class: 'row-link', href: flightHref(f.id), 'data-key': `flight:${f.id}` }, day(f.dep_local_date));
    const live = rowExtras(f);
    return h('tr', { onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('td', { class: 'cell-main' }, link, f.dep_local ? h('span', { class: 'muted', text: ` ${clock(f.dep_local)}` }) : null),
        h('td', { 'data-label': 'Route' }, h('span', { class: 'route' }, f.origin_iata, h('span', { class: 'route-arrow', 'aria-hidden': 'true', text: '→' }), hidden(' to '), f.dest_iata), live.gate),
        h('td', { 'data-label': 'Flight' }, flightName(f), f.airline_name ? h('span', { class: 'muted', text: ` ${f.airline_name}` }) : null),
        h('td', { 'data-label': 'Aircraft', class: f.aircraft_type ? '' : 'is-empty', text: f.aircraft_type || '' }),
        h('td', { 'data-label': 'Status' }, statusChip(f.status), live.delay),
        h('td', { 'data-label': 'Distance', class: f.distance_km != null ? 'num' : 'num is-empty', text: f.distance_km != null ? distanceText(f.distance_km, unit) : '' }),
        h('td', { class: 'cell-side only-narrow' }, h('a', { class: 'btn ghost icon-only', href: flightHref(f.id), tabindex: '-1', 'aria-hidden': 'true' }, icon('next'))));
}

function flightsTable(rows, unit) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'stack flights-table' },
        h('thead', {}, h('tr', {},
            h('th', { scope: 'col', text: 'Date' }),
            h('th', { scope: 'col', text: 'Route' }),
            h('th', { scope: 'col', text: 'Flight' }),
            h('th', { scope: 'col', text: 'Aircraft' }),
            h('th', { scope: 'col', text: 'Status' }),
            h('th', { scope: 'col', class: 'num', text: unit === 'mi' ? 'Miles' : 'Kilometres' }))),
        h('tbody', {}, rows.map((f) => flightRow(f, unit)))));
}

function upcomingStrip(list) {
    if (!list.length) return null;
    return h('section', { class: 'upcoming', 'aria-labelledby': 'up-title' },
        h('h2', { id: 'up-title', class: 'section-title', text: 'Upcoming' }),
        h('ul', { class: 'up-list' }, list.map((f) => h('li', {},
            h('a', { class: 'up-card', href: flightHref(f.id), 'data-key': `up:${f.id}` },
                h('span', { class: 'up-when' }, h('strong', { text: localDay(f.dep_local) }), ` ${clock(f.dep_local)}`, h('span', { class: 'muted', text: ` ${until(f)}` })),
                h('span', { class: 'up-route' }, f.origin_iata, h('span', { class: 'route-arrow', 'aria-hidden': 'true', text: '→' }), hidden(' to '), f.dest_iata),
                h('span', { class: 'muted', text: `${flightName(f)}${f.status === 'scheduled' ? '' : `, ${STATUS[f.status].toLowerCase()}`}` }))))));
}

function select(label, name, value, options, onChange) {
    const sel = h('select', { name, 'data-key': `flt:${name}`, 'aria-label': label }, h('option', { value: '', text: `${label}: all` }), options.map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
}

function flightsTab(ctx, data, upcoming, trips, home, sources) {
    const q = ctx.route.query;
    const unit = getUnit();
    const f = { year: q.get('year') || '', airport: q.get('airport') || '', airline: q.get('airline') || '', status: q.get('status') || '', q: (q.get('q') || '').trim() };
    const all = data.flights;
    const years = [...new Set(all.map((x) => x.dep_local_date.slice(0, 4)))].sort().reverse();
    const airports = [...new Set(all.flatMap((x) => [x.origin_iata, x.dest_iata]))].sort();
    const airlines = [...new Map(all.map((x) => [x.airline_iata, x.airline_name])).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const needle = f.q.toLowerCase();
    const shown = all.filter((x) => (!f.year || x.dep_local_date.startsWith(f.year))
        && (!f.airport || x.origin_iata === f.airport || x.dest_iata === f.airport)
        && (!f.airline || x.airline_iata === f.airline)
        && (!f.status || x.status === f.status)
        && (!needle || [flightName(x), `${x.airline_iata}${x.flight_number}`, x.airline_name, x.origin_iata, x.dest_iata, x.aircraft_type, x.cabin, x.dep_local_date,
            (trips.find((t) => t.id === x.trip_id) || {}).title].some((t) => t && String(t).toLowerCase().includes(needle))));

    const go = (patch) => navigate(href('flights', [], { tab: 'flights', year: f.year, airport: f.airport, airline: f.airline, status: f.status, q: f.q, ...patch }));
    const filters = h('div', { class: 'filters' },
        select('Year', 'year', f.year, years.map((y) => [y, y]), (v) => go({ year: v })),
        select('Airport', 'airport', f.airport, airports.map((a) => [a, a]), (v) => go({ airport: v })),
        select('Airline', 'airline', f.airline, airlines.map(([c, n]) => [c, n ? `${c} ${n}` : c]), (v) => go({ airline: v })),
        select('Status', 'status', f.status, Object.entries(STATUS), (v) => go({ status: v })));
    const search = h('input', { type: 'search', name: 'q', value: f.q, placeholder: 'Search flights', 'aria-label': 'Search flights by number, airline, airport, aircraft or trip', 'data-key': 'f-search', enterkeyhint: 'search' });
    const searchForm = h('form', { class: 'search-form', role: 'search', onsubmit: (event) => { event.preventDefault(); go({ q: search.value.trim() }); } },
        icon('search', 'search-icon'), search,
        f.q ? h('a', { class: 'btn ghost small', href: href('flights', [], { tab: 'flights', year: f.year, airport: f.airport, airline: f.airline, status: f.status }), text: 'Clear' }) : null);
    const filtered = Boolean(f.year || f.airport || f.airline || f.status || f.q);

    let body;
    if (!all.length) {
        body = emptyState({
            title: 'No flights yet.',
            text: 'Add one, or review found flights if a job has filed some.',
            iconName: 'flights',
            action: button({ text: 'Add flight', size: 'small', iconName: 'plus', 'data-key': 'empty-new', onClick: () => addFlight(ctx) }),
        });
    } else if (!shown.length) {
        body = emptyState({
            title: 'No flight matches.',
            text: 'Try other words or clear a filter.',
            iconName: 'search',
            action: h('a', { class: 'btn quiet small', href: href('flights', [], { tab: 'flights' }), text: 'Show every flight' }),
        });
    } else body = flightsTable(shown, unit);

    const homeRow = h('section', { class: 'panel home-row', 'aria-label': 'Home airport' },
        icon('flights'),
        h('p', {}, 'Home airport: ', home
            ? [h('strong', { text: home.iata }), home.name ? ` ${home.name}${home.city ? `, ${home.city}` : ''}` : '']
            : h('span', { class: 'muted', text: 'not set' })),
        button({ text: home ? 'Change' : 'Set it', variant: 'quiet', size: 'small', 'data-key': 'home-edit', onClick: async () => { if (await homeDialog(ctx, home && home.iata)) { focusAfter = 'home-edit'; ctx.rerender(); } } }));

    return h('div', { class: 'tab-panel', id: 'panel-flights', role: 'tabpanel', 'aria-labelledby': 'tab-flights' },
        upcomingStrip(upcoming),
        all.length ? h('div', { class: 'toolbar filter-bar' }, filters, searchForm) : null,
        h('section', { 'aria-labelledby': all.length ? 'f-count' : null, 'aria-label': all.length ? null : 'Flights', class: 'flights-list' },
            all.length ? h('h2', { id: 'f-count', class: 'section-title', text: filtered ? `${shown.length} of ${plural(all.length, 'flight')}` : plural(all.length, 'flight') }) : null,
            data.total > all.length ? h('p', { class: 'note', text: `Showing the newest ${all.length} of ${data.total.toLocaleString()} flights.` }) : null,
            body),
        homeRow,
        sources ? sourcesCard(ctx, sources) : null);
}

/* ---------- Found flights tab ---------- */

const confidenceWord = (c) => (c == null ? 'Confidence not given' : `Confidence ${Math.round(c * 100)}%, ${c >= 0.8 ? 'high' : c >= 0.5 ? 'medium' : 'low'}`);

function queueItem(ctx, c, { next }) {
    const decided = c.status !== 'pending';
    const after = () => { focusAfter = next; ctx.rerender(); };

    const accept = button({ text: 'Accept', size: 'small', 'data-key': `q:${c.id}:accept`, label: `Accept ${c.label}`, onClick: async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        try {
            await ctx.api(`/flights/candidates/${c.id}/accept`, { method: 'POST', body: {} });
            toast(`Flight ${c.label} added`);
            after();
        } catch (err) {
            btn.disabled = false;
            if (err.code === 'duplicate' || err.code === 'already_accepted') toast(`${c.label} is already in your flights.`, { kind: 'info' });
            else toast(`Could not add ${c.label}. ${err.message}`, { kind: 'bad' });
        }
    } });
    const edit = button({ text: 'Edit and accept', variant: 'quiet', size: 'small', 'data-key': `q:${c.id}:edit`, label: `Edit ${c.label} before adding it`, onClick: () => checkAndAccept(ctx, c) });
    const dismiss = c.status === 'dismissed' ? null : button({ text: 'Dismiss', variant: 'ghost', size: 'small', 'data-key': `q:${c.id}:dismiss`, label: `Dismiss ${c.label}`, onClick: async () => {
        const ok = await confirmDialog({
            title: 'Dismiss this found flight?',
            body: ['It leaves the queue and stays dismissed: if it is found again it is not filed twice.', 'You can still add it from Dismissed.'],
            confirm: 'Dismiss',
        });
        if (!ok) return;
        try {
            await ctx.api(`/flights/candidates/${c.id}/dismiss`, { method: 'POST' });
            toast('Found flight dismissed');
            after();
        } catch (err) {
            toast(`Could not dismiss it. ${err.message}`, { kind: 'bad' });
        }
    } });

    const times = [c.dep_local ? `Departs ${localDay(c.dep_local)} ${clock(c.dep_local)}` : null, c.arr_local ? `arrives ${clock(c.arr_local)}` : null].filter(Boolean).join(', ');
    return h('li', { class: `queue-item is-${c.status}`, 'data-id': String(c.id) },
        h('div', { class: 'q-main' },
            h('h3', { class: 'q-street' }, `${flightName(c)}  ${c.origin_iata} to ${c.dest_iata}`, ' ', h('span', { class: 'muted', text: day(c.dep_local_date) })),
            h('dl', { class: 'q-facts' },
                fact('Times', times || 'no times found'),
                fact('Airline', c.airline_name || c.airline_iata),
                c.aircraft_type ? fact('Aircraft', c.aircraft_type) : null,
                c.cabin || c.seat ? fact('Seat', [c.cabin, c.seat].filter(Boolean).join(' ')) : null),
            h('p', { class: 'q-chips' },
                chip(confidenceWord(c.confidence), { cls: c.confidence != null && c.confidence < 0.5 ? 'chip-exclude' : '' }),
                chip(SOURCE[c.source] || c.source),
                c.flight_status ? chip(STATUS[c.flight_status] || c.flight_status, { cls: c.flight_status === 'cancelled' ? 'chip-exclude' : '' }) : null,
                c.booking_ref ? chip('Booking reference found') : null,
                h('span', { class: 'muted', text: `Found ${ago(c.created_at)}` })),
            decided ? h('p', { class: 'q-status' },
                c.status === 'accepted'
                    ? ['Added ', c.decided_at ? ago(c.decided_at) : '', c.accepted_flight_id ? [': ', h('a', { class: 'link', href: flightHref(c.accepted_flight_id), text: 'open the flight' })] : '']
                    : `Dismissed ${c.decided_at ? ago(c.decided_at) : ''}`) : null),
        c.status === 'accepted' ? null : h('div', { class: 'q-actions' }, accept, edit, dismiss));
}

async function acceptAllShown(ctx, shown) {
    const ids = shown.slice(0, 100).map((c) => c.id);
    const byId = new Map(shown.map((c) => [c.id, c]));
    const ok = await confirmDialog({
        title: `Accept ${plural(ids.length, 'found flight')}?`,
        body: [`Adds ${ids.length === 1 ? 'it' : 'all of them'} to your flights, exactly as found. Each one is checked on its own: a flight that is already in your flights is skipped and stays in the queue.`,
            shown.length > 100 ? 'Only the first 100 are accepted at a time; run it again for the rest.' : null],
        confirm: ids.length === 1 ? 'Accept it' : `Accept ${ids.length}`,
    });
    if (!ok) return;
    try {
        const res = await ctx.api('/flights/candidates/accept-all', { method: 'POST', body: { ids } });
        if (res.accepted) toast(`${plural(res.accepted, 'flight')} added`);
        const failed = res.results.filter((r) => r.status !== 'accepted');
        failed.slice(0, 5).forEach((r) => {
            const label = (byId.get(r.id) || {}).label || `Found flight ${r.id}`;
            if (r.error === 'duplicate' || r.error === 'already_accepted') toast(`${label} is already in your flights.`, { kind: 'info' });
            else toast(`${label}: ${r.message}`, { kind: 'bad' });
        });
        if (failed.length > 5) toast(`${plural(failed.length - 5, 'more found flight')} could not be added.`, { kind: 'bad' });
        focusAfter = 'tab:found';
        ctx.rerender();
    } catch (err) {
        toast(`Could not accept them. ${err.message}`, { kind: 'bad' });
    }
}

function foundTab(ctx, cand, show) {
    const counts = cand.counts;
    const total = counts.pending + counts.accepted + counts.dismissed;
    const nav = chipNav({
        label: 'Which found flights',
        current: show,
        items: SHOW.map(([id, label]) => ({
            id,
            label: `${label} ${id === 'all' ? total : counts[id]}`,
            href: href('flights', [], { tab: 'found', show: id === 'pending' ? null : id }),
        })),
    });
    const list = cand.candidates;
    const keyFor = (i) => {
        const n = list[i + 1] || list[i - 1];
        return n ? `q:${n.id}:accept` : 'tab:found';
    };
    const pendingShown = list.filter((c) => c.status === 'pending');
    let body;
    if (!list.length) {
        body = show === 'pending'
            ? emptyState({
                title: 'Nothing waiting.',
                text: 'Flights a job or an agent finds in your email or calendar show up here for your yes.',
                iconName: 'good',
                action: counts.dismissed || counts.accepted
                    ? h('a', { class: 'btn quiet small', href: href('flights', [], { tab: 'found', show: 'all' }), text: 'See the ones already decided' })
                    : h('a', { class: 'btn quiet small', href: tabHref('flights'), text: 'Open your flights' }),
            })
            : emptyState({
                title: { accepted: 'No found flight has been added yet.', dismissed: 'No found flight has been dismissed.', all: 'The queue has never had a found flight.' }[show],
                text: 'Found flights arrive when a job or an agent files them.',
                iconName: 'info',
                action: h('a', { class: 'btn quiet small', href: href('flights', [], { tab: 'found' }), text: 'Back to waiting' }),
            });
    } else body = h('ul', { class: 'queue-list' }, list.map((c, i) => queueItem(ctx, c, { next: keyFor(i) })));

    return h('div', { class: 'tab-panel', id: 'panel-found', role: 'tabpanel', 'aria-labelledby': 'tab-found' },
        h('p', { class: 'note', text: 'Flights a job or an agent found in your email or calendar, newest flight first. Accept one to add it to your flights, fix it first, or dismiss it.' }),
        h('div', { class: 'toolbar' }, nav,
            show === 'pending' && pendingShown.length > 1
                ? button({ text: `Accept all shown (${pendingShown.length})`, variant: 'quiet', size: 'small', iconName: 'check', 'data-key': 'accept-all', onClick: () => acceptAllShown(ctx, pendingShown) })
                : null),
        h('section', { 'aria-labelledby': 'q-count', class: 'queue' },
            h('h2', { id: 'q-count', class: 'section-title', text: show === 'pending' ? `${plural(list.length, 'found flight')} waiting` : plural(list.length, 'found flight') }),
            body));
}

/* ---------- view ---------- */

export async function render(ctx) {
    const q = ctx.route.query;
    const idRaw = ctx.route.parts[0];
    const asked = q.get('tab') === 'queue' ? 'found' : q.get('tab');
    const tab = idRaw || q.get('new') === '1' ? 'flights' : TABS.some(([id]) => id === asked) ? asked : 'passport';
    const show = SHOW.some(([id]) => id === q.get('show')) ? q.get('show') : 'pending';
    const year = /^\d{4}$/.test(q.get('year') || '') ? q.get('year') : null;

    const [cand, stats, list, upcoming, trips, settings, sources] = await Promise.all([
        ctx.api(`/flights/candidates?status=${tab === 'found' ? show : 'pending'}&limit=${tab === 'found' ? 200 : 1}`),
        tab === 'passport' ? ctx.api(`/flights/stats${year ? `?year=${year}` : ''}`) : null,
        tab === 'flights' ? ctx.api('/flights?limit=500') : null,
        tab === 'flights' ? ctx.api('/flights/upcoming?limit=3') : null,
        tab === 'flights' ? ctx.api('/flights/trips') : null,
        tab === 'flights' ? ctx.api('/flights/settings') : null,
        tab === 'flights' ? ctx.api('/flights/sources').catch(() => null) : null,
    ]);
    let home = null;
    if (settings && settings.home_airport) {
        const found = await ctx.api(`/flights/airports?q=${encodeURIComponent(settings.home_airport)}`).catch(() => ({ airports: [] }));
        home = found.airports.find((a) => a.iata === settings.home_airport) || { iata: settings.home_airport };
    }
    const pending = cand.counts.pending;

    syncDrawer(ctx);
    lastWasList = !idRaw;
    ctx.onCleanup(() => {
        if (drawer && parse().name !== 'flights') { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
        if (side && parse().name !== 'flights') closeSide();
    });
    if (q.get('new') === '1' && !idRaw) {
        navigate(href('flights', [], { tab: 'flights' }), { replace: true });
        setTimeout(() => addFlight(ctx), 0);
    }
    if (focusAfter) {
        const key = focusAfter;
        focusAfter = null;
        setTimeout(() => {
            const el = document.querySelector(`[data-key="${key}"]`) || document.querySelector('[data-key="tab:found"]');
            if (el) el.focus();
        }, 0);
    }

    const add = button({ text: 'Add flight', iconName: 'plus', 'data-key': 'new-flight', onClick: () => addFlight(ctx) });
    let panel;
    if (tab === 'passport') {
        panel = passportTab(ctx, stats, {
            year,
            unit: getUnit(),
            pending,
            links: {
                year: (y) => (y ? href('flights', [], { year: y }) : href('flights')),
                add: button({ text: 'Add flight', size: 'small', iconName: 'plus', 'data-key': 'empty-new', onClick: () => addFlight(ctx) }),
                found: h('a', { class: 'btn quiet small', href: tabHref('found'), text: `Review ${plural(pending, 'found flight')}` }),
            },
        });
    } else if (tab === 'flights') panel = flightsTab(ctx, list, upcoming.flights, trips.trips, home, sources);
    else panel = foundTab(ctx, cand, show);

    return h('div', { class: 'view flights' },
        h('div', { class: 'view-intro row-between' },
            h('p', { class: 'lede', text: 'Your flight history and what is coming up. The Passport sums it up; found flights are ones a job or an agent spotted that wait for your yes.' }),
            add),
        tabBar(tab, pending),
        panel);
}
