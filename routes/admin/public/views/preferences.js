// Preferences: plain facts about how you like things (seat, call hours, favourite airline), grouped by area.
//   #/preferences                the list, grouped by area (?q= narrows it)
//   #/preferences?removed=1      removed preferences, each with Restore
//   #/preferences/12             that preference's drawer: edit, history (restore), remove
//   #/preferences?new=1          the Add preference drawer (the palette uses it)
// Only plain facts live here: the hub refuses anything that looks like a password, a long number or a key, and the
// reason is shown next to the field. Remove hides a preference and keeps its history; nothing is ever deleted.
// Server text goes in as text.
import {
    h, icon, button, plural, ago, when, emptyState, errorState, toast, confirmDialog, openDrawer, actorName,
} from '../ui.js';
import { href, navigate, parse } from '../router.js';

const AREAS = [['travel', 'Travel'], ['communication', 'Communication'], ['work', 'Work'], ['food', 'Food'], ['health', 'Health'],
    ['devices', 'Devices'], ['home', 'Home'], ['other', 'Other']];
const AREA = Object.fromEntries(AREAS);
const EXAMPLES = [
    { label: 'Seat preference: aisle', area: 'travel', key: 'seat_preference', value: 'aisle' },
    { label: 'No calls before 10 am', area: 'communication', key: 'call_hours', value: 'No calls before 10 am' },
    { label: 'Preferred airline: American', area: 'travel', key: 'preferred_airline', value: 'American' },
];
const HINT = 'Plain facts only: no passwords, numbers or keys.';
const FIELDS = ['area', 'key', 'value', 'notes'];

const prefHref = (id) => href('preferences', [String(id)]);
const words = (key) => String(key || '').replace(/_/g, ' ');
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '');
const fieldError = (message, name) => Object.assign(new Error(message), { field: name });

let drawer = null;        // { id, handle, fromList } the item drawer that matches the URL
let side = null;          // the Add preference drawer (not in the URL)
let lastWasList = false;  // the previous render was the plain list (closing the drawer can go back)
let focusAfter = null;    // a data-key to focus once the next render is on screen

/* ---------- the form (Add, and edit in the drawer) ---------- */

let fieldId = 0;
function field(label, input, help) {
    const id = input.id || `pf-${++fieldId}`;
    input.id = id;
    const helpId = help ? `${id}-help` : null;
    const errId = `${id}-err`;
    const err = h('p', { class: 'error field-msg', role: 'alert', id: errId });
    input.setAttribute('aria-describedby', [helpId, errId].filter(Boolean).join(' '));
    return {
        err,
        el: h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('p', { class: 'help', id: helpId, text: help }) : null, err),
    };
}

// The values the form starts from: a preference, or something to prefill (or nothing).
const startValues = (p) => ({ area: (p && p.area) || 'travel', key: words(p && p.key), value: (p && p.value) || '', notes: (p && p.notes) || '' });

// What the form would send: key as a slug, empty notes as null.
function clean(v) {
    return { area: v.area, key: slug(v.key), value: String(v.value).trim(), notes: String(v.notes).trim() || null };
}

function prefForm({ values, mode, submit, onSave, onCancel, onDirty }) {
    const base = clean(values);
    const area = h('select', { name: 'area', 'data-key': 'pf-area' }, AREAS.map(([k, label]) => h('option', { value: k, text: label })));
    area.value = values.area;
    const key = h('input', { type: 'text', name: 'key', maxlength: '60', autocomplete: 'off', spellcheck: 'false', placeholder: 'airline seat', value: values.key, 'data-key': 'pf-key' });
    const value = h('input', { type: 'text', name: 'value', maxlength: '500', autocomplete: 'off', placeholder: 'aisle', value: values.value, 'data-key': 'pf-value' });
    const notes = h('textarea', { name: 'notes', rows: '2', maxlength: '300', class: 'plain', 'data-key': 'pf-notes' });
    notes.value = values.notes;
    const inputs = { area, key, value, notes };

    const fArea = field('Area', area);
    const fKey = field('Name', key, 'A short name, like airline seat.');
    const fValue = field('Value', value, HINT);
    const fNotes = field('Notes (optional)', notes);
    const errs = { area: fArea.err, key: fKey.err, value: fValue.err, notes: fNotes.err };
    const formError = h('p', { class: 'error', role: 'alert' });
    const save = button({ text: submit, type: 'submit', size: 'small', 'data-key': 'pf-save' });

    const current = () => clean({ area: area.value, key: key.value, value: value.value, notes: notes.value });
    const dirty = () => { const now = current(); return FIELDS.some((k) => !Object.is(now[k], base[k])); };
    const showError = (err) => {
        const name = err.field || (err.data && err.data.field);
        for (const e of Object.values(errs)) e.textContent = '';
        formError.textContent = '';
        (errs[name] || formError).textContent = err.message;
        const el = inputs[name];
        if (el) el.focus();
    };

    const form = h('form', {
        class: 'place-form pref-form', novalidate: true,
        oninput: () => onDirty && onDirty(),
        onchange: () => onDirty && onDirty(),
        onsubmit: async (event) => {
            event.preventDefault();
            showError({ message: '' });
            save.disabled = true;
            try {
                const now = current();
                if (!now.key) throw fieldError('Give it a name, like airline seat.', 'key');
                if (!now.value) throw fieldError('Give it a value, like aisle.', 'value');
                const body = mode === 'create'
                    ? Object.fromEntries(FIELDS.filter((k) => now[k] != null).map((k) => [k, now[k]]))
                    : Object.fromEntries(FIELDS.filter((k) => !Object.is(now[k], base[k])).map((k) => [k, now[k]]));
                await onSave(body);
            } catch (err) {
                showError(err);
                save.disabled = false;
            }
        },
    }, fArea.el, fKey.el, fValue.el, fNotes.el, formError,
    h('div', { class: 'row' }, save, onCancel ? button({ text: 'Cancel', variant: 'quiet', size: 'small', onClick: onCancel }) : null));
    return { el: form, dirty, save };
}

/* ---------- actions ---------- */

async function unsetIt(ctx, p) {
    const ok = await confirmDialog({
        title: `Remove ${words(p.key)}?`,
        body: 'It leaves the list and what agents read. Its history is kept, and you can bring it back from Removed.',
        confirm: 'Remove', danger: true,
    });
    if (!ok) return false;
    try {
        await ctx.api(`/preferences/${p.id}/unset`, { method: 'POST', body: {} });
        toast(`${cap(words(p.key))} removed`);
        return true;
    } catch (err) {
        toast(`Could not remove it. ${err.message}`, { kind: 'bad' });
        return false;
    }
}

async function bringBack(ctx, p) {
    try {
        await ctx.api(`/preferences/${p.id}/restore`, { method: 'POST', body: {} });
        toast(`${cap(words(p.key))} restored`);
        return true;
    } catch (err) {
        toast(`Could not restore it. ${err.message}`, { kind: 'bad' });
        return false;
    }
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

/* ---------- the drawer for one preference ---------- */

function closeDrawerTo(fromList) {
    if (fromList && history.length > 1) history.back();
    else navigate(href('preferences'), { replace: true });
}

function prefDrawer(ctx, id, fromList, mark) {
    let item = null;
    let form = null;

    const handle = openDrawer({
        title: 'Preference',
        subtitle: 'Loading…',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard your changes?', body: 'The preference keeps what was last saved.', confirm: 'Discard', danger: true }),
        onClose: () => {
            if (drawer && drawer.handle === handle) { drawer = null; closeDrawerTo(fromList); }
        },
        returnFocus: () => document.querySelector(`[data-key="pref:${id}"]`) || document.querySelector('[data-key="new-pref"]'),
    });

    async function changed() {
        await load();
        ctx.rerender();
    }

    async function load() {
        const top = handle.body.scrollTop;
        try {
            item = await ctx.api(`/preferences/${id}`);
        } catch (err) {
            if (err.status === 401) return;
            if (err.status === 404) {
                toast('That preference is gone or never existed.', { kind: 'info' });
                drawer = null;
                handle.close(true);
                closeDrawerTo(fromList);
                return;
            }
            handle.setTitle('Preference', '');
            handle.setContent(errorState({ err, what: 'This preference', retry: load }));
            return;
        }
        handle.setTitle(cap(words(item.key)), `${AREA[item.area] || item.area}, revision ${item.rev}${item.removed ? ', removed' : ''}`);
        handle.setContent(content());
        handle.body.scrollTop = top;
    }

    async function restore(rev) {
        const ok = await confirmDialog({
            title: `Restore revision ${rev}?`,
            body: `The name, value and notes of revision ${rev} become current, as a new revision. What you see now stays in the history.`,
            confirm: 'Restore',
        });
        if (!ok) return;
        try {
            const res = await ctx.api(`/preferences/${item.id}/restore`, { method: 'POST', body: { rev } });
            toast(res.status === 'unchanged' ? 'That revision is the same as the current one' : `Revision ${rev} restored`, { kind: res.status === 'unchanged' ? 'info' : 'good' });
            form = null;
            changed();
        } catch (err) {
            toast(`Could not restore. ${err.message}`, { kind: 'bad' });
        }
    }

    function content() {
        form = prefForm({
            values: startValues(item),
            mode: 'edit',
            submit: 'Save changes',
            onSave: async (body) => {
                if (!Object.keys(body).length) { toast('Nothing changed', { kind: 'info' }); form.save.disabled = false; return; }
                const res = await ctx.api(`/preferences/${item.id}`, { method: 'PATCH', body });
                toast(res.status === 'unchanged' ? 'Nothing changed' : 'Changes saved', { kind: res.status === 'unchanged' ? 'info' : 'good' });
                form = null;
                await changed();
            },
        });
        return [
            item.removed ? h('section', { class: 'drawer-section', 'aria-labelledby': 'pd-state' },
                h('h3', { id: 'pd-state', text: 'Removed' }),
                h('p', { class: 'note', text: 'This preference is hidden from the list and from agents.' }),
                h('div', { class: 'row' }, button({ text: 'Restore', iconName: 'retry', 'data-key': 'drawer-restore', onClick: async () => { if (await bringBack(ctx, item)) { form = null; changed(); } } }))) : null,
            h('section', { class: 'drawer-section', 'aria-labelledby': 'pd-details' },
                h('h3', { id: 'pd-details', text: 'Details' }),
                form.el,
                h('dl', { class: 'facts' },
                    h('dt', { text: 'Added' }), h('dd', { text: when(item.created_at) }),
                    h('dt', { text: 'Last changed' }), h('dd', { text: `${ago(item.updated_at)} by ${actorName(item.updated_by)}` }))),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'pd-history' },
                h('h3', { id: 'pd-history', tabindex: '-1', 'data-key': 'history', text: `History, ${plural(item.history.length, 'revision')}` }),
                h('p', { class: 'note', text: 'Every change is kept. Restoring adds a new revision, so nothing is lost.' }),
                h('ol', { class: 'rev-list', reversed: true }, item.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
                    h('div', { class: 'rev-main' },
                        h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                        h('p', { class: 'rev-what', text: `${{ create: 'Created', edit: 'Edited', restore: 'Restored', unset: 'Removed' }[r.source] || cap(r.source)} by ${actorName(r.actor)}${r.note ? `: ${r.note}` : ''}` }),
                        h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
                    r.current ? null : h('div', { class: 'rev-actions' },
                        button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) })))))),
            item.removed ? null : h('section', { class: 'drawer-section danger-zone' },
                h('p', { class: 'note', text: 'Removing hides it and keeps its history. Nothing is deleted.' }),
                h('div', { class: 'row' }, button({
                    text: 'Remove this preference', variant: 'danger', iconName: 'close', 'data-key': 'drawer-remove',
                    onClick: async () => {
                        if (form && form.dirty() && !(await confirmDialog({ title: 'Discard your changes?', body: 'You are removing this preference. What you typed and did not save is lost.', confirm: 'Continue', danger: true }))) return;
                        if (await unsetIt(ctx, item)) { form = null; changed(); }
                    },
                }))),
        ];
    }

    mark.handle = handle;
    load();
}

// Opens, keeps or closes the drawer so it matches the URL.
function syncDrawer(ctx) {
    const raw = ctx.route.parts[0];
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (raw && !id) { navigate(href('preferences'), { replace: true }); return; }
    if ((drawer ? drawer.id : null) === id) return;
    if (drawer) { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
    if (!id) return;
    const mark = { id, handle: null, fromList: lastWasList };
    drawer = mark;
    setTimeout(() => { if (drawer === mark) prefDrawer(ctx, id, mark.fromList, mark); }, 0);
}

/* ---------- Add preference ---------- */

function closeSide(force = true) {
    if (side) { const s = side; side = null; s.close(force); }
}

// `prefill` is { area, key, value } from an example chip.
function addPreference(ctx, prefill) {
    if (side) return;
    let form = null;
    const handle = openDrawer({
        title: 'Add a preference',
        subtitle: 'A plain fact about how you like things.',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard this preference?', body: 'Nothing has been saved yet.', confirm: 'Discard', danger: true }),
        onClose: () => { if (side === handle) side = null; },
        returnFocus: () => document.querySelector('[data-key="new-pref"]') || document.querySelector('[data-key="chip:0"]'),
    });
    side = handle;
    const values = startValues(null);
    if (prefill) Object.assign(values, { area: prefill.area, key: words(prefill.key), value: prefill.value });
    form = prefForm({
        values: { ...values },
        mode: 'create',
        submit: 'Add preference',
        onCancel: () => handle.close(),
        onSave: async (body) => {
            const res = await ctx.api('/preferences', { method: 'POST', body });
            toast(`${cap(words(res.key))} added`);
            form = null;
            side = null;
            handle.close(true);
            focusAfter = `pref:${res.id}`;
            ctx.rerender();
        },
    });
    // A prefilled form counts as untouched: closing it does not ask to discard.
    handle.setContent(form.el);
    const first = handle.body.querySelector(prefill ? 'input[name="value"]' : 'input[name="key"]');
    if (first) first.focus();
    return form;
}

/* ---------- the list ---------- */

function prefRow(ctx, p, { removed }) {
    const link = h('a', { class: 'row-link', href: prefHref(p.id), 'data-key': `pref:${p.id}` }, cap(words(p.key)));
    return h('li', { class: 'pref-row', 'data-id': String(p.id), onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('div', { class: 'pref-main' },
            h('p', { class: 'pref-key' }, link),
            h('p', { class: 'pref-value', text: p.value }),
            p.notes ? h('p', { class: 'pref-notes muted', text: p.notes }) : null),
        h('div', { class: 'row-actions' }, removed
            ? [button({ text: 'Restore', variant: 'quiet', size: 'small', iconName: 'retry', label: `Restore ${words(p.key)}`, 'data-key': `restore:${p.id}`,
                onClick: async () => { if (await bringBack(ctx, p)) { focusAfter = 'removed-toggle'; ctx.rerender(); } } }),
                h('a', { class: 'btn quiet small', href: prefHref(p.id), 'aria-label': `Open ${words(p.key)}`, text: 'Open' })]
            : [h('a', { class: 'btn quiet small', href: prefHref(p.id), 'aria-label': `Edit ${words(p.key)}`, text: 'Edit' })]));
}

function groups(ctx, rows, opts) {
    const by = new Map(AREAS.map(([k]) => [k, []]));
    for (const p of rows) (by.get(p.area) || by.set(p.area, []).get(p.area)).push(p);
    return h('div', { class: 'pref-groups' }, [...by].filter(([, list]) => list.length).map(([k, list]) => {
        const hid = `pa-${k}`;
        return h('section', { class: 'pref-group', 'aria-labelledby': hid, 'data-area': k },
            h('h2', { class: 'section-title', id: hid }, AREA[k] || cap(k), ' ', h('span', { class: 'muted pref-count', text: `${list.length}` })),
            h('ul', { class: 'pref-list' }, list.map((p) => prefRow(ctx, p, opts))));
    }));
}

function emptyWithExamples(ctx) {
    const chips = h('div', { class: 'row pref-examples', role: 'group', 'aria-label': 'Examples to start from' },
        EXAMPLES.map((e, i) => h('button', { type: 'button', class: 'chip-link', 'data-key': `chip:${i}`, onclick: () => addPreference(ctx, e) }, e.label)));
    return emptyState({
        title: 'No preferences yet.',
        text: 'Plain facts about how you like things, so you do not repeat them. Start from an example or add your own.',
        iconName: 'preferences',
        action: h('div', { class: 'pref-empty-actions' }, chips,
            button({ text: 'Add preference', size: 'small', iconName: 'plus', 'data-key': 'empty-new', onClick: () => addPreference(ctx) })),
    });
}

function toolbar(live, gone, f, removedMode) {
    const query = (patch) => ({ q: f.q, removed: removedMode ? '1' : '', ...patch });
    const search = h('input', { type: 'search', name: 'q', value: f.q, placeholder: 'Search preferences', 'aria-label': 'Search preferences by name, value, notes or area', 'data-key': 'p-search', enterkeyhint: 'search' });
    const searchForm = h('form', { class: 'search-form', role: 'search', onsubmit: (event) => { event.preventDefault(); navigate(href('preferences', [], query({ q: search.value.trim() }))); } },
        icon('search', 'search-icon'), search,
        f.q ? h('a', { class: 'btn ghost small', href: href('preferences', [], query({ q: '' })), text: 'Clear' }) : null);
    const toggle = gone.total || removedMode
        ? h('a', { class: 'chip-link', 'data-key': 'removed-toggle', href: href('preferences', [], query({ removed: removedMode ? '' : '1' })), 'aria-current': removedMode ? 'true' : null },
            removedMode ? icon('check') : null, h('span', { text: `Removed (${gone.total})` }))
        : null;
    return h('div', { class: 'toolbar filter-bar' }, h('div', { class: 'filters' }, toggle), searchForm);
}

export async function render(ctx) {
    const q = ctx.route.query;
    const idRaw = ctx.route.parts[0];
    const removedMode = q.get('removed') === '1';
    const f = { q: (q.get('q') || '').trim() };

    const [live, gone] = await Promise.all([ctx.api('/preferences?limit=200'), ctx.api('/preferences?removed=true&limit=200')]);

    syncDrawer(ctx);
    lastWasList = !idRaw;
    ctx.onCleanup(() => {
        if (drawer && parse().name !== 'preferences') { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
        if (side && parse().name !== 'preferences') closeSide();
    });
    if (q.get('new') === '1' && !idRaw) {
        navigate(href('preferences'), { replace: true });
        setTimeout(() => addPreference(ctx), 0);
    }
    if (focusAfter) {
        const key = focusAfter;
        focusAfter = null;
        setTimeout(() => { const el = document.querySelector(`[data-key="${key}"]`); if (el) el.focus(); }, 0);
    }

    const all = removedMode ? gone.preferences : live.preferences;
    const needle = f.q.toLowerCase();
    const shown = all.filter((p) => !needle || [words(p.key), p.value, p.notes, AREA[p.area], p.area].some((t) => t && String(t).toLowerCase().includes(needle)));
    const filtered = Boolean(f.q);

    let body;
    if (!all.length) {
        body = removedMode
            ? emptyState({ title: 'Nothing removed.', text: 'Preferences you remove are kept here, and can be restored.', iconName: 'check',
                action: h('a', { class: 'btn quiet small', href: href('preferences'), text: 'Back to preferences' }) })
            : emptyWithExamples(ctx);
    } else if (!shown.length) {
        body = emptyState({
            title: 'No preference matches.', text: 'Try other words.', iconName: 'search',
            action: h('a', { class: 'btn quiet small', href: href('preferences', [], removedMode ? { removed: '1' } : {}), text: 'Show every preference' }),
        });
    } else body = groups(ctx, shown, { removed: removedMode });

    const add = button({ text: 'Add preference', iconName: 'plus', 'data-key': 'new-pref', onClick: () => addPreference(ctx) });
    return h('div', { class: 'view preferences' },
        h('div', { class: 'view-intro row-between' },
            h('p', { class: 'lede', text: 'Plain facts about how you like things: seat, call hours, favourite airline. Agents read them as context. Keep passwords, numbers and keys in the vault.' }),
            add),
        all.length || removedMode || live.total || gone.total ? toolbar(live, gone, f, removedMode) : null,
        h('div', { class: 'pref-panel' },
            all.length ? h('p', { class: 'note pref-total', 'aria-live': 'polite', text: filtered ? `${shown.length} of ${plural(all.length, removedMode ? 'removed preference' : 'preference')}` : plural(all.length, removedMode ? 'removed preference' : 'preference') }) : null,
            body));
}
