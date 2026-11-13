// Places: the spots the digests name, and the rules that recognise a location as one of them.
//   #/places                     the places (table), search ?q= and ?kind= in the URL, the "Check a location" box
//   #/places/12                  that place's drawer: details, rules, history (compare, restore), delete
//   #/places?new=1               the New place dialog (the palette uses it)
//   #/places?tab=queue           "Needs a name": streets the nightly digest saw that no place claims;
//                                ?show=accepted|dismissed|all for the ones already decided
// Private data: rule values (streets, zones, coordinates) appear only in the drawer and in the check result,
// never in the table or in a toast. Everything from the server goes in as text.
import {
    h, icon, button, plural, when, ago, emptyState, errorState, toast, confirmDialog, formDialog, deleteDialog, openDrawer,
    chip, chipNav, fact, hidden, actorName, copyButton, pageHeader } from '../ui.js';
import { href, navigate, parse } from '../router.js';

const TABS = [['places', 'Places'], ['queue', 'Needs a name']];
const SHOW = [['pending', 'Waiting'], ['accepted', 'Named'], ['dismissed', 'Dismissed'], ['all', 'All']];
const KIND_FALLBACK = ['home', 'campus', 'family', 'friend', 'store', 'transit', 'other'];
const RULE_WORD = { street: ['street', 'streets'], zone: ['zone', 'zones'], radius: ['circle', 'circles'] };
const RULE_TITLE = { street: 'Street', zone: 'Zone', radius: 'Circle' };
const SOURCE_LABEL = { create: 'Created', import: 'Imported', edit: 'Edited', rule: 'Rules changed', restore: 'Restored', suggestion: 'Named from the queue' };
const IMPORT_CMD = 'docker exec -i nodejs node scripts/places-import.js - --dry-run < known-places.md';

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const kindLabel = (k) => cap(k || 'other');
const placeHref = (id) => href('places', [String(id)]);

let drawer = null;        // { id, handle, fromList }
let lastWasList = false;  // the previous render was the plain list (closing the drawer can go back)
let focusAfter = null;    // a data-key to focus once the next render is on screen
let check = { open: false, values: {} }; // the "Check a location" box keeps its fields between renders

/* ---------- words for rules ---------- */

// "2 streets, 1 zone, 1 not this place": counts only, never values (the table shows this).
function ruleCounts(rules) {
    const out = [];
    for (const type of Object.keys(RULE_WORD)) {
        const n = rules.filter((r) => r.type === type && !r.exclude).length;
        if (n) out.push(`${n} ${RULE_WORD[type][n === 1 ? 0 : 1]}`);
    }
    const ex = rules.filter((r) => r.exclude).length;
    if (ex) out.push(`${ex} not this place`);
    return out;
}

const metres = (m) => (m >= 1000 ? `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`);

// What a rule matches, in words. Shown in the drawer and the check result only.
function ruleValue(r) {
    if (r.type === 'street') return `“${r.value}” in the address`;
    if (r.type === 'zone') return `Home Assistant zone ${r.value}`;
    const where = r.lat != null ? ` of ${r.lat}, ${r.lon}` : ' of its centre';
    return `Within ${metres(r.radius_m)}${where}${r.value ? ` (${r.value})` : ''}`;
}

const confidenceText = (c) => (c === 'exact'
    ? 'Exact: a zone or a circle matched.'
    : 'Street: the address contains the text of a street rule.');

/* ---------- tabs (a real tablist: arrows, Home and End move and select) ---------- */

function tabBar(current, pending) {
    const list = h('div', { class: 'vtabs', role: 'tablist', 'aria-label': 'Places sections' });
    const tabs = TABS.map(([id, label]) => {
        const on = id === current;
        const target = id === 'places' ? href('places') : href('places', [], { tab: id });
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
        id === 'queue' && pending ? [h('span', { class: 'badge', 'aria-hidden': 'true', text: String(pending) }), hidden(`, ${pending} waiting`)] : null);
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

/* ---------- shared fields ---------- */

let fieldId = 0;
function field(label, input, help) {
    const id = input.id || `pf-${++fieldId}`;
    input.id = id;
    const helpId = help ? `${id}-help` : null;
    if (helpId) input.setAttribute('aria-describedby', helpId);
    return h('div', { class: 'field' },
        h('label', { for: id, text: label }), input,
        help ? h('p', { class: 'help', id: helpId, text: help }) : null);
}

function kindSelect(kinds, value = 'other', name = 'kind') {
    const sel = h('select', { name }, kinds.map((k) => h('option', { value: k, text: kindLabel(k) })));
    sel.value = kinds.includes(value) ? value : 'other';
    return sel;
}

const fieldError = (message, name) => Object.assign(new Error(message), { field: name });

// Name, kind and notes: used by New place and by Name it.
function placeFields(kinds, { label = '', kind = 'other', notes = '' } = {}) {
    const name = h('input', { type: 'text', name: 'label', autocomplete: 'off', maxlength: '80', required: true, value: label });
    const area = h('textarea', { name: 'notes', rows: '3', maxlength: '2000', class: 'plain' });
    area.value = notes;
    return [
        field('Name', name, 'What a digest says, for example Home or Campus library. Unique.'),
        field('Kind', kindSelect(kinds, kind)),
        field('Notes (optional)', area, 'Anything that helps an agent describe the place.'),
    ];
}

function placeBody(form) {
    const label = form.elements.label.value.trim();
    if (!label) throw fieldError('Give the place a name.', 'label');
    return { label, kind: form.elements.kind.value, notes: form.elements.notes.value.trim() || null };
}

/* ---------- New place ---------- */

async function newPlace(ctx, kinds, prefill) {
    const made = await formDialog({
        title: 'New place',
        intro: 'Give it a name now; add the streets, zones or circles that recognise it in the next step.',
        fields: placeFields(kinds, prefill),
        submit: 'Create place',
        onSubmit: async (form) => {
            const body = placeBody(form);
            const res = await ctx.api('/places', { method: 'POST', body });
            return { ...res, label: body.label };
        },
    });
    if (!made) return;
    toast(`Place ${made.label} created`);
    navigate(placeHref(made.id));
}

/* ---------- rule dialog ---------- */

async function ruleDialog(ctx, place, rule) {
    const editing = Boolean(rule);
    const r = rule || { type: 'street', value: '', exclude: false, priority: 0 };
    const type = h('select', { name: 'type' }, Object.keys(RULE_TITLE).map((t) => h('option', { value: t, text: { street: 'Street: text in the address', zone: 'Zone: a Home Assistant zone', radius: 'Circle: within a distance of a point' }[t] })));
    type.value = r.type;
    const value = h('input', { type: 'text', name: 'value', autocomplete: 'off', spellcheck: 'false', maxlength: '120', value: r.value || '' });
    const valueLabel = h('label', { for: 'rule-value' });
    value.id = 'rule-value';
    const valueHelp = h('p', { class: 'help', id: 'rule-value-help' });
    value.setAttribute('aria-describedby', 'rule-value-help');
    const num = (name, v, label, help) => field(label, h('input', { type: 'text', name, inputmode: 'decimal', autocomplete: 'off', value: v == null ? '' : String(v) }), help);
    const circle = h('div', { class: 'field-grid' },
        num('lat', r.lat, 'Latitude'), num('lon', r.lon, 'Longitude'), num('radius_m', r.radius_m, 'Radius in metres'));
    const exclude = h('input', { type: 'checkbox', name: 'exclude', id: 'rule-exclude' });
    exclude.checked = Boolean(r.exclude);
    const priority = h('input', { type: 'text', name: 'priority', inputmode: 'numeric', autocomplete: 'off', value: String(r.priority || 0) });

    const paint = () => {
        const t = type.value;
        valueLabel.textContent = t === 'street' ? 'Text in the address' : t === 'zone' ? 'Zone' : 'Caption (optional)';
        valueHelp.textContent = t === 'street'
            ? 'Matches when the geocoded address contains this text, in any case. At least 3 characters; the street name without the house number is usually right.'
            : t === 'zone' ? 'The Home Assistant zone id, for example home or zone.campus.' : 'A word for yourself, for example "the parking lot".';
        value.required = t !== 'radius';
        circle.hidden = t !== 'radius';
    };
    type.addEventListener('change', paint);
    paint();

    const saved = await formDialog({
        title: editing ? `Edit rule of ${place.label}` : `Add a rule to ${place.label}`,
        fields: [
            field('Type', type),
            h('div', { class: 'field' }, valueLabel, value, valueHelp),
            circle,
            h('div', { class: 'field check-field' },
                h('label', { class: 'check', for: 'rule-exclude' }, exclude, h('span', { text: 'Not this place' })),
                h('p', { class: 'help', text: `When this rule matches, the location is not ${place.label}, even if another of its rules matches. Use it for a neighbour on the same street.` })),
            field('Priority', priority, 'Breaks a tie when two places match the same way: the higher number wins. Usually 0.'),
        ],
        submit: editing ? 'Save rule' : 'Add rule',
        onSubmit: async (form) => {
            const t = type.value;
            const body = { type: t, value: value.value.trim() || null, exclude: exclude.checked, priority: priority.value.trim() === '' ? 0 : Number(priority.value) };
            if (t !== 'radius' && !body.value) throw fieldError(t === 'street' ? 'Type the text the address must contain.' : 'Type the zone.', 'value');
            if (!Number.isInteger(body.priority)) throw fieldError('Priority is a whole number, like 0 or 5.', 'priority');
            if (t === 'radius') {
                for (const k of ['lat', 'lon', 'radius_m']) {
                    const v = form.elements[k].value.trim();
                    if (v === '' || !Number.isFinite(Number(v))) throw fieldError(k === 'radius_m' ? 'Give the radius in metres.' : 'Latitude and longitude are numbers, like 35.1234 and -92.5678.', k);
                    body[k] = Number(v);
                }
            } else Object.assign(body, { lat: null, lon: null, radius_m: null });
            return editing
                ? ctx.api(`/places/${place.id}/rules/${rule.id}`, { method: 'PATCH', body })
                : ctx.api(`/places/${place.id}/rules`, { method: 'POST', body });
        },
    });
    if (!saved) return null;
    toast(editing ? (saved.status === 'unchanged' ? 'Nothing changed' : 'Rule saved') : 'Rule added', { kind: saved.status === 'unchanged' ? 'info' : 'good' });
    return saved;
}

/* ---------- compare two revisions ---------- */

function snapshotLines(p) {
    return [
        `Name: ${p.label}`,
        `Kind: ${kindLabel(p.kind)}`,
        `Notes: ${p.notes || 'none'}`,
        ...p.rules.map((r) => `${r.exclude ? 'Not this place: ' : ''}${RULE_TITLE[r.type] || r.type}, ${ruleValue(r)}${r.priority ? `, priority ${r.priority}` : ''}`),
    ];
}

function diffLines(older, newer) {
    const a = snapshotLines(older);
    const b = snapshotLines(newer);
    return [...a.filter((l) => !b.includes(l)).map((l) => ['del', l]), ...b.map((l) => [a.includes(l) ? 'same' : 'add', l])];
}

/* ---------- the place drawer ---------- */

function closeDrawerTo(fromList) {
    if (fromList && history.length > 1) history.back();
    else navigate(href('places'), { replace: true });
}

function placeDrawer(ctx, id, fromList, kinds) {
    let place = null;
    let draft = null; // unsaved name/kind/notes, kept across refreshes
    const dirty = () => Boolean(place && draft && (draft.label !== place.label || draft.kind !== place.kind || (draft.notes || '') !== (place.notes || '')));

    const handle = openDrawer({
        title: 'Place',
        subtitle: 'Loading…',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        wide: true,
        beforeClose: async () => !dirty() || confirmDialog({ title: 'Discard your changes?', body: 'The place keeps its saved name, kind and notes.', confirm: 'Discard', danger: true }),
        onClose: () => {
            const mine = drawer && drawer.handle === handle;
            if (mine) { drawer = null; closeDrawerTo(fromList); }
        },
        returnFocus: () => document.querySelector(`[data-key="place:${id}"]`) || document.querySelector('[data-key="new-place"]'),
    });

    const focusKey = (key) => {
        const el = key && handle.body.querySelector(`[data-key="${key}"]`);
        if (el) el.focus();
        else handle.el.querySelector('.drawer-head button').focus();
    };

    // Changed something: reload the place (keeping the scroll position) and refresh the list behind.
    async function changed(key) {
        await load(key);
        ctx.rerender();
    }

    async function load(key) {
        const top = handle.body.scrollTop;
        try {
            place = await ctx.api(`/places/${id}`);
        } catch (err) {
            if (err.status === 401) return;
            if (err.status === 404) {
                toast('That place is gone. It may have been deleted.', { kind: 'info' });
                drawer = null;
                handle.close(true);
                closeDrawerTo(fromList);
                return;
            }
            handle.setTitle('Place', '');
            handle.setContent(errorState({ err, what: 'This place', retry: () => load(key) }));
            return;
        }
        handle.setTitle(place.label, `${kindLabel(place.kind)}, ${plural(place.rules.length, 'rule')}, revision ${place.rev}`);
        handle.setContent(content());
        handle.body.scrollTop = top;
        if (key) focusKey(key);
    }

    function details() {
        const v = draft || { label: place.label, kind: place.kind, notes: place.notes || '' };
        const label = h('input', { type: 'text', name: 'label', id: 'pd-label', autocomplete: 'off', maxlength: '80', value: v.label, 'data-key': 'pd-label' });
        const kind = kindSelect(kinds, v.kind);
        kind.id = 'pd-kind';
        const notes = h('textarea', { name: 'notes', id: 'pd-notes', rows: '4', maxlength: '2000', class: 'plain' });
        notes.value = v.notes || '';
        const error = h('p', { class: 'error', role: 'alert' });
        const save = button({ text: 'Save changes', type: 'submit', size: 'small', 'data-key': 'pd-save' });
        const form = h('form', {
            class: 'place-form',
            novalidate: true,
            oninput: () => { draft = { label: label.value, kind: kind.value, notes: notes.value }; },
            onchange: () => { draft = { label: label.value, kind: kind.value, notes: notes.value }; },
            onsubmit: async (event) => {
                event.preventDefault();
                error.textContent = '';
                const body = { label: label.value.trim(), kind: kind.value, notes: notes.value.trim() || null };
                if (!body.label) { error.textContent = 'Give the place a name.'; label.focus(); return; }
                save.disabled = true;
                try {
                    const res = await ctx.api(`/places/${place.id}`, { method: 'PATCH', body });
                    draft = null;
                    toast(res.status === 'unchanged' ? 'Nothing changed' : 'Changes saved', { kind: res.status === 'unchanged' ? 'info' : 'good' });
                    await changed('pd-save');
                } catch (err) {
                    error.textContent = err.message;
                    save.disabled = false;
                }
            },
        },
        field('Name', label),
        field('Kind', kind),
        field('Notes', notes, 'Shown to agents with the place.'),
        error,
        h('div', { class: 'row' }, save));
        return form;
    }

    function ruleItem(r) {
        return h('li', { class: `rule${r.exclude ? ' is-exclude' : ''}` },
            h('div', { class: 'rule-main' },
                h('p', { class: 'rule-head' },
                    chip(RULE_TITLE[r.type] || r.type, { cls: 'rule-type' }),
                    r.exclude ? chip('Not this place', { cls: 'chip-exclude' }) : null,
                    r.priority ? h('span', { class: 'muted', text: `Priority ${r.priority}` }) : null),
                h('p', { class: 'rule-value', text: ruleValue(r) }),
                r.exclude ? h('p', { class: 'help', text: `When this matches, the location is not ${place.label}, whatever else matches.` }) : null),
            h('div', { class: 'rule-actions' },
                button({ text: 'Edit', variant: 'quiet', size: 'small', 'data-key': `rule:${r.id}:edit`, label: `Edit the ${RULE_TITLE[r.type].toLowerCase()} rule`, onClick: async () => {
                    if (await ruleDialog(ctx, place, r)) changed(`rule:${r.id}:edit`);
                } }),
                button({ text: 'Remove', variant: 'quiet', size: 'small', 'data-key': `rule:${r.id}:remove`, label: `Remove the ${RULE_TITLE[r.type].toLowerCase()} rule`, onClick: async () => {
                    const ok = await confirmDialog({
                        title: 'Remove this rule?',
                        body: `${place.label} keeps its other rules. The removal is saved as a new revision, so it can be restored.`,
                        confirm: 'Remove rule',
                    });
                    if (!ok) return;
                    try {
                        await ctx.api(`/places/${place.id}/rules/${r.id}`, { method: 'DELETE' });
                        toast('Rule removed');
                        changed('add-rule');
                    } catch (err) {
                        toast(`Could not remove the rule. ${err.message}`, { kind: 'bad' });
                    }
                } })));
    }

    async function restore(rev) {
        const ok = await confirmDialog({
            title: `Restore revision ${rev}?`,
            body: `The name, kind, notes and rules of revision ${rev} become current, as a new revision. What you see now stays in the history.`,
            confirm: 'Restore',
        });
        if (!ok) return;
        try {
            const res = await ctx.api(`/places/${place.id}/restore`, { method: 'POST', body: { rev } });
            toast(res.status === 'unchanged' ? 'That revision is the same as the current one' : `Revision ${rev} restored`, { kind: res.status === 'unchanged' ? 'info' : 'good' });
            draft = null;
            changed('history');
        } catch (err) {
            toast(`Could not restore. ${err.message}`, { kind: 'bad' });
        }
    }

    async function compare(rev) {
        handle.setContent(h('p', { class: 'muted', text: 'Loading…' }));
        try {
            const older = await ctx.api(`/places/${place.id}?rev=${rev}`);
            const parts = diffLines(older, place);
            const changedN = parts.filter(([k]) => k !== 'same').length;
            const back = button({ text: 'Back to the place', variant: 'ghost', size: 'small', iconName: 'prev', onClick: () => load('history') });
            handle.setTitle(place.label, `Revision ${rev} and the current one`);
            handle.setContent(
                h('div', { class: 'compare-top' }, back,
                    button({ text: `Restore revision ${rev}`, variant: 'quiet', size: 'small', onClick: () => restore(rev) })),
                h('p', { class: 'note', text: changedN ? `${plural(changedN, 'line')} differ. Lines only in revision ${rev} are struck through; lines added since are marked with a plus.` : 'The two are the same.' }),
                h('div', { class: 'diff diff-plain' }, parts.map(([k, text]) => h('p', { class: k },
                    k === 'add' ? hidden('Added: ') : k === 'del' ? hidden('Removed: ') : null, text))));
            back.focus();
        } catch (err) {
            if (err.status !== 401) handle.setContent(errorState({ err, what: 'That revision', retry: () => compare(rev) }));
        }
    }

    function content() {
        const addRule = button({ text: 'Add rule', variant: 'quiet', size: 'small', iconName: 'plus', 'data-key': 'add-rule', onClick: async () => {
            const res = await ruleDialog(ctx, place, null);
            if (res) changed('add-rule');
        } });
        const del = button({ text: 'Delete permanently', variant: 'quiet-danger', iconName: 'trash', 'data-key': 'delete-place', onClick: async () => {
            let pre;
            try { pre = await ctx.api(`/places/${place.id}/delete-preview`); } catch (err) { toast(`Could not check what a delete would take. ${err.message}`, { kind: 'bad' }); return; }
            const c = pre.counts;
            const out = await deleteDialog({
                title: `Delete ${pre.label}?`,
                goes: [`The place ${pre.label}`, plural(c.rules, 'rule'), plural(c.revisions, 'revision')],
                stays: ['Spots in the Needs a name queue (one that became this place just loses the link)', 'Digests already written, which keep the name they used'],
                run: (o) => ctx.api(`/places/${place.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
            });
            if (!out) return;
            toast(`Deleted ${out.label}`);
            draft = null;
            const d = drawer;
            drawer = null;
            handle.close(true);
            if (d) closeDrawerTo(d.fromList);
            ctx.rerender();
        } });

        return [
            h('section', { class: 'drawer-section', 'aria-labelledby': 'pd-details' },
                h('h3', { id: 'pd-details', text: 'Details' }),
                details(),
                h('dl', { class: 'facts' },
                    fact('Added', `${when(place.created_at)}${place.source === 'suggested' ? ', from the queue' : ''}`),
                    fact('Last changed', `${ago(place.updated_at)} by ${actorName(place.updated_by)}`))),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'pd-rules' },
                h('div', { class: 'section-head' }, h('h3', { id: 'pd-rules', text: place.rules.length ? `Rules (${place.rules.length})` : 'Rules' }), addRule),
                h('p', { class: 'note', text: 'A location is this place when any rule matches, unless a Not this place rule matches. Zones and circles beat streets.' }),
                place.rules.length
                    ? h('ul', { class: 'rule-list' }, place.rules.map(ruleItem))
                    : emptyState({ title: 'No rules yet.', text: 'Without a rule nothing resolves to this place. Add the street as the phone reports it, a Home Assistant zone, or a circle.', iconName: 'places' })),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'pd-history' },
                h('h3', { id: 'pd-history', tabindex: '-1', 'data-key': 'history', text: `History, ${plural(place.history.length, 'revision')}` }),
                h('p', { class: 'note', text: 'Every change to the place or one of its rules is kept. Restoring adds a new revision, so nothing is lost.' }),
                h('ol', { class: 'rev-list', reversed: true }, place.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
                    h('div', { class: 'rev-main' },
                        h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                        h('p', { class: 'rev-what', text: `${SOURCE_LABEL[r.source] || cap(r.source)} by ${actorName(r.actor)}${r.note ? `: ${r.note}` : ''}. ${r.label}, ${plural(r.rules, 'rule')}.` }),
                        h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
                    r.current ? null : h('div', { class: 'rev-actions' },
                        button({ text: 'Compare', variant: 'quiet', size: 'small', label: `Compare revision ${r.rev} with the current one`, onClick: () => compare(r.rev) }),
                        button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) })))))),
            h('section', { class: 'drawer-section danger-zone' },
                h('p', { class: 'note', text: 'Deleting removes the place, its rules and its history for good. Nothing else changes.' }), del),
        ];
    }

    drawer = { id, handle, fromList };
    load();
}

// Opens, keeps or closes the drawer so it matches the URL.
function syncDrawer(ctx, list, kinds) {
    const raw = ctx.route.parts[0];
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (raw && !id) { navigate(href('places'), { replace: true }); return; }
    if ((drawer ? drawer.id : null) === id) return;
    if (drawer) { const d = drawer; drawer = null; d.handle.close(true); }
    if (!id) return;
    if (!list.some((p) => p.id === id)) {
        toast('There is no place with that id.', { kind: 'info' });
        navigate(href('places'), { replace: true });
        return;
    }
    const fromList = lastWasList;
    setTimeout(() => placeDrawer(ctx, id, fromList, kinds), 0);
}

/* ---------- Check a location ---------- */

function checkBox(ctx, kinds) {
    const v = check.values;
    const input = (name, label, attrs = {}) => {
        const el = h('input', { type: 'text', name, autocomplete: 'off', spellcheck: 'false', value: v[name] || '', ...attrs });
        el.addEventListener('input', () => { check.values[name] = el.value; });
        return field(label, el);
    };
    const out = h('div', { class: 'check-result', 'aria-live': 'polite' });
    const error = h('p', { class: 'error', role: 'alert' });
    const go = button({ text: 'Check', type: 'submit', 'data-key': 'check' });

    const placeLink = (p) => h('a', { class: 'link', href: placeHref(p.id), text: p.label });

    function show(res) {
        const parts = [];
        if (res.match) {
            parts.push(h('p', { class: 'check-answer' }, icon('good'), h('span', {}, 'Resolves to ', h('strong', {}, placeLink(res.match)), ' '), chip(kindLabel(res.match.kind))));
            parts.push(h('dl', { class: 'facts' },
                fact('Why', `Its ${RULE_TITLE[res.matched_rule.type].toLowerCase()} rule matched: ${ruleValue(res.matched_rule)}${res.matched_rule.distance_m != null ? `, ${metres(res.matched_rule.distance_m)} away` : ''}.`),
                fact('Confidence', confidenceText(res.confidence))));
        } else {
            parts.push(emptyState({
                title: 'No place matches this location.',
                text: 'Add a place for it, or add a rule to an existing place. Checking never puts anything in the Needs a name queue.',
                iconName: 'places',
                action: button({ text: 'New place', size: 'small', iconName: 'plus', 'data-key': 'check-new', onClick: () => newPlace(ctx, kinds) }),
            }));
        }
        if (res.alternatives && res.alternatives.length) {
            parts.push(h('div', { class: 'check-more' }, h('h4', { text: 'Also matched, ranked lower' }),
                h('ul', {}, res.alternatives.map((a) => h('li', {}, placeLink(a), `: ${RULE_TITLE[a.matched_rule.type].toLowerCase()} rule, ${ruleValue(a.matched_rule)}`)))));
        }
        if (res.excluded && res.excluded.length) {
            parts.push(h('div', { class: 'check-more' }, h('h4', { text: 'Ruled out' }),
                h('ul', {}, res.excluded.map((x) => h('li', {}, placeLink(x), `: its Not this place rule matched, ${ruleValue(x.matched_rule)}`)))));
        }
        out.replaceChildren(...parts);
    }

    const form = h('form', {
        class: 'check-form',
        novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            error.textContent = '';
            const f = form.elements;
            const body = {};
            for (const k of ['geocode', 'lat', 'lon', 'zone']) if (f[k].value.trim()) body[k] = f[k].value.trim();
            if (!Object.keys(body).length) { error.textContent = 'Type an address, a latitude and longitude, or a zone.'; f.geocode.focus(); return; }
            for (const k of ['lat', 'lon']) if (body[k] != null) body[k] = Number(body[k]);
            go.disabled = true;
            out.replaceChildren(h('p', { class: 'muted', text: 'Checking…' }));
            try {
                show(await ctx.api('/places/resolve', { method: 'POST', body }));
            } catch (err) {
                out.replaceChildren();
                error.textContent = err.message;
            } finally {
                go.disabled = false;
            }
        },
    },
    input('geocode', 'Address', { placeholder: 'As the phone reports it: 12 Example Ave, Springfield', class: 'wide-field' }),
    h('div', { class: 'field-grid' },
        input('lat', 'Latitude', { inputmode: 'decimal' }),
        input('lon', 'Longitude', { inputmode: 'decimal' }),
        input('zone', 'Zone', { placeholder: 'home' })),
    error,
    h('div', { class: 'row' }, go, h('span', { class: 'muted', text: 'Only checks. Nothing is saved or filed.' })));

    const box = h('details', { class: 'panel check-box', 'data-key': 'check-box' },
        h('summary', {}, icon('search'), h('span', { text: 'Check a location' }), h('span', { class: 'muted summary-hint', text: 'Which place does an address, point or zone resolve to?' })),
        h('div', { class: 'check-body' }, form, out));
    box.open = check.open;
    box.addEventListener('toggle', () => { check.open = box.open; });
    return box;
}

/* ---------- Places tab ---------- */

function placeRow(p) {
    const link = h('a', { class: 'row-link', href: placeHref(p.id), 'data-key': `place:${p.id}` }, p.label);
    const counts = ruleCounts(p.rules);
    return h('tr', { onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('td', { class: 'cell-main' }, link),
        h('td', { 'data-label': 'Kind' }, chip(kindLabel(p.kind))),
        h('td', { 'data-label': 'Rules' }, counts.length
            ? h('div', { class: 'chips' }, counts.map((c) => chip(c, { cls: /not this place/.test(c) ? 'chip-exclude' : '' })))
            : h('span', { class: 'warn-text', text: 'No rules yet' })),
        h('td', { 'data-label': 'Last changed' }, h('time', { datetime: p.lastChange.at, title: when(p.lastChange.at), text: ago(p.lastChange.at) }), h('span', { class: 'muted', text: ` by ${actorName(p.lastChange.by)}` })),
        h('td', { 'data-label': 'History', class: 'num', text: plural(p.revisions, 'revision') }),
        h('td', { class: 'cell-side only-narrow' }, h('a', { class: 'btn ghost icon-only', href: placeHref(p.id), tabindex: '-1', 'aria-hidden': 'true' }, icon('next'))));
}

function placesTable(rows) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'stack places-table' },
        h('thead', {}, h('tr', {},
            h('th', { scope: 'col', text: 'Name' }),
            h('th', { scope: 'col', text: 'Kind' }),
            h('th', { scope: 'col', text: 'Rules' }),
            h('th', { scope: 'col', text: 'Last changed' }),
            h('th', { scope: 'col', class: 'num', text: 'History' }))),
        h('tbody', {}, rows)));
}

function importHelp() {
    const field = h('input', { type: 'text', class: 'secret', readonly: true, value: IMPORT_CMD, 'aria-label': 'Importer command', onfocus: (e) => e.target.select() });
    return h('div', { class: 'import-help' },
        h('p', { class: 'note', text: 'Or import the known-places table (Match, Label, Notes). Run it on the server; --dry-run shows what would happen, drop it to import.' }),
        h('div', { class: 'copy-row' }, field, copyButton({ value: IMPORT_CMD, field, text: 'Copy', size: 'small', label: 'Copy the importer command' })));
}

function placesTab(ctx, data) {
    const q = (ctx.route.query.get('q') || '').trim();
    const kind = ctx.route.query.get('kind') || '';
    const all = data.places;
    const kinds = data.kinds || KIND_FALLBACK;
    const needle = q.toLowerCase();
    const shown = all.filter((p) => (!kind || p.kind === kind) && (!needle || p.label.toLowerCase().includes(needle) || (p.notes || '').toLowerCase().includes(needle)));

    const present = kinds.filter((k) => all.some((p) => p.kind === k) || k === kind);
    const kindNav = chipNav({
        label: 'Kind of place',
        current: kind || 'all',
        items: [{ id: 'all', label: 'All', href: href('places', [], { q: q || null }) },
            ...present.map((k) => ({ id: k, label: kindLabel(k), href: href('places', [], { kind: k, q: q || null }) }))],
    });
    const search = h('input', { type: 'search', name: 'q', value: q, placeholder: 'Search names and notes', 'aria-label': 'Search places by name or notes', 'data-key': 'p-search', enterkeyhint: 'search' });
    const searchForm = h('form', {
        class: 'search-form',
        role: 'search',
        onsubmit: (event) => { event.preventDefault(); navigate(href('places', [], { kind: kind || null, q: search.value.trim() })); },
    }, icon('search', 'search-icon'), search,
    q ? h('a', { class: 'btn ghost small', href: href('places', [], { kind: kind || null }), text: 'Clear' }) : null);

    let body;
    if (!all.length) {
        body = emptyState({
            title: 'No places yet.',
            text: 'Add your first place or import your known-places table. Digests then say "Home" instead of a street.',
            iconName: 'places',
            action: [button({ text: 'New place', size: 'small', iconName: 'plus', 'data-key': 'empty-new', onClick: () => newPlace(ctx, kinds) }), importHelp()],
        });
    } else if (!shown.length) {
        body = emptyState({
            title: q ? `No place matches "${q}".` : `No ${kindLabel(kind).toLowerCase()} places.`,
            text: 'Try other words or another kind. Search looks at names and notes.',
            iconName: 'search',
            action: h('a', { class: 'btn quiet small', href: href('places'), text: 'Show every place' }),
        });
    } else body = placesTable(shown.map(placeRow));

    return h('div', { class: 'tab-panel', id: 'panel-places', role: 'tabpanel', 'aria-labelledby': 'tab-places' },
        checkBox(ctx, kinds),
        all.length ? h('div', { class: 'toolbar' }, kindNav, searchForm) : null,
        h('section', { 'aria-labelledby': all.length ? 'p-count' : null, 'aria-label': all.length ? null : 'Places', class: 'places-list' },
            all.length ? h('h2', { id: 'p-count', class: 'section-title', text: shown.length === all.length ? plural(all.length, 'place') : `${shown.length} of ${plural(all.length, 'place')}` }) : null,
            body));
}

/* ---------- Needs a name tab ---------- */

function queueItem(ctx, s, { places, kinds, next }) {
    const decided = s.status !== 'pending';
    const named = s.status === 'accepted' && places.find((p) => p.id === s.resolved_place_id);
    const after = () => { focusAfter = next; ctx.rerender(); };

    const nameIt = button({ text: 'Name it', size: 'small', 'data-key': `q:${s.id}:name`, onClick: async () => {
        const res = await formDialog({
            title: 'Name this spot',
            intro: [h('p', { class: 'dialog-intro' }, 'Creates a place with ', h('strong', { text: s.street }), ' as its first street rule.')],
            fields: placeFields(kinds),
            submit: 'Create place',
            onSubmit: async (form) => {
                const body = placeBody(form);
                await ctx.api(`/places/suggestions/${s.id}/accept`, { method: 'POST', body });
                return body;
            },
        });
        if (!res) return;
        toast(`Place ${res.label} created`);
        after();
    } });

    const attach = places.length ? button({ text: 'Add to existing place', variant: 'quiet', size: 'small', 'data-key': `q:${s.id}:attach`, onClick: async () => {
        const sorted = places.slice().sort((a, b) => a.label.localeCompare(b.label));
        const sel = h('select', { name: 'place' }, sorted.map((p) => h('option', { value: String(p.id), text: `${p.label} (${kindLabel(p.kind).toLowerCase()})` })));
        const res = await formDialog({
            title: 'Add to an existing place',
            intro: [h('p', { class: 'dialog-intro' }, 'Adds ', h('strong', { text: s.street }), ' as a street rule to the place you pick.')],
            fields: [field('Place', sel)],
            submit: 'Add to place',
            onSubmit: async () => {
                const p = sorted.find((x) => String(x.id) === sel.value);
                await ctx.api(`/places/suggestions/${s.id}/accept`, { method: 'POST', body: { place_id: p.id } });
                return p;
            },
        });
        if (!res) return;
        toast(`Added to ${res.label}`);
        after();
    } }) : null;

    const dismiss = s.status === 'dismissed' ? null : button({ text: 'Dismiss', variant: 'ghost', size: 'small', 'data-key': `q:${s.id}:dismiss`, onClick: async () => {
        const ok = await confirmDialog({
            title: 'Dismiss this spot?',
            body: ['It leaves the queue and stays dismissed: later sightings only raise its count.', 'You can still name it from Dismissed.'],
            confirm: 'Dismiss',
        });
        if (!ok) return;
        try {
            await ctx.api(`/places/suggestions/${s.id}/dismiss`, { method: 'POST' });
            toast('Spot dismissed');
            after();
        } catch (err) {
            toast(`Could not dismiss it. ${err.message}`, { kind: 'bad' });
        }
    } });

    const remove = button({ text: 'Delete', variant: 'quiet-danger', size: 'small', 'data-key': `q:${s.id}:delete`, label: `Delete the spot ${s.street} permanently`, onClick: async () => {
        const out = await deleteDialog({
            title: 'Delete this spot?',
            goes: ['The spot from the Needs a name queue', s.status === 'accepted' ? 'Only the queue entry: the place it became stays' : null].filter(Boolean),
            stays: ['Your places and their rules'],
            run: (o) => ctx.api(`/places/suggestions/${s.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
        });
        if (!out) return;
        toast('Deleted the spot');
        after();
    } });

    return h('li', { class: `queue-item is-${s.status}` },
        h('div', { class: 'q-main' },
            h('h3', { class: 'q-street', text: s.street }),
            h('dl', { class: 'q-facts' },
                fact('Seen', s.count === 1 ? 'once' : `${s.count.toLocaleString()} times`),
                fact('First seen', h('time', { datetime: s.first_seen, title: when(s.first_seen), text: ago(s.first_seen) })),
                fact('Last seen', h('time', { datetime: s.last_seen, title: when(s.last_seen), text: ago(s.last_seen) }))),
            s.example_text ? h('p', { class: 'q-example' }, h('span', { class: 'muted', text: 'Example: ' }), h('q', { text: s.example_text })) : null,
            decided ? h('p', { class: 'q-status' },
                s.status === 'accepted'
                    ? ['Named ', s.decided_at ? ago(s.decided_at) : '', named ? [': ', h('a', { class: 'link', href: placeHref(named.id), text: named.label })] : '']
                    : `Dismissed ${s.decided_at ? ago(s.decided_at) : ''}`) : null),
        h('div', { class: 'q-actions' }, ...(s.status === 'accepted' ? [remove] : [nameIt, attach, dismiss, remove])));
}

async function deleteAllDismissed(ctx, n) {
    const out = await deleteDialog({
        title: `Delete all ${n} dismissed ${n === 1 ? 'spot' : 'spots'}?`,
        goes: [plural(n, 'dismissed spot'), 'A street seen again after this is filed as a new spot'],
        stays: ['Your places and their rules', 'Spots waiting or already named'],
        run: (o) => ctx.api('/places/suggestions/dismissed', { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
    });
    if (!out) return;
    toast(`Deleted ${plural(out.count, 'dismissed spot')}`);
    ctx.rerender();
}

function queueTab(ctx, sug, places, kinds) {
    const show = SHOW.some(([id]) => id === ctx.route.query.get('show')) ? ctx.route.query.get('show') : 'pending';
    const counts = sug.counts;
    const total = counts.pending + counts.accepted + counts.dismissed;
    const nav = chipNav({
        label: 'Which spots',
        current: show,
        items: SHOW.map(([id, label]) => ({
            id,
            label: `${label} ${id === 'all' ? total : counts[id]}`,
            href: href('places', [], { tab: 'queue', show: id === 'pending' ? null : id }),
        })),
    });
    const list = sug.suggestions;
    const keyFor = (i) => {
        const n = list[i + 1] || list[i - 1];
        return n ? `q:${n.id}:name` : 'tab:queue';
    };
    let body;
    if (!list.length) {
        body = show === 'pending'
            ? emptyState({
                title: 'Nothing waiting.',
                text: 'New spots show up here when the nightly digest sees a place it does not know.',
                iconName: 'good',
                action: counts.dismissed || counts.accepted
                    ? h('a', { class: 'btn quiet small', href: href('places', [], { tab: 'queue', show: 'all' }), text: 'See the ones already decided' })
                    : h('a', { class: 'btn quiet small', href: href('places'), text: 'Open your places' }),
            })
            : emptyState({
                title: { accepted: 'No spot has been named yet.', dismissed: 'No spot has been dismissed.', all: 'The queue has never had a spot.' }[show],
                text: 'Spots arrive when the nightly digest sees a street that no place claims.',
                iconName: 'info',
                action: h('a', { class: 'btn quiet small', href: href('places', [], { tab: 'queue' }), text: 'Back to waiting' }),
            });
    } else body = h('ul', { class: 'queue-list' }, list.map((s, i) => queueItem(ctx, s, { places, kinds, next: keyFor(i) })));

    return h('div', { class: 'tab-panel', id: 'panel-queue', role: 'tabpanel', 'aria-labelledby': 'tab-queue' },
        h('p', { class: 'note', text: 'Streets the nightly digest saw that no place claims, most recent first. Name one to turn it into a place, add it to a place you have, or dismiss it.' }),
        h('div', { class: 'toolbar' }, nav,
            (show === 'dismissed' || show === 'all') && counts.dismissed > 0
                ? button({ text: `Delete all dismissed (${counts.dismissed})`, variant: 'quiet-danger', size: 'small', iconName: 'trash', 'data-key': 'delete-dismissed', onClick: () => deleteAllDismissed(ctx, counts.dismissed) })
                : null),
        h('section', { 'aria-labelledby': 'q-count', class: 'queue' },
            h('h2', { id: 'q-count', class: 'section-title', text: show === 'pending' ? `${plural(list.length, 'spot')} waiting` : plural(list.length, 'spot') }),
            body));
}

/* ---------- view ---------- */

export async function render(ctx) {
    const tab = ctx.route.query.get('tab') === 'queue' ? 'queue' : 'places';
    const show = ctx.route.query.get('show');
    const status = SHOW.some(([id]) => id === show) ? show : 'pending';
    const [data, sug] = await Promise.all([
        ctx.api('/places'),
        tab === 'queue' ? ctx.api(`/places/suggestions?status=${status}&limit=200`) : null,
    ]);
    const kinds = data.kinds || KIND_FALLBACK;
    const counts = (sug && sug.counts) || data.suggestions;

    syncDrawer(ctx, data.places, kinds);
    lastWasList = !ctx.route.parts[0];
    ctx.onCleanup(() => {
        if (drawer && parse().name !== 'places') { const d = drawer; drawer = null; d.handle.close(true); }
    });
    if (ctx.route.query.get('new') === '1') {
        navigate(href('places'), { replace: true });
        setTimeout(() => newPlace(ctx, kinds), 0);
    }
    if (focusAfter) {
        const key = focusAfter;
        focusAfter = null;
        setTimeout(() => {
            const el = document.querySelector(`[data-key="${key}"]`) || document.querySelector('[data-key="tab:queue"]');
            if (el) el.focus();
        }, 0);
    }

    const create = button({ text: 'New place', iconName: 'plus', 'data-key': 'new-place', onClick: () => newPlace(ctx, kinds) });
    return h('div', { class: 'view places' },
        pageHeader({ lede: 'The spots your digests name instead of a street. Each place has rules that recognise a location as it; agents ask the hub which place a location is.', actions: create }),
        tabBar(tab, counts.pending),
        tab === 'queue' ? queueTab(ctx, sug, data.places, kinds) : placesTab(ctx, data));
}
