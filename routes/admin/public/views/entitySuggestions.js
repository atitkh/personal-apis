// The "Suggested" tab of the Entities page: names the nightly job saw that no entity claims yet.
//   #/entities?tab=suggested               waiting names; ?show=accepted|dismissed|all for the ones already decided
// Accept makes an entity (kind, name, aliases and notes can be changed first) or adds the name as another name of an
// entity you have; dismiss keeps the name out for good (later sightings only raise its count). Names are plain text.
import {
    h, button, plural, when, ago, emptyState, toast, confirmDialog, formDialog, deleteDialog, chipNav, fact, hidden } from '../ui.js';
import { href, navigate } from '../router.js';

const TABS = [['entities', 'Entities'], ['suggested', 'Suggested']];
const SHOW = [['pending', 'Waiting'], ['accepted', 'Added'], ['dismissed', 'Dismissed'], ['all', 'All']];
const STATUS_WORD = { pending: 'waiting', accepted: 'added', dismissed: 'dismissed', all: '' };
const KINDS = [['person', 'Person'], ['project', 'Project'], ['organization', 'Organization'], ['topic', 'Topic'], ['other', 'Other']];

let focusAfter = null;
export const takeFocus = () => { const k = focusAfter; focusAfter = null; return k; };

export function tabBar(current, pending) {
    const list = h('div', { class: 'vtabs', role: 'tablist', 'aria-label': 'Entities sections' });
    const tabs = TABS.map(([id, label]) => {
        const on = id === current;
        const target = id === 'entities' ? href('entities') : href('entities', [], { tab: id });
        return h('button', {
            type: 'button', role: 'tab', class: 'vtab', id: `tab-${id}`, 'data-key': `tab:${id}`,
            'aria-selected': String(on), 'aria-controls': on ? `panel-${id}` : null, tabindex: on ? '0' : '-1', 'data-href': target,
            onclick: () => { if (!on) navigate(target); },
        }, h('span', { text: label }),
        id === 'suggested' && pending ? [h('span', { class: 'badge', 'aria-hidden': 'true', text: String(pending) }), hidden(`, ${pending} waiting`)] : null);
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

let fid = 0;
const field = (label, input) => {
    fid += 1;
    input.id = input.id || `esf-${fid}`;
    return h('div', { class: 'field' }, h('label', { for: input.id, text: label }), input);
};

function item(ctx, s, entities, next) {
    const decided = s.status !== 'pending';
    const target = s.resolved_entity_id && entities.find((e) => e.id === s.resolved_entity_id);
    const after = () => { focusAfter = next; ctx.rerender(); };

    const add = button({ text: 'Add as entity', size: 'small', 'data-key': `s:${s.id}:add`, onClick: async () => {
        const kind = h('select', { name: 'kind' }, KINDS.map(([k, l]) => h('option', { value: k, text: l, selected: k === s.kind ? '' : null })));
        const name = h('input', { type: 'text', name: 'name', maxlength: '120', value: s.name, autocomplete: 'off' });
        const aliases = h('input', { type: 'text', name: 'aliases', autocomplete: 'off', placeholder: 'Other names, comma separated' });
        const notes = h('textarea', { name: 'notes', rows: '3', maxlength: '2000', placeholder: 'Optional notes' });
        const res = await formDialog({
            title: 'Add as an entity',
            intro: [h('p', { class: 'dialog-intro' }, 'Creates an entity from ', h('strong', { text: s.name }), '. You can change the kind and name first.')],
            fields: [field('Kind', kind), field('Name', name), field('Other names', aliases), field('Notes', notes)],
            submit: 'Add entity',
            onSubmit: async () => {
                const body = { kind: kind.value, name: name.value.trim(), aliases: aliases.value, notes: notes.value.trim() || null };
                const out = await ctx.api(`/entities/suggestions/${s.id}/accept`, { method: 'POST', body });
                return out.entity;
            },
        });
        if (!res) return;
        toast(`Added ${res.name}`);
        after();
    } });

    const alias = entities.length ? button({ text: 'Another name of…', variant: 'quiet', size: 'small', 'data-key': `s:${s.id}:alias`, onClick: async () => {
        const sorted = entities.slice().sort((a, b) => a.name.localeCompare(b.name));
        const sel = h('select', { name: 'entity' }, sorted.map((e) => h('option', { value: String(e.id), text: `${e.name} (${e.kind})` })));
        const res = await formDialog({
            title: 'Another name of an entity',
            intro: [h('p', { class: 'dialog-intro' }, 'Adds ', h('strong', { text: s.name }), ' to the other names of the entity you pick.')],
            fields: [field('Entity', sel)],
            submit: 'Add the name',
            onSubmit: async () => {
                const e = sorted.find((x) => String(x.id) === sel.value);
                await ctx.api(`/entities/suggestions/${s.id}/accept`, { method: 'POST', body: { entity_id: e.id } });
                return e;
            },
        });
        if (!res) return;
        toast(`Added to ${res.name}`);
        after();
    } }) : null;

    const dismiss = s.status === 'dismissed' ? null : button({ text: 'Dismiss', variant: 'ghost', size: 'small', 'data-key': `s:${s.id}:dismiss`, onClick: async () => {
        const ok = await confirmDialog({
            title: 'Dismiss this name?',
            body: ['It leaves the queue and stays dismissed: later sightings only raise its count.', 'You can still add it from Dismissed.'],
            confirm: 'Dismiss',
        });
        if (!ok) return;
        try {
            await ctx.api(`/entities/suggestions/${s.id}/dismiss`, { method: 'POST' });
            toast('Name dismissed');
            after();
        } catch (err) { toast(`Could not dismiss it. ${err.message}`, { kind: 'bad' }); }
    } });

    const remove = button({ text: 'Delete', variant: 'quiet-danger', size: 'small', 'data-key': `s:${s.id}:delete`, label: `Delete the suggested name ${s.name} permanently`, onClick: async () => {
        const out = await deleteDialog({
            title: 'Delete this name?',
            goes: ['The name from the suggestions queue', s.status === 'accepted' ? 'Only the queue entry: the entity it became stays' : null].filter(Boolean),
            stays: ['Your entities and their links'],
            run: (o) => ctx.api(`/entities/suggestions/${s.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
        });
        if (!out) return;
        toast('Deleted the name');
        after();
    } });

    return h('li', { class: `queue-item is-${s.status}` },
        h('div', { class: 'q-main' },
            h('h3', { class: 'q-street', text: s.name }),
            h('dl', { class: 'q-facts' },
                fact('Looks like', (KINDS.find(([k]) => k === s.kind) || [, 'Other'])[1]),
                fact('Seen', s.count === 1 ? 'once' : `${s.count.toLocaleString()} times`),
                fact('Last seen', h('time', { datetime: s.last_seen, title: when(s.last_seen), text: ago(s.last_seen) }))),
            s.example ? h('p', { class: 'q-example' }, h('span', { class: 'muted', text: 'Seen: ' }), h('q', { text: s.example })) : null,
            decided ? h('p', { class: 'q-status' },
                s.status === 'accepted'
                    ? ['Added ', s.decided_at ? ago(s.decided_at) : '', target ? [': ', h('a', { class: 'link', href: href('entities', [String(target.id)]), text: target.name })] : '']
                    : `Dismissed ${s.decided_at ? ago(s.decided_at) : ''}`) : null),
        h('div', { class: 'q-actions' }, ...(s.status === 'accepted' ? [remove] : [add, alias, dismiss, remove])));
}

async function dismissAll(ctx, n) {
    const ok = await confirmDialog({
        title: `Dismiss all ${n} waiting ${n === 1 ? 'name' : 'names'}?`,
        body: ['They leave the queue and stay dismissed: later sightings only raise their counts.', 'You can still add any of them from Dismissed.'],
        confirm: 'Dismiss all',
    });
    if (!ok) return;
    try {
        const r = await ctx.api('/entities/suggestions/dismiss-all', { method: 'POST', body: {} });
        toast(`Dismissed ${plural(r.count, 'name')}`);
        ctx.rerender();
    } catch (err) { toast(`Could not dismiss them. ${err.message}`, { kind: 'bad' }); }
}

async function deleteAll(ctx, status, n) {
    const word = STATUS_WORD[status];
    const out = await deleteDialog({
        title: `Delete all ${n} ${word ? `${word} ` : ''}${n === 1 ? 'name' : 'names'}?`,
        goes: [plural(n, `${word ? `${word} ` : ''}name`), 'A name seen again after this is filed as new'],
        stays: ['Your entities and their links', status === 'all' ? 'Nothing else in the queue' : 'Names with another status'],
        run: (o) => ctx.api('/entities/suggestions', { method: 'DELETE', body: { confirm: true, status, backup: o.backup } }),
    });
    if (!out) return;
    toast(`Deleted ${plural(out.count, 'name')}`);
    ctx.rerender();
}

export function suggestionsTab(ctx, sug, entities) {
    const show = SHOW.some(([id]) => id === ctx.route.query.get('show')) ? ctx.route.query.get('show') : 'pending';
    const counts = sug.counts;
    const total = counts.pending + counts.accepted + counts.dismissed;
    const nav = chipNav({
        label: 'Which names', current: show,
        items: SHOW.map(([id, label]) => ({ id, label: `${label} ${id === 'all' ? total : counts[id]}`, href: href('entities', [], { tab: 'suggested', show: id === 'pending' ? null : id }) })),
    });
    const list = sug.suggestions;
    const keyFor = (i) => { const n = list[i + 1] || list[i - 1]; return n ? `s:${n.id}:add` : 'tab:suggested'; };
    const body = list.length
        ? h('ul', { class: 'queue-list' }, list.map((s, i) => item(ctx, s, entities, keyFor(i))))
        : emptyState({
            title: show === 'pending' ? 'Nothing waiting.' : 'Nothing here.',
            text: 'Names show up here when the nightly update sees a person, project or organization that is not an entity yet.',
            iconName: show === 'pending' ? 'good' : 'info',
            action: show === 'pending' ? null : h('a', { class: 'btn quiet small', href: href('entities', [], { tab: 'suggested' }), text: 'Back to waiting' }),
        });
    const n = { pending: counts.pending, accepted: counts.accepted, dismissed: counts.dismissed, all: total }[show];
    return h('div', { class: 'tab-panel', id: 'panel-suggested', role: 'tabpanel', 'aria-labelledby': 'tab-suggested' },
        h('p', { class: 'note', text: 'Names the nightly update saw that no entity claims, most recent first. Add one as an entity, add it as another name of an entity you have, or dismiss it.' }),
        h('div', { class: 'toolbar' }, nav,
            (show === 'pending' || show === 'all') && counts.pending > 0
                ? button({ text: `Dismiss all waiting (${counts.pending})`, variant: 'quiet', size: 'small', iconName: 'close', 'data-key': 'dismiss-all', onClick: () => dismissAll(ctx, counts.pending) }) : null,
            n > 0 ? button({ text: `Delete all${STATUS_WORD[show] ? ` ${STATUS_WORD[show]}` : ''} (${n})`, variant: 'quiet-danger', size: 'small', iconName: 'trash', 'data-key': 'delete-all-names', onClick: () => deleteAll(ctx, show, n) }) : null),
        h('section', { 'aria-labelledby': 'es-count', class: 'queue' },
            h('h2', { id: 'es-count', class: 'section-title', text: show === 'pending' ? `${plural(list.length, 'name')} waiting` : plural(list.length, 'name') }),
            body));
}
