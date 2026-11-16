// Notes: your pages, written in markdown, linked to each other and to your records with [[wikilinks]].
//   #/notes                   the list (?kind= ?tag= ?q= ?pinned=1 narrow it; ?removed=1 is the trash)
//   #/notes/12                that note in the editor (views/noteEditor.js)
//   #/notes/new               a new note (?title= ?kind= ?tag= fill it in)
// Titles, previews and tags are your own text and go in as text. Deleting is a trash first; emptying it for good is permanent
// and takes the note's links with it (the records and notes it pointed at stay).
import { renderEditor } from './noteEditor.js';
import {
    h, icon, button, chip, plural, ago, when, emptyState, toast, deleteDialog, actorName, pageHeader, chipNav, domainHue } from '../ui.js';
import { href, navigate } from '../router.js';

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const byLine = (n) => (n.updated_by === 'admin' ? 'by you' : `by agent ${actorName(n.updated_by)}`);

async function purge(ctx, n) {
    let pre;
    try { pre = await ctx.api(`/notes/${n.id}/delete-preview`); } catch (err) { toast(err.message, { kind: 'bad' }); return false; }
    const out = await deleteDialog({
        title: `Delete ${pre.label} permanently?`,
        goes: ['This note and its text', plural(pre.counts.links, 'link'), plural(pre.counts.revisions, 'revision')],
        stays: ['The records and notes it linked to', 'Anything outside this hub'],
        run: (o) => ctx.api(`/notes/${n.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
    });
    if (out) toast('Note deleted');
    return Boolean(out);
}

function noteRow(ctx, n, { trash }) {
    const link = h('a', { class: 'row-link', href: href('notes', [String(n.id)]), 'data-key': `note:${n.id}` }, n.title);
    const tags = n.tags.length ? h('p', { class: 'note-row-tags' }, n.tags.map((t) => h('a', { class: 'chip tag-chip', href: href('notes', [], { tag: t }), 'data-key': `tag:${t}` }, h('span', { text: `#${t}` })))) : null;
    return h('li', { class: `note-row${n.pinned ? ' pinned' : ''}`, 'data-id': String(n.id), onclick: (event) => { if (!event.target.closest('a, button')) link.click(); } },
        h('div', { class: 'note-row-main' },
            h('p', { class: 'note-row-title' }, n.pinned ? h('span', { class: 'note-pin', title: 'Pinned', role: 'img', 'aria-label': 'Pinned' }, icon('pin')) : null, link, ' ', chip(n.kind, { hue: domainHue('notes') })),
            n.preview ? h('p', { class: 'note-row-preview muted', text: n.preview }) : null,
            tags),
        h('div', { class: 'row-actions note-row-side' },
            h('span', { class: 'muted note-row-by', title: when(n.updated_at), text: `${byLine(n)} · ${ago(n.updated_at)}` }),
            trash ? button({ text: 'Put back', variant: 'quiet', size: 'small', 'data-key': `untrash:${n.id}`, onClick: async () => {
                try { await ctx.api(`/notes/${n.id}/untrash`, { method: 'POST' }); toast('Note put back'); ctx.rerender(); } catch (e) { toast(e.message, { kind: 'bad' }); }
            } }) : null,
            trash ? button({ text: 'Delete permanently', variant: 'danger', size: 'small', 'data-key': `purge:${n.id}`, onClick: async () => { if (await purge(ctx, n)) ctx.rerender(); } }) : null));
}

export async function render(ctx) {
    const idRaw = ctx.route.parts[0];
    if (idRaw) return renderEditor(ctx, idRaw);

    const q = ctx.route.query;
    const kind = (q.get('kind') || '').trim();
    const tag = (q.get('tag') || '').trim();
    const text = (q.get('q') || '').trim();
    const pinned = q.get('pinned') === '1';
    const trash = q.get('removed') === '1';
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (tag) params.set('tag', tag);
    if (text) params.set('q', text);
    if (pinned) params.set('pinned', '1');
    if (trash) params.set('removed', '1');
    params.set('limit', '200');
    const [data, facets, missing] = await Promise.all([
        ctx.api(`/notes?${params}`),
        ctx.api('/notes/facets'),
        trash ? Promise.resolve({ missing: [] }) : ctx.api('/notes/missing?limit=12').catch(() => ({ missing: [] })),
    ]);

    // n starts a new note, unless a field or dialog has the keyboard.
    const onKey = (e) => {
        if (e.key !== 'n' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
        const el = document.activeElement;
        if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        navigate(href('notes', ['new'], { kind, tag }));
    };
    document.addEventListener('keydown', onKey);
    ctx.onCleanup(() => document.removeEventListener('keydown', onKey));

    const query = (patch) => ({ kind, tag, q: text, pinned: pinned ? '1' : '', removed: trash ? '1' : '', ...patch });
    const filtering = Boolean(kind || tag || text || pinned);
    const kindChips = chipNav({
        label: 'Filter by kind',
        current: kind || 'all',
        items: [{ id: 'all', label: `All (${facets.total})`, href: href('notes', [], query({ kind: '' })) },
            ...facets.kinds.map((k) => ({ id: k.kind, label: `${cap(k.kind)} (${k.count})`, href: href('notes', [], query({ kind: k.kind })) }))],
    });
    // pinned is a toggle on top of the kind, not a kind
    const pinnedChip = chipNav({ label: 'Pinned notes', current: pinned ? 'pinned' : '', items: [{ id: 'pinned', label: `Pinned (${facets.pinned})`, href: href('notes', [], query({ pinned: pinned ? '' : '1' })) }] });
    const tagChips = facets.tags.length ? chipNav({
        label: 'Filter by tag',
        current: tag || 'none',
        items: [...(tag && !facets.tags.some((t) => t.tag === tag) ? [{ tag, count: 0 }] : []), ...facets.tags].slice(0, 24)
            .map((t) => ({ id: t.tag, label: `#${t.tag}`, href: href('notes', [], query({ tag: tag === t.tag ? '' : t.tag })) })),
    }) : null;
    const search = h('input', { type: 'search', name: 'q', value: text, placeholder: 'Search notes', 'aria-label': 'Search notes by title, text or tag', 'data-key': 'n-search', enterkeyhint: 'search' });
    const searchForm = h('form', { class: 'search-form', role: 'search', onsubmit: (event) => { event.preventDefault(); navigate(href('notes', [], query({ q: search.value.trim() }))); } },
        icon('search', 'search-icon'), search,
        text ? h('a', { class: 'btn ghost small', href: href('notes', [], query({ q: '' })), text: 'Clear' }) : null);

    let body;
    if (!facets.total && !facets.removed && !trash) {
        body = emptyState({ title: 'No notes yet.', text: 'Write a page, link it to other notes, people and records with [[double brackets]], and find it again in search and the graph.', iconName: 'digests',
            action: h('a', { class: 'btn small', href: href('notes', ['new']), 'data-key': 'empty-new' }, icon('plus'), h('span', { text: 'New note' })) });
    } else if (!data.notes.length) {
        body = emptyState({ title: trash ? 'The trash is empty.' : 'No note matches.', text: trash ? 'Notes you delete wait here until you put them back or delete them for good.' : 'Try other words, or clear the filters.', iconName: 'search',
            action: filtering ? h('a', { class: 'btn quiet small', href: href('notes'), text: 'Show every note' }) : null });
    } else body = h('ul', { class: 'note-list' }, data.notes.map((n) => noteRow(ctx, n, { trash })));

    const missingBox = missing.missing && missing.missing.length ? h('section', { class: 'note-missing', 'aria-labelledby': 'note-missing-h' },
        h('h3', { id: 'note-missing-h', text: 'Missing pages' }),
        h('p', { class: 'muted', text: 'Titles your notes link to that no note or entity has yet.' }),
        h('ul', { class: 'note-missing-list' }, missing.missing.map((m) => h('li', {},
            h('a', { class: 'chip-link', href: href('notes', ['new'], { title: m.target }), 'data-key': `missing:${m.target}`, title: `Create a note called ${m.target}` }, icon('plus'), h('span', { text: m.target })),
            h('span', { class: 'muted', text: ` ${m.count === 1 ? 'in 1 note' : `in ${m.count} notes`}` }))))) : null;

    const add = h('a', { class: 'btn', href: href('notes', ['new'], { kind, tag }), 'data-key': 'new-note' }, icon('plus'), h('span', { text: 'New note' }));
    const trashLink = facets.removed || trash ? h('a', { class: 'btn ghost small', href: trash ? href('notes') : href('notes', [], { removed: '1' }), 'data-key': 'trash-toggle' },
        icon('trash'), h('span', { text: trash ? 'Back to notes' : `Trash (${facets.removed})` })) : null;
    return h('div', { class: 'view notes' },
        pageHeader({ lede: 'Pages in markdown. [[Double brackets]] link a note, a person or any record; links show up in Linked, search and the graph. Press n for a new note.', actions: add }),
        facets.total || facets.removed ? h('div', { class: 'toolbar filter-bar' }, h('div', { class: 'filters' }, trash ? null : kindChips, trash ? null : pinnedChip, trash ? null : tagChips), searchForm) : null,
        h('div', { class: 'note-panel' },
            h('div', { class: 'note-panel-head' },
                h('p', { class: 'note entity-total', 'aria-live': 'polite', text: trash ? `${plural(data.total, 'note')} in the trash` : filtering ? `${data.notes.length} of ${plural(facets.total, 'note')}` : plural(facets.total, 'note') }),
                trashLink),
            body),
        missingBox);
}
