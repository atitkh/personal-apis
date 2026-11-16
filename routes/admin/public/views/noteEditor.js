// The note editor: #/notes/12 (or #/notes/new). A roomy full page: title, kind, tags, pin, a toolbar, the markdown text on the
// left and a live preview on the right (a Write | Preview switch on a phone), and the note's Linked section underneath.
//   - Typing saves by itself about 1.5 s after you stop (a revision is kept only when the title or text changed and the last
//     revision is 5 minutes old); Ctrl+S or Save always keeps a revision. The state is shown beside the buttons and read out
//     politely. Leaving the page with unsaved text saves it first; if that fails you are asked.
//   - [[ and / open the menus in noteMenus.js; Ctrl+B, Ctrl+I, Ctrl+K (link) work in the text.
//   - Wikilinks in the preview are links to the note, entity or record, or "missing" ones that offer to create the page.
// Titles and text are the person's own and only ever go in as text (the preview is built by markdown.js, never innerHTML).
import { linkedSection } from './linked.js';
import { recordHref } from './recordHref.js';
import { createMenus } from './noteMenus.js';
import { render as renderMarkdown, wikilinkTargets, toggleTaskLine } from '../markdown.js';
import {
    h, icon, button, chip, ago, when, toast, confirmDialog, deleteDialog, formDialog, openDrawer, actorName, plural, errorState } from '../ui.js';
import { href, navigate, setGuard, clearGuard, settle } from '../router.js';

const KINDS = ['note', 'daily', 'inbox', 'meeting'];
const ENTITY_KINDS = [['person', 'Person'], ['project', 'Project'], ['organization', 'Organization'], ['topic', 'Topic'], ['other', 'Other']];
const DOMAIN_WORD = { notes: 'Note', entities: 'Entity', trips: 'Trip', places: 'Place', flights: 'Flight', deadlines: 'Deadline', digests: 'Digest', preferences: 'Preference', lifelog: 'Lifelog', portfolio: 'Portfolio' };
const AUTOSAVE_MS = 1500;
const keyOf = (t) => String(t).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const listHref = () => href('notes');

/* ---------- small pieces ---------- */

// Tags as chips with an input; returns { el, get, set }.
function tagsField({ tags, onChange, id }) {
    let list = [...tags];
    const input = h('input', { type: 'text', class: 'tag-input', id, autocomplete: 'off', placeholder: 'Add tag', 'aria-label': 'Add a tag', maxlength: '30', 'data-key': 'note-tag-input' });
    const wrap = h('div', { class: 'tag-field' });
    const draw = () => {
        wrap.replaceChildren(...list.map((t) => h('span', { class: 'chip tag-chip' }, h('span', { text: t }),
            h('button', { type: 'button', class: 'tag-x', 'aria-label': `Remove tag ${t}`, onclick: () => { list = list.filter((x) => x !== t); draw(); onChange(); input.focus(); } }, icon('close')))), input);
    };
    const add = () => {
        const parts = input.value.split(',').map((s) => s.normalize('NFKC').trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-')).filter(Boolean);
        input.value = '';
        let changed = false;
        for (const p of parts) if (!list.includes(p) && list.length < 20) { list.push(p); changed = true; }
        if (changed) { draw(); onChange(); input.focus(); }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
        else if (e.key === 'Backspace' && !input.value && list.length) { list.pop(); draw(); onChange(); input.focus(); }
    });
    input.addEventListener('blur', add);
    draw();
    return { el: wrap, get: () => [...list], set: (t) => { list = [...t]; draw(); } };
}

// ---- editing helpers on the textarea ----
function edit(ta, fn) {
    ta.focus();
    fn();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function wrap(ta, pre, post, placeholder) {
    edit(ta, () => {
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        const sel = ta.value.slice(s, e);
        if (sel && sel.startsWith(pre) && sel.endsWith(post) && sel.length >= pre.length + post.length) {
            ta.setRangeText(sel.slice(pre.length, sel.length - post.length), s, e, 'select');
            return;
        }
        const text = sel || placeholder;
        ta.setRangeText(`${pre}${text}${post}`, s, e, 'end');
        ta.setSelectionRange(s + pre.length, s + pre.length + text.length);
    });
}
// Adds a line prefix to every selected line, or takes it off when they all have it. `test.strip(line)` removes one.
function linePrefix(ta, prefixOf, test) {
    edit(ta, () => {
        const v = ta.value;
        const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
        let e = v.indexOf('\n', ta.selectionEnd);
        if (e < 0) e = v.length;
        const lines = v.slice(s, e).split('\n');
        const all = lines.every((l) => test(l));
        const out = lines.map((l, i) => (all ? test.strip(l) : `${prefixOf(i)}${test(l) ? test.strip(l) : l}`));
        ta.setRangeText(out.join('\n'), s, e, 'end');
    });
}
const lineTest = (re) => Object.assign((l) => re.test(l), { strip: (l) => l.replace(re, (m, indent) => indent || '') });
const bulletTest = lineTest(/^(\s*)[-*+] (?!\[[ xX]\] )/);
const orderedTest = lineTest(/^(\s*)\d+[.)] /);
const taskTest = lineTest(/^(\s*)[-*+] \[[ xX]\] /);
const quoteTest = lineTest(/^()> /);
const headTest = lineTest(/^()#{1,6} /);
function linkEdit(ta) {
    edit(ta, () => {
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        const sel = ta.value.slice(s, e);
        const isUrl = /^https?:\/\/\S+$/.test(sel);
        const label = isUrl ? 'text' : sel || 'text';
        const url = isUrl ? sel : 'https://';
        ta.setRangeText(`[${label}](${url})`, s, e, 'end');
        if (isUrl) ta.setSelectionRange(s + 1, s + 1 + label.length);
        else ta.setSelectionRange(s + label.length + 3, s + label.length + 3 + url.length);
    });
}

/* ---------- the page ---------- */

export async function renderEditor(ctx, idRaw) {
    const isNew = idRaw === 'new';
    let note = null;
    let facets = { kinds: [] };
    if (!isNew) {
        if (!/^\d+$/.test(idRaw)) return errorState({ err: Object.assign(new Error('There is no such note.'), { status: 404 }), what: 'This note', retry: () => navigate(listHref()) });
        [note, facets] = await Promise.all([ctx.api(`/notes/${idRaw}`), ctx.api('/notes/facets').catch(() => ({ kinds: [] }))]);
    } else facets = await ctx.api('/notes/facets').catch(() => ({ kinds: [] }));

    const st = { id: note ? note.id : null, rev: note ? note.rev : 0, removed: Boolean(note && note.removed), revisions: note ? note.revisions : 0 };
    const start = note
        ? { title: note.title, body: note.body, kind: note.kind, tags: note.tags, pinned: note.pinned }
        : { title: '', body: '', kind: ctx.route.query.get('kind') || 'note', tags: ctx.route.query.get('tag') ? [ctx.route.query.get('tag')] : [], pinned: false };
    if (isNew && ctx.route.query.get('title')) start.title = ctx.route.query.get('title').slice(0, 160);

    /* ---- elements ---- */
    const live = h('span', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'data-key': 'note-live' });
    const status = h('span', { class: 'note-status', 'data-state': 'saved', 'data-key': 'note-status' });
    const retry = button({ text: 'Retry', variant: 'quiet', size: 'small', 'data-key': 'note-retry', onClick: () => save(true) });
    retry.hidden = true;
    const titleEl = h('input', { type: 'text', class: 'note-title', id: 'note-title', maxlength: '160', placeholder: 'Untitled', autocomplete: 'off', 'aria-label': 'Title', 'data-key': 'note-title' });
    titleEl.value = start.title;
    const kindEl = h('input', { type: 'text', id: 'note-kind', list: 'note-kinds', maxlength: '20', autocomplete: 'off', class: 'note-kind-input', 'data-key': 'note-kind' });
    kindEl.value = start.kind;
    const kinds = [...new Set([...KINDS, ...(facets.kinds || []).map((k) => k.kind)])];
    const kindList = h('datalist', { id: 'note-kinds' }, kinds.map((k) => h('option', { value: k })));
    const tagsW = tagsField({ tags: start.tags, onChange: () => touch(), id: 'note-tags' });
    let pinned = Boolean(start.pinned);
    const pinLabel = h('span', { text: 'Pin' });
    const pinBtn = h('button', { type: 'button', class: 'btn quiet small', 'aria-pressed': 'false', 'data-key': 'note-pin', onclick: () => { pinned = !pinned; drawPin(); touch(); } }, icon('pin'), pinLabel);
    const drawPin = () => { pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false'); pinLabel.textContent = pinned ? 'Pinned' : 'Pin'; pinBtn.classList.toggle('on', pinned); };
    const ta = h('textarea', { class: 'note-text', id: 'note-text', spellcheck: 'true', 'aria-label': 'Note text (markdown)', 'data-key': 'note-text', placeholder: 'Write here. [[ links a note or record, / opens commands.' });
    ta.value = start.body;
    const previewEl = h('div', { class: 'note-preview', 'aria-label': 'Preview', 'data-key': 'note-preview' });
    const split = h('div', { class: 'note-split', 'data-pane': 'write' });
    const writeBox = h('div', { class: 'note-write' }, ta);
    split.append(writeBox, h('div', { class: 'note-preview-box' }, previewEl));
    const paneBtn = (id, text) => h('button', { type: 'button', class: 'note-pane-btn', 'aria-pressed': id === 'write' ? 'true' : 'false', 'data-key': `pane:${id}`, text,
        onclick: () => { split.setAttribute('data-pane', id); for (const b of paneBar.children) b.setAttribute('aria-pressed', b.dataset.key === `pane:${id}` ? 'true' : 'false'); if (id === 'write') ta.focus(); } });
    const paneBar = h('div', { class: 'note-panes', role: 'group', 'aria-label': 'Show' }, paneBtn('write', 'Write'), paneBtn('preview', 'Preview'));

    const tb = (name, label, iconText, fn) => h('button', { type: 'button', class: 'note-tool', 'aria-label': label, title: label, 'data-key': `tool:${name}`, onclick: fn, text: iconText });
    const toolbar = h('div', { class: 'note-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
        tb('bold', 'Bold (Ctrl+B)', 'B', () => wrap(ta, '**', '**', 'bold')),
        tb('italic', 'Italic (Ctrl+I)', 'I', () => wrap(ta, '*', '*', 'italic')),
        tb('heading', 'Heading', 'H', () => linePrefix(ta, () => '## ', headTest)),
        tb('bullets', 'Bulleted list', '•', () => linePrefix(ta, () => '- ', bulletTest)),
        tb('numbers', 'Numbered list', '1.', () => linePrefix(ta, (i) => `${i + 1}. `, orderedTest)),
        tb('task', 'Task list', '☐', () => linePrefix(ta, () => '- [ ] ', taskTest)),
        tb('link', 'Link (Ctrl+K)', '🔗', () => linkEdit(ta)),
        tb('code', 'Code', '</>', () => wrap(ta, '`', '`', 'code')),
        tb('quote', 'Quote', '❝', () => linePrefix(ta, () => '> ', quoteTest)),
        h('span', { class: 'note-tool-gap' }),
        paneBar);

    /* ---- status and saving ---- */
    let timer = null;
    let saving = null;     // the promise of the save in flight
    let lastText = '';
    const setStatus = (state, text) => {
        status.setAttribute('data-state', state);
        status.textContent = text;
        retry.hidden = state !== 'error';
        if (text !== lastText) { live.textContent = text; lastText = text; }
    };
    const current = () => ({ title: titleEl.value.trim().replace(/\s+/g, ' ') || 'Untitled', body: ta.value, kind: kindEl.value.trim().toLowerCase() || 'note', tags: tagsW.get(), pinned });
    let saved = { ...start, title: start.title.trim() || 'Untitled' };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const isDirty = () => !same(current(), saved);
    const touch = () => {
        if (st.removed) return;
        clearTimeout(timer);
        setStatus('dirty', 'Unsaved changes');
        timer = setTimeout(() => save(false), AUTOSAVE_MS);
    };

    // explicit: Save button / Ctrl+S (always keeps a revision). force: save even if nothing changed (bring links in line).
    function save(explicit, force = false) {
        if (st.removed) return Promise.resolve(true);
        clearTimeout(timer);
        if (saving) return saving.then(() => save(explicit, force));
        const now = current();
        if (!st.id && !now.body && !titleEl.value.trim() && !now.tags.length) return Promise.resolve(true);
        if (st.id && !force && !explicit && same(now, saved)) { setStatus('saved', 'Saved'); return Promise.resolve(true); }
        setStatus('saving', 'Saving…');
        saving = (async () => {
            try {
                let r;
                if (!st.id) {
                    r = await ctx.api('/notes', { method: 'POST', body: now });
                    st.id = r.id;
                    afterCreate();
                } else {
                    r = await ctx.api(`/notes/${st.id}`, { method: 'PATCH', body: { ...now, autosave: !explicit } });
                }
                saved = now;
                st.rev = r.rev;
                if (r.unresolved) markUnresolved(r.unresolved);
                if (r.links && (r.links.added || r.links.removed)) drawLinked();
                setStatus('saved', 'Saved');
                return true;
            } catch (err) {
                if (err.status === 401) return false;
                setStatus('error', 'Error, retry');
                toast(err.message, { kind: 'bad' });
                return false;
            } finally {
                saving = null;
            }
        })();
        return saving.then((ok) => { if (ok && isDirty() && !st.removed) touch(); return ok; });
    }

    function afterCreate() {
        history.replaceState(null, '', href('notes', [String(st.id)]));
        settle();
        drawChrome();
        drawLinked();
    }

    /* ---- wikilink resolution for the preview ---- */
    const known = new Map();      // keyOf(target) -> { missing } | { domain, id, title }
    const asking = new Set();
    let askTimer = null;
    const fill = (w) => {
        for (const r of w.resolved || []) known.set(keyOf(r.target), { domain: r.domain, id: r.id, title: r.title, kind: r.kind });
        for (const u of w.unresolved || []) known.set(keyOf(u), { missing: true });
    };
    const markUnresolved = (list) => { for (const u of list) known.set(keyOf(u), { missing: true }); drawPreview(); };
    if (note && note.wikilinks) fill(note.wikilinks);
    const hrefOf = (info) => (info.domain === 'notes' ? href('notes', [String(info.id)]) : recordHref(info.domain, info.id, { title: info.title }));
    function resolveNow() {
        const targets = [...asking];
        asking.clear();
        if (!targets.length) return;
        ctx.api('/notes/resolve', { method: 'POST', body: { id: st.id || 0, targets } }).then((w) => {
            const got = new Set();
            for (const r of w.resolved) got.add(keyOf(r.target));
            for (const u of w.unresolved) got.add(keyOf(u));
            fill(w);
            for (const t of targets) if (!got.has(keyOf(t))) known.set(keyOf(t), { missing: false, skip: true });   // a link to itself
            drawPreview();
        }).catch(() => { /* the preview keeps showing them as pending */ });
    }
    const wikilink = (node) => {
        const info = known.get(keyOf(node.target));
        if (!info) { asking.add(node.target); clearTimeout(askTimer); askTimer = setTimeout(resolveNow, 350); return null; }
        if (info.skip) return null;
        if (info.missing) return { missing: true };
        return { href: hrefOf(info), title: `${DOMAIN_WORD[info.domain] || info.domain}: ${info.title}` };
    };

    /* ---- the preview ---- */
    let previewTimer = null;
    function drawPreview() {
        const body = ta.value;
        if (!body.trim()) { previewEl.replaceChildren(h('p', { class: 'muted', text: 'Nothing to preview yet.' })); return; }
        const top = previewEl.parentElement ? previewEl.parentElement.scrollTop : 0;
        previewEl.replaceChildren(renderMarkdown(body, {
            wikilink,
            onMissing: (target) => createMissing(target),
            onToggleTask: st.removed ? null : (line) => {
                const next = toggleTaskLine(ta.value, line);
                if (next == null) return;
                ta.value = next;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
            },
        }));
        if (previewEl.parentElement) previewEl.parentElement.scrollTop = top;
    }
    const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(drawPreview, 120); };

    /* ---- creating the pages a link names ---- */
    async function makeNote(title) {
        const r = await ctx.api('/notes', { method: 'POST', body: { title, body: '' } });
        known.set(keyOf(title), { domain: 'notes', id: String(r.id), title });
        return r;
    }
    async function makeEntity(name, kind) {
        try { await ctx.api('/entities', { method: 'POST', body: { kind, name } }); } catch (e) { if (e.status !== 409) throw e; }
        const f = await ctx.api(`/entities?q=${encodeURIComponent(name)}&limit=20`).catch(() => ({ entities: [] }));
        const hit = f.entities.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (hit) known.set(keyOf(name), { domain: 'entities', id: String(hit.id), title: hit.name });
    }
    async function createMissing(target) {
        const kind = h('select', { name: 'kind', id: 'create-kind' }, h('option', { value: 'note', text: 'Note' }), ENTITY_KINDS.map(([k, t]) => h('option', { value: k, text: `Entity: ${t}` })));
        const ok = await formDialog({
            title: `Create “${target}”?`,
            intro: 'Nothing is called that yet. A note is a page of your own; an entity is a person, project, organization or topic your records can point at.',
            fields: [h('div', { class: 'field' }, h('label', { for: 'create-kind', text: 'Create as' }), kind)],
            submit: 'Create',
            onSubmit: async (form) => {
                const k = form.elements.kind.value;
                if (k === 'note') await makeNote(target); else await makeEntity(target, k);
                return true;
            },
        });
        if (ok) { toast(`Created ${target}`); drawPreview(); await save(false, true); drawLinked(); }
    }

    const menus = createMenus({
        textarea: ta, host: writeBox, api: ctx.api, selfId: () => st.id,
        createNote: async (title) => { await makeNote(title); toast(`Created note ${title}`); },
        createEntity: async (name, kind) => { await makeEntity(name, kind); toast(`Created ${kind} ${name}`); },
        newEntity: async () => {
            const name = h('input', { type: 'text', name: 'name', id: 'ne-name', maxlength: '120', autocomplete: 'off' });
            const kind = h('select', { name: 'kind', id: 'ne-kind' }, ENTITY_KINDS.map(([k, t]) => h('option', { value: k, text: t })));
            const out = await formDialog({
                title: 'New entity', intro: 'A person, project, organization or topic your records can point at. A [[link]] to it goes into the note.',
                fields: [h('div', { class: 'field' }, h('label', { for: 'ne-name', text: 'Name' }), name), h('div', { class: 'field' }, h('label', { for: 'ne-kind', text: 'Kind' }), kind)],
                submit: 'Add entity',
                onSubmit: async (form) => {
                    const n = form.elements.name.value.trim().replace(/\s+/g, ' ');
                    if (!n) throw Object.assign(new Error('Give it a name.'), { field: 'name' });
                    await makeEntity(n, form.elements.kind.value);
                    return n;
                },
            });
            return typeof out === 'string' ? out : null;
        },
    });

    /* ---- header, chrome, linked, revisions ---- */
    const back = h('a', { class: 'btn ghost small note-back', href: listHref(), 'data-key': 'note-back' }, icon('prev'), h('span', { text: 'Notes' }));
    const saveBtn = button({ text: 'Save', size: 'small', 'data-key': 'note-save', onClick: () => save(true) });
    const revBtn = button({ text: 'Revisions', variant: 'quiet', size: 'small', iconName: 'history', 'data-key': 'note-revisions', onClick: () => openRevisions() });
    const delBtn = button({ text: 'Delete', variant: 'quiet', size: 'small', iconName: 'trash', 'data-key': 'note-delete', onClick: () => trashIt() });
    const banner = h('div', { class: 'note-banner', role: 'status', hidden: true });
    const linkedHost = h('div', { class: 'note-linked' });
    const metaLine = h('p', { class: 'note-meta muted', 'data-key': 'note-meta' });

    function drawChrome() {
        revBtn.hidden = !st.id;
        delBtn.hidden = !st.id || st.removed;
        saveBtn.hidden = st.removed;
        pinBtn.hidden = st.removed;
        for (const el of [titleEl, kindEl, ta]) el.readOnly = st.removed;
        tagsW.el.classList.toggle('readonly', st.removed);
        banner.hidden = !st.removed;
        if (st.removed) {
            banner.replaceChildren(h('span', { text: 'This note is in the trash. It is hidden from lists and links.' }),
                button({ text: 'Put back', size: 'small', 'data-key': 'note-untrash', onClick: untrash }),
                button({ text: 'Delete permanently', variant: 'danger', size: 'small', 'data-key': 'note-purge', onClick: purge }));
        }
        drawPin();
        const by = note ? (note.updated_by === 'admin' ? 'you' : `agent ${note.updated_by}`) : '';
        metaLine.textContent = note && st.id ? `Last changed by ${by} ${ago(note.updated_at)} · ${plural(st.revisions || st.rev || 1, 'revision')}` : '';
    }
    function drawLinked() {
        if (!st.id) { linkedHost.replaceChildren(); return; }
        linkedHost.replaceChildren(linkedSection(ctx, 'notes', String(st.id)));
    }

    async function trashIt() {
        if (!(await save(true))) return;
        const yes = await confirmDialog({ title: 'Move this note to the trash?', body: 'It leaves lists, links and search. You can put it back, or delete it for good from the trash.', confirm: 'Move to trash', danger: true });
        if (!yes) return;
        try { await ctx.api(`/notes/${st.id}/trash`, { method: 'POST' }); toast('Moved to trash'); saved = current(); navigate(listHref()); } catch (e) { toast(e.message, { kind: 'bad' }); }
    }
    async function untrash() {
        try { await ctx.api(`/notes/${st.id}/untrash`, { method: 'POST' }); toast('Note put back'); saved = current(); ctx.rerender(); } catch (e) { toast(e.message, { kind: 'bad' }); }
    }
    async function purge() {
        let pre;
        try { pre = await ctx.api(`/notes/${st.id}/delete-preview`); } catch (e) { toast(e.message, { kind: 'bad' }); return; }
        const out = await deleteDialog({
            title: `Delete ${pre.label} permanently?`,
            goes: ['This note and its text', plural(pre.counts.links, 'link'), plural(pre.counts.revisions, 'revision')],
            stays: ['The records and notes it linked to', 'Anything outside this hub'],
            run: (o) => ctx.api(`/notes/${st.id}`, { method: 'DELETE', body: { confirm: true, backup: o.backup } }),
        });
        if (out) { toast('Note deleted'); saved = current(); navigate(listHref()); }
    }

    async function openRevisions() {
        if (!(await save(true))) return;
        let hist;
        try { hist = (await ctx.api(`/notes/${st.id}/history`)).revisions; } catch (e) { toast(e.message, { kind: 'bad' }); return; }
        const viewer = h('div', { class: 'note-rev-view', 'aria-live': 'polite' }, h('p', { class: 'muted', text: 'Pick a revision to see how the note read then.' }));
        const rows = h('ul', { class: 'note-rev-list' });
        const drawer = openDrawer({ title: 'Revisions', subtitle: 'Every earlier version is kept. Restoring one makes a new revision.', wide: true, content: [rows, viewer], returnFocus: () => revBtn });
        const show = async (rev) => {
            viewer.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
            try {
                const r = await ctx.api(`/notes/${st.id}?rev=${rev.rev}`);
                const known2 = new Map();
                viewer.replaceChildren(
                    h('div', { class: 'note-rev-head' }, h('strong', { text: `Revision ${rev.rev}: ${r.title}` }),
                        rev.current ? h('span', { class: 'chip', text: 'Current' }) : button({ text: 'Restore this revision', size: 'small', 'data-key': `restore:${rev.rev}`, onClick: () => restoreRev(rev, drawer) })),
                    h('div', { class: 'note-preview' }, renderMarkdown(r.body, { wikilink: (n) => known2.get(keyOf(n.target)) || null })));
            } catch (e) { viewer.replaceChildren(h('p', { class: 'error', text: e.message })); }
        };
        rows.replaceChildren(...hist.map((r) => h('li', { class: 'note-rev-item' },
            h('button', { type: 'button', class: 'note-rev-btn', 'data-key': `rev:${r.rev}`, onclick: () => show(r) },
                h('span', { class: 'note-rev-n', text: `#${r.rev}` }),
                h('span', { class: 'note-rev-main' }, h('span', { text: r.title }), h('span', { class: 'muted', text: ` ${plural(r.chars, 'char')}` })),
                h('span', { class: 'muted', text: `${actorName(r.actor)} · ${r.source} · ${ago(r.at)}`, title: when(r.at) })))));
        if (hist[0]) show(hist[0]);
    }
    async function restoreRev(rev, drawer) {
        const yes = await confirmDialog({ title: `Restore revision ${rev.rev}?`, body: 'The note goes back to how it was then. What it says now is kept as a revision.', confirm: 'Restore' });
        if (!yes) return;
        try {
            await ctx.api(`/notes/${st.id}/restore`, { method: 'POST', body: { rev: rev.rev } });
            toast(`Restored revision ${rev.rev}`);
            saved = current();
            drawer.close(true);
            ctx.rerender();
        } catch (e) { toast(e.message, { kind: 'bad' }); }
    }

    /* ---- events ---- */
    const typed = () => { touch(); schedulePreview(); };
    ta.addEventListener('input', () => { typed(); menus.onInput(); });
    titleEl.addEventListener('input', touch);
    kindEl.addEventListener('input', touch);
    kindEl.addEventListener('blur', () => { kindEl.value = kindEl.value.trim().toLowerCase() || 'note'; });
    ta.addEventListener('keydown', (e) => {
        if (menus.onKeydown(e)) return;
        const mod = e.ctrlKey || e.metaKey;
        if (!mod || e.altKey || e.shiftKey) return;
        const k = e.key.toLowerCase();
        if (k === 'b') { e.preventDefault(); wrap(ta, '**', '**', 'bold'); }
        else if (k === 'i') { e.preventDefault(); wrap(ta, '*', '*', 'italic'); }
        else if (k === 'k') { e.preventDefault(); e.stopPropagation(); linkEdit(ta); }
    });
    const root = h('div', { class: 'view notes note-editor', 'data-key': 'note-editor' },
        h('div', { class: 'note-bar' }, back, h('div', { class: 'note-bar-actions' }, status, retry, pinBtn, revBtn, delBtn, saveBtn, live)),
        banner,
        titleEl,
        h('div', { class: 'note-fields' },
            h('div', { class: 'note-field' }, h('label', { for: 'note-kind', text: 'Kind' }), kindEl, kindList),
            h('div', { class: 'note-field grow' }, h('label', { for: 'note-tags', text: 'Tags' }), tagsW.el)),
        toolbar,
        split,
        metaLine,
        linkedHost);
    root.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(true); }
    });

    drawChrome();
    drawLinked();
    setStatus('saved', st.id ? 'Saved' : 'New note');
    drawPreview();

    /* ---- leaving the page ---- */
    const beforeUnload = (e) => { if (isDirty() || saving) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    const guard = async () => {
        if (st.removed) return true;
        if (!isDirty() && !saving) return true;
        if (await save(false)) return true;
        return confirmDialog({ title: 'Leave without saving?', body: 'The latest changes could not be saved.', confirm: 'Leave', cancel: 'Stay', danger: true });
    };
    setGuard(guard);
    ctx.onCleanup(() => {
        clearGuard(guard);
        window.removeEventListener('beforeunload', beforeUnload);
        clearTimeout(timer); clearTimeout(previewTimer); clearTimeout(askTimer);
        menus.destroy();
    });

    if (isNew) setTimeout(() => (titleEl.value ? ta : titleEl).focus(), 0);
    return root;
}
