// Entities: the people, projects, organizations and topics your records are linked to.
//   #/entities                the list (?kind=person|project|organization|topic|other and ?q= narrow it)
//   #/entities/12             that entity's drawer: edit, Linked records, history (restore), delete permanently
//   #/entities?new=1          the New entity dialog (the palette uses it)
// Names, aliases and notes are your own text and go in as text. Deleting is permanent and takes the entity's links with it;
// the records themselves stay.
import { linkedSection } from './linked.js';
import {
    h, icon, button, chip, plural, ago, when, emptyState, errorState, toast, confirmDialog, deleteDialog, openDrawer, actorName,
    pageHeader, formActions, chipNav, domainHue } from '../ui.js';
import { href, navigate, parse } from '../router.js';

const KINDS = [['person', 'Person', 'People'], ['project', 'Project', 'Projects'], ['organization', 'Organization', 'Organizations'],
    ['topic', 'Topic', 'Topics'], ['other', 'Other', 'Other']];
const KIND = Object.fromEntries(KINDS.map(([k, one]) => [k, one]));
const FIELDS = ['kind', 'name', 'aliases', 'notes'];
const entHref = (id) => href('entities', [String(id)]);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const fieldError = (message, name) => Object.assign(new Error(message), { field: name });
const aliasList = (text) => String(text || '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

let drawer = null;        // { id, handle, fromList } the entity drawer that matches the URL
let side = null;          // the New entity drawer (not in the URL)
let lastWasList = false;
let focusAfter = null;

/* ---------- the form (New, and edit in the drawer) ---------- */

let fieldId = 0;
function field(label, input, help) {
    const id = input.id || `ef-${++fieldId}`;
    input.id = id;
    const helpId = help ? `${id}-help` : null;
    const errId = `${id}-err`;
    const err = h('p', { class: 'error field-msg', role: 'alert', id: errId });
    input.setAttribute('aria-describedby', [helpId, errId].filter(Boolean).join(' '));
    return { err, el: h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('p', { class: 'help', id: helpId, text: help }) : null, err) };
}

const startValues = (e) => ({ kind: (e && e.kind) || 'person', name: (e && e.name) || '', aliases: e ? e.aliases.join(', ') : '', notes: (e && e.notes) || '' });
const clean = (v) => ({ kind: v.kind, name: String(v.name).trim().replace(/\s+/g, ' '), aliases: aliasList(v.aliases), notes: String(v.notes).trim() || null });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function entityForm({ values, mode, submit, onSave, onCancel, onDirty }) {
    const base = clean(values);
    const kind = h('select', { name: 'kind', 'data-key': 'ef-kind' }, KINDS.map(([k, one]) => h('option', { value: k, text: one })));
    kind.value = values.kind;
    const name = h('input', { type: 'text', name: 'name', maxlength: '120', autocomplete: 'off', placeholder: 'Mira', value: values.name, 'data-key': 'ef-name' });
    const aliases = h('input', { type: 'text', name: 'aliases', autocomplete: 'off', placeholder: 'MD, Mira D.', value: values.aliases, 'data-key': 'ef-aliases' });
    const notes = h('textarea', { name: 'notes', rows: '4', maxlength: '2000', class: 'plain', 'data-key': 'ef-notes' });
    notes.value = values.notes;
    const inputs = { kind, name, aliases, notes };
    const fKind = field('Kind', kind);
    const fName = field('Name', name);
    const fAliases = field('Other names (optional)', aliases, 'Separate with commas, up to 10. Search and agents find the entity by any of them.');
    const fNotes = field('Notes (optional)', notes);
    const errs = { kind: fKind.err, name: fName.err, aliases: fAliases.err, notes: fNotes.err };
    const formError = h('p', { class: 'error', role: 'alert' });
    const save = button({ text: submit, type: 'submit', size: 'small', 'data-key': 'ef-save' });

    const current = () => clean({ kind: kind.value, name: name.value, aliases: aliases.value, notes: notes.value });
    const dirty = () => { const now = current(); return FIELDS.some((k) => !same(now[k], base[k])); };
    const showError = (err) => {
        const which = err.field || (err.data && err.data.field);
        for (const e of Object.values(errs)) e.textContent = '';
        formError.textContent = '';
        (errs[which] || formError).textContent = err.message;
        if (inputs[which]) inputs[which].focus();
    };

    const form = h('form', {
        class: 'place-form entity-form', novalidate: true,
        oninput: () => onDirty && onDirty(),
        onchange: () => onDirty && onDirty(),
        onsubmit: async (event) => {
            event.preventDefault();
            showError({ message: '' });
            save.disabled = true;
            try {
                const now = current();
                if (!now.name) throw fieldError('Give it a name.', 'name');
                const body = mode === 'create' ? { ...now } : Object.fromEntries(FIELDS.filter((k) => !same(now[k], base[k])).map((k) => [k, now[k]]));
                await onSave(body);
            } catch (err) {
                showError(err);
                save.disabled = false;
            }
        },
    }, fKind.el, fName.el, fAliases.el, fNotes.el, formError,
    formActions(save, onCancel ? button({ text: 'Cancel', variant: 'quiet', onClick: onCancel }) : null));
    return { el: form, dirty, save };
}

/* ---------- delete ---------- */

// Permanent delete. Resolves the answer, or null when cancelled.
async function deleteIt(ctx, e) {
    let pre;
    try { pre = await ctx.api(`/entities/${e.id}/delete-preview`); } catch (err) { if (err.status !== 401) toast(`Could not check what a delete would take. ${err.message}`, { kind: 'bad' }); return null; }
    const out = await deleteDialog({
        title: `Delete ${pre.label}?`,
        goes: [`The ${(KIND[pre.kind] || pre.kind).toLowerCase()} ${pre.label}, its other names and notes`, plural(pre.counts.links, 'link'), plural(pre.counts.revisions, 'revision')],
        stays: ['The records it was linked to (trips, deadlines and so on)', 'Anything outside this hub'],
        run: (o) => ctx.api(`/entities/${e.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
    });
    if (out) toast(`Deleted ${pre.label}`);
    return out;
}

/* ---------- the drawer for one entity ---------- */

function closeDrawerTo(fromList) {
    if (fromList && history.length > 1) history.back();
    else navigate(href('entities'), { replace: true });
}

function entityDrawer(ctx, id, fromList, mark) {
    let item = null;
    let form = null;

    const handle = openDrawer({
        title: 'Entity',
        subtitle: 'Loading…',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard your changes?', body: 'The entity keeps what was last saved.', confirm: 'Discard', danger: true }),
        onClose: () => {
            if (drawer && drawer.handle === handle) { drawer = null; closeDrawerTo(fromList); }
        },
        returnFocus: () => document.querySelector(`[data-key="entity:${id}"]`) || document.querySelector('[data-key="new-entity"]'),
    });

    async function changed() {
        await load();
        ctx.rerender();
    }

    async function load() {
        const top = handle.body.scrollTop;
        try {
            item = await ctx.api(`/entities/${id}`);
        } catch (err) {
            if (err.status === 401) return;
            if (err.status === 404) {
                toast('That entity is gone or never existed.', { kind: 'info' });
                drawer = null;
                handle.close(true);
                closeDrawerTo(fromList);
                return;
            }
            handle.setTitle('Entity', '');
            handle.setContent(errorState({ err, what: 'This entity', retry: load }));
            return;
        }
        handle.setTitle(item.name, `${KIND[item.kind] || item.kind}, revision ${item.rev}`);
        handle.setContent(content());
        handle.body.scrollTop = top;
    }

    async function restore(rev) {
        const ok = await confirmDialog({
            title: `Restore revision ${rev}?`,
            body: `The kind, name, other names and notes of revision ${rev} become current, as a new revision. What you see now stays in the history.`,
            confirm: 'Restore',
        });
        if (!ok) return;
        try {
            const res = await ctx.api(`/entities/${item.id}/restore`, { method: 'POST', body: { rev } });
            toast(res.status === 'unchanged' ? 'That revision is the same as the current one' : `Revision ${rev} restored`, { kind: res.status === 'unchanged' ? 'info' : 'good' });
            form = null;
            changed();
        } catch (err) {
            toast(`Could not restore. ${err.message}`, { kind: 'bad' });
        }
    }

    function content() {
        form = entityForm({
            values: startValues(item),
            mode: 'edit',
            submit: 'Save changes',
            onSave: async (body) => {
                if (!Object.keys(body).length) { toast('Nothing changed', { kind: 'info' }); form.save.disabled = false; return; }
                const res = await ctx.api(`/entities/${item.id}`, { method: 'PATCH', body });
                toast(res.status === 'unchanged' ? 'Nothing changed' : 'Changes saved', { kind: res.status === 'unchanged' ? 'info' : 'good' });
                form = null;
                await changed();
            },
        });
        return [
            h('section', { class: 'drawer-section', 'aria-labelledby': 'ed-details' },
                h('h3', { id: 'ed-details', text: 'Details' }),
                form.el,
                h('dl', { class: 'facts' },
                    h('dt', { text: 'Added' }), h('dd', { text: when(item.created_at) }),
                    h('dt', { text: 'Last changed' }), h('dd', { text: `${ago(item.updated_at)} by ${actorName(item.updated_by)}` }))),
            linkedSection(ctx, 'entities', item.id),
            h('section', { class: 'drawer-section', 'aria-labelledby': 'ed-history' },
                h('h3', { id: 'ed-history', tabindex: '-1', 'data-key': 'history', text: `History, ${plural(item.history.length, 'revision')}` }),
                h('p', { class: 'note', text: 'Every change is kept. Restoring adds a new revision, so nothing is lost.' }),
                h('ol', { class: 'rev-list', reversed: true }, item.history.map((r) => h('li', { class: `rev${r.current ? ' current' : ''}` },
                    h('div', { class: 'rev-main' },
                        h('p', { class: 'rev-title' }, `Revision ${r.rev}`, r.current ? h('span', { class: 'chip', text: 'Current' }) : null),
                        h('p', { class: 'rev-what', text: `${{ create: 'Created', edit: 'Edited', restore: 'Restored' }[r.source] || cap(r.source)} by ${actorName(r.actor)}${r.note ? `: ${r.note}` : ''}` }),
                        h('p', { class: 'rev-when' }, h('time', { datetime: r.at, text: when(r.at) }), ` (${ago(r.at)})`)),
                    r.current ? null : h('div', { class: 'rev-actions' },
                        button({ text: 'Restore', variant: 'quiet', size: 'small', label: `Restore revision ${r.rev}`, onClick: () => restore(r.rev) })))))),
            h('section', { class: 'drawer-section danger-zone' },
                h('p', { class: 'note', text: `Deleting erases this entity, its history and its ${plural(item.link_count || 0, 'link')} for good. The records it was linked to stay.` }),
                h('div', { class: 'row' }, button({
                    text: 'Delete permanently', variant: 'quiet-danger', iconName: 'trash', 'data-key': 'drawer-delete',
                    onClick: async () => {
                        if (!(await deleteIt(ctx, item))) return;
                        form = null;
                        drawer = null;
                        handle.close(true);
                        closeDrawerTo(fromList);
                        ctx.rerender();
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
    if (raw && !id) { navigate(href('entities'), { replace: true }); return; }
    if ((drawer ? drawer.id : null) === id) return;
    if (drawer) { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
    if (!id) return;
    const mark = { id, handle: null, fromList: lastWasList };
    drawer = mark;
    setTimeout(() => { if (drawer === mark) entityDrawer(ctx, id, mark.fromList, mark); }, 0);
}

/* ---------- New entity ---------- */

function closeSide(force = true) {
    if (side) { const s = side; side = null; s.close(force); }
}

function addEntity(ctx, kind) {
    if (side) return;
    let form = null;
    const handle = openDrawer({
        title: 'New entity',
        subtitle: 'A person, project, organization or topic your records can be linked to.',
        content: h('p', { class: 'muted', text: 'Loading…' }),
        beforeClose: async () => !(form && form.dirty()) || confirmDialog({ title: 'Discard this entity?', body: 'Nothing has been saved yet.', confirm: 'Discard', danger: true }),
        onClose: () => { if (side === handle) side = null; },
        returnFocus: () => document.querySelector('[data-key="new-entity"]') || document.querySelector('[data-key="empty-new"]'),
    });
    side = handle;
    form = entityForm({
        values: { ...startValues(null), kind: kind || 'person' },
        mode: 'create',
        submit: 'Add entity',
        onCancel: () => handle.close(),
        onSave: async (body) => {
            const res = await ctx.api('/entities', { method: 'POST', body });
            toast('Entity added');
            form = null;
            side = null;
            handle.close(true);
            focusAfter = `entity:${res.id}`;
            ctx.rerender();
        },
    });
    handle.setContent(form.el);
    const first = handle.body.querySelector('input[name="name"]');
    if (first) first.focus();
}

/* ---------- the list ---------- */

function entityRow(e) {
    const link = h('a', { class: 'row-link', href: entHref(e.id), 'data-key': `entity:${e.id}` }, e.name);
    return h('li', { class: 'entity-row', 'data-id': String(e.id), onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('div', { class: 'entity-main' },
            h('p', { class: 'entity-name' }, link, ' ', chip(KIND[e.kind] || e.kind, { hue: domainHue('entities') })),
            e.aliases.length ? h('p', { class: 'entity-aliases muted', text: `Also: ${e.aliases.join(', ')}` }) : null,
            e.notes ? h('p', { class: 'entity-notes muted', text: e.notes.length > 140 ? `${e.notes.slice(0, 139)}…` : e.notes }) : null),
        h('div', { class: 'row-actions' },
            h('span', { class: 'entity-links muted', text: plural(e.link_count || 0, 'link') }),
            h('a', { class: 'btn quiet small', href: entHref(e.id), 'aria-label': `Open ${e.name}`, text: 'Open' })));
}

export async function render(ctx) {
    const q = ctx.route.query;
    const idRaw = ctx.route.parts[0];
    const kindRaw = q.get('kind') || '';
    const kind = KIND[kindRaw] ? kindRaw : '';
    const text = (q.get('q') || '').trim();

    const data = await ctx.api('/entities?limit=200');

    syncDrawer(ctx);
    lastWasList = !idRaw;
    ctx.onCleanup(() => {
        if (drawer && parse().name !== 'entities') { const d = drawer; drawer = null; if (d.handle) d.handle.close(true); }
        if (side && parse().name !== 'entities') closeSide();
    });
    if (q.get('new') === '1' && !idRaw) {
        navigate(href('entities'), { replace: true });
        setTimeout(() => addEntity(ctx), 0);
    }
    if (focusAfter) {
        const key = focusAfter;
        focusAfter = null;
        setTimeout(() => { const el = document.querySelector(`[data-key="${key}"]`); if (el) el.focus(); }, 0);
    }

    const all = data.entities;
    const needle = text.toLowerCase();
    const shown = all.filter((e) => (!kind || e.kind === kind)
        && (!needle || [e.name, e.notes, ...e.aliases].some((t) => t && String(t).toLowerCase().includes(needle))));

    const query = (patch) => ({ kind, q: text, ...patch });
    const chips = chipNav({
        label: 'Filter by kind',
        current: kind || 'all',
        items: [{ id: 'all', label: 'All', href: href('entities', [], query({ kind: '' })) },
            ...KINDS.map(([k, , many]) => ({ id: k, label: many, href: href('entities', [], query({ kind: k })) }))],
    });
    const search = h('input', { type: 'search', name: 'q', value: text, placeholder: 'Search entities', 'aria-label': 'Search entities by name, other name or notes', 'data-key': 'e-search', enterkeyhint: 'search' });
    const searchForm = h('form', { class: 'search-form', role: 'search', onsubmit: (event) => { event.preventDefault(); navigate(href('entities', [], query({ q: search.value.trim() }))); } },
        icon('search', 'search-icon'), search,
        text ? h('a', { class: 'btn ghost small', href: href('entities', [], query({ q: '' })), text: 'Clear' }) : null);

    let body;
    if (!all.length) {
        body = emptyState({
            title: 'No entities yet.',
            text: 'Add the people, projects, organizations and topics you want to link records to, like a trip for a person or a deadline for a project.',
            iconName: 'user',
            action: button({ text: 'New entity', size: 'small', iconName: 'plus', 'data-key': 'empty-new', onClick: () => addEntity(ctx) }),
        });
    } else if (!shown.length) {
        body = emptyState({ title: 'No entity matches.', text: 'Try other words or another kind.', iconName: 'search',
            action: h('a', { class: 'btn quiet small', href: href('entities'), text: 'Show every entity' }) });
    } else body = h('ul', { class: 'entity-list' }, shown.map(entityRow));

    const add = button({ text: 'New entity', iconName: 'plus', 'data-key': 'new-entity', onClick: () => addEntity(ctx, kind || undefined) });
    return h('div', { class: 'view entities' },
        pageHeader({ lede: 'The people, projects, organizations and topics your records can be linked to. Search finds them by name or any other name.', actions: add }),
        all.length ? h('div', { class: 'toolbar filter-bar' }, h('div', { class: 'filters' }, chips), searchForm) : null,
        h('div', { class: 'entity-panel' },
            all.length ? h('p', { class: 'note entity-total', 'aria-live': 'polite', text: kind || text ? `${shown.length} of ${plural(all.length, 'entity', 'entities')}` : plural(all.length, 'entity', 'entities') }) : null,
            body));
}
