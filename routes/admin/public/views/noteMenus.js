// The two pop-up menus of the notes editor, both opened from the textarea:
//   [[   lists notes, entities and other records that match what is typed after it; Enter or Tab inserts [[Title]]
//        (or [[domain:id|Title]] for records that are not notes or entities, or when a title is not unique); nothing
//        matching offers "Create note" and "Create entity". [[trips: (or places:, flights:, deadlines:) lists that domain.
//   /    at the start of a line lists commands (links to a trip, place, flight or deadline, a new entity, today's date,
//        a task list, headings, a code block, a quote, a divider); typing narrows them.
// Both are a listbox of options (aria-activedescendant on the textarea), driven by the keyboard (up, down, Enter, Tab, Esc)
// and the mouse. Focus never leaves the textarea.
import { h } from '../ui.js';

const ENTITY_KINDS = ['person', 'project', 'organization', 'topic', 'other'];
const PICK = {
    trips: { path: '/trips?limit=200', rows: (r) => r.trips, title: (x) => x.title, hint: (x) => x.start_date || x.kind },
    places: { path: '/places', rows: (r) => r.places, title: (x) => x.label, hint: (x) => x.kind },
    flights: { path: '/flights?limit=200', rows: (r) => r.flights, title: (x) => `${x.airline_iata || ''} ${x.flight_number || ''} ${x.origin_iata || ''} to ${x.dest_iata || ''}`.replace(/\s+/g, ' ').trim(), hint: (x) => x.dep_local_date },
    deadlines: { path: '/deadlines?status=active&limit=200', rows: (r) => r.deadlines, title: (x) => x.title, hint: (x) => x.due_date },
};
const DOMAIN_WORD = { notes: 'Note', entities: 'Entity', trips: 'Trip', places: 'Place', flights: 'Flight', deadlines: 'Deadline', digests: 'Digest', preferences: 'Preference', lifelog: 'Lifelog', portfolio: 'Portfolio' };
const ORDER = ['notes', 'entities'];

const MIRROR = ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize'];

// Where a character of the textarea sits (pixels from the textarea's top left, before scrolling).
export function caretXY(ta, index) {
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    div.setAttribute('aria-hidden', 'true');
    Object.assign(div.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflow: 'hidden', height: 'auto' });
    for (const p of MIRROR) div.style[p] = cs[p];
    div.textContent = ta.value.slice(0, index);
    const mark = document.createElement('span');
    mark.textContent = ta.value.slice(index, index + 1) || '.';
    div.append(mark);
    document.body.append(div);
    const out = { left: mark.offsetLeft, top: mark.offsetTop, height: parseFloat(cs.lineHeight) || mark.offsetHeight || 20 };
    div.remove();
    return out;
}

const cleanTitle = (t) => String(t || '').replace(/[|\[\]\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const todayLocal = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Slash commands: { id, label, words, run(ctx) } where run edits through ctx.replace(text, caretOffset).
const COMMANDS = [
    { id: 'link-trip', label: 'Link to trip', words: 'trip journey travel link', open: 'trips:' },
    { id: 'link-place', label: 'Link to place', words: 'place location link', open: 'places:' },
    { id: 'link-flight', label: 'Link to flight', words: 'flight plane link', open: 'flights:' },
    { id: 'link-deadline', label: 'Link to deadline', words: 'deadline due renewal link', open: 'deadlines:' },
    { id: 'new-entity', label: 'New entity', words: 'entity person project organization topic new', entity: true },
    { id: 'today', label: "Today's date", words: 'today date', text: () => todayLocal() },
    { id: 'task', label: 'Task list', words: 'task todo checkbox list', text: () => '- [ ] ' },
    { id: 'h1', label: 'Heading 1', words: 'heading title h1', text: () => '# ' },
    { id: 'h2', label: 'Heading 2', words: 'heading h2', text: () => '## ' },
    { id: 'h3', label: 'Heading 3', words: 'heading h3', text: () => '### ' },
    { id: 'code', label: 'Code block', words: 'code fence', text: () => '```\n\n```', caret: 4 },
    { id: 'quote', label: 'Quote', words: 'quote blockquote', text: () => '> ' },
    { id: 'divider', label: 'Divider', words: 'divider rule line hr', text: () => '---\n' },
];

let seq = 0;

// ctx: { textarea, host, api, selfId() -> id|null, createNote(title) -> Promise, createEntity(name, kind) -> Promise,
//        newEntity() -> Promise<name|null>, inserted(info) }
export function createMenus(ctx) {
    const ta = ctx.textarea;
    const pid = `note-pop-${++seq}`;
    const list = h('ul', { class: 'note-popup', id: pid, role: 'listbox', 'aria-label': 'Suggestions', hidden: true });
    ctx.host.append(list);
    let st = null;          // { type: 'link' | 'slash', start, query, items, active }
    let token = 0;
    let timer = null;
    const cache = new Map();

    const setExpanded = (open) => {
        ta.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) ta.setAttribute('aria-controls', pid); else { ta.removeAttribute('aria-controls'); ta.removeAttribute('aria-activedescendant'); }
    };

    function close() {
        clearTimeout(timer);
        token += 1;
        st = null;
        list.hidden = true;
        list.replaceChildren();
        setExpanded(false);
    }

    function place(start) {
        const c = caretXY(ta, start);
        const width = Math.min(360, ctx.host.clientWidth - 16);
        list.style.width = `${width}px`;
        const left = Math.max(8, Math.min(ta.offsetLeft + c.left - ta.scrollLeft, ctx.host.clientWidth - width - 8));
        const top = ta.offsetTop + c.top - ta.scrollTop + c.height + 4;
        list.style.left = `${left}px`;
        list.style.top = `${top}px`;
    }

    function draw() {
        if (!st) return;
        list.replaceChildren(...st.items.map((it, i) => {
            const li = h('li', { class: `note-popup-item${i === st.active ? ' active' : ''}`, id: `${pid}-${i}`, role: 'option', 'aria-selected': i === st.active ? 'true' : 'false', 'data-kind': it.kind },
                h('span', { class: 'note-popup-main', text: it.label }),
                it.kind === 'create-entity' ? h('button', { type: 'button', class: 'note-popup-kind', tabindex: '-1', 'aria-label': `Entity kind: ${it.entityKind}. Left and right arrows change it.`, text: it.entityKind,
                    onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); cycle(it, 1); } }) : null,
                it.hint ? h('span', { class: 'note-popup-hint', text: it.hint }) : null);
            li.addEventListener('mousedown', (e) => { e.preventDefault(); accept(it); });
            li.addEventListener('mousemove', () => { if (st && st.active !== i) { st.active = i; mark(); } });
            return li;
        }));
        list.hidden = st.items.length === 0;
        setExpanded(!list.hidden);
        mark();
    }

    function mark() {
        if (!st) return;
        [...list.children].forEach((li, i) => {
            li.classList.toggle('active', i === st.active);
            li.setAttribute('aria-selected', i === st.active ? 'true' : 'false');
        });
        const cur = list.children[st.active];
        if (cur) { ta.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
    }

    function cycle(it, dir) {
        it.entityKind = ENTITY_KINDS[(ENTITY_KINDS.indexOf(it.entityKind) + dir + ENTITY_KINDS.length) % ENTITY_KINDS.length];
        draw();
    }

    // Replaces [from, to) with text and puts the caret `caret` characters into it (default: after it).
    function replace(from, to, text, caret) {
        ta.focus();
        ta.setRangeText(text, from, to, 'end');
        const at = caret == null ? from + text.length : from + caret;
        ta.setSelectionRange(at, at);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /* ---------- [[ ---------- */

    async function candidates(query) {
        const self = ctx.selfId();
        const dm = /^([a-z]+):(.*)$/i.exec(query);
        if (dm && PICK[dm[1].toLowerCase()]) {
            const d = dm[1].toLowerCase();
            if (!cache.has(d)) {
                try { cache.set(d, PICK[d].rows(await ctx.api(PICK[d].path)) || []); } catch (e) { cache.set(d, []); }
            }
            const q = dm[2].trim().toLowerCase();
            return cache.get(d).map((x) => ({ domain: d, id: String(x.id), title: PICK[d].title(x), hint: PICK[d].hint(x) || '' }))
                .filter((x) => x.title && (!q || x.title.toLowerCase().includes(q))).slice(0, 8);
        }
        const q = query.trim();
        if (!q) {
            const r = await ctx.api('/notes?limit=8');
            return r.notes.filter((n) => String(n.id) !== String(self)).slice(0, 6).map((n) => ({ domain: 'notes', id: String(n.id), title: n.title, hint: n.kind }));
        }
        if (!/[\p{L}\p{N}]/u.test(q)) return [];
        const r = await ctx.api(`/search?q=${encodeURIComponent(q.slice(0, 100))}&per_domain=5&mode=keyword`);
        const low = q.toLowerCase();
        const rows = r.groups.flatMap((g) => g.results.map((x) => ({ domain: g.domain, id: String(x.id), title: x.title, hint: x.kind || x.date || '' })))
            .filter((x) => !(x.domain === 'notes' && String(x.id) === String(self)));
        const rank = (x) => (x.title.toLowerCase() === low ? 0 : x.title.toLowerCase().startsWith(low) ? 1 : x.title.toLowerCase().includes(low) ? 2 : 3);
        const dom = (x) => { const k = ORDER.indexOf(x.domain); return k < 0 ? ORDER.length : k; };
        return rows.sort((a, b) => rank(a) - rank(b) || dom(a) - dom(b)).slice(0, 8);
    }

    function itemsFor(query, found) {
        const items = found.map((x) => {
            const dupTitle = found.filter((y) => y.title.toLowerCase() === x.title.toLowerCase() && (y.domain === 'notes' || y.domain === 'entities')).length > 1;
            const plain = (x.domain === 'notes' || x.domain === 'entities') && !dupTitle && !/[|\[\]]/.test(x.title);
            return { kind: 'record', label: x.title, hint: `${DOMAIN_WORD[x.domain] || x.domain}${x.hint ? ` · ${x.hint}` : ''}`, insert: plain ? `[[${x.title}]]` : `[[${x.domain}:${x.id}|${cleanTitle(x.title) || x.id}]]` };
        });
        const typed = cleanTitle(query);
        if (typed && !/^[a-z]+:/i.test(query) && !found.some((x) => x.title.toLowerCase() === typed.toLowerCase() && (x.domain === 'notes' || x.domain === 'entities'))) {
            items.push({ kind: 'create-note', label: `Create note “${typed}”`, title: typed });
            items.push({ kind: 'create-entity', label: `Create entity “${typed}”`, title: typed, entityKind: 'person' });
        }
        return items;
    }

    function openLink(start, query) {
        const mine = ++token;
        if (!st || st.type !== 'link' || st.start !== start) { st = { type: 'link', start, query, items: [], active: 0 }; place(start); }
        st.query = query;
        clearTimeout(timer);
        timer = setTimeout(async () => {
            let found = [];
            try { found = await candidates(query); } catch (e) { found = []; }
            if (mine !== token || !st || st.type !== 'link') return;
            st.items = itemsFor(query, found);
            st.active = Math.min(st.active, Math.max(st.items.length - 1, 0));
            draw();
        }, 120);
    }

    /* ---------- / ---------- */

    function openSlash(lineStart, query) {
        const q = query.trim().toLowerCase();
        const items = COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.words.includes(q)).map((c) => ({ kind: 'command', label: c.label, cmd: c }));
        if (!items.length) { close(); return; }
        if (!st || st.type !== 'slash' || st.start !== lineStart) { st = { type: 'slash', start: lineStart, query, items, active: 0 }; place(lineStart); } else { st.query = query; st.items = items; st.active = 0; }
        token += 1;
        draw();
    }

    /* ---------- accepting ---------- */

    async function accept(it) {
        if (!st) return;
        const { type, start } = st;
        const pos = ta.selectionStart;
        close();
        if (type === 'slash') {
            const c = it.cmd;
            if (c.open) { replace(start, pos, `[[${c.open}`); return; }
            if (c.entity) {
                replace(start, pos, '');
                const name = await ctx.newEntity();
                ta.focus();
                if (name) replace(ta.selectionStart, ta.selectionStart, `[[${name}]]`);
                return;
            }
            replace(start, pos, c.text(), c.caret);
            return;
        }
        let text = it.insert;
        try {
            if (it.kind === 'create-note') { await ctx.createNote(it.title); text = `[[${it.title}]]`; }
            if (it.kind === 'create-entity') { await ctx.createEntity(it.title, it.entityKind); text = `[[${it.title}]]`; }
        } catch (e) { ta.focus(); return; }
        const after = ta.value.slice(pos, pos + 2) === ']]' ? 2 : 0;
        replace(start, pos + after, text);
        if (ctx.inserted) ctx.inserted(text);
    }

    /* ---------- the textarea's events ---------- */

    function onInput() {
        if (ta.selectionStart !== ta.selectionEnd) { close(); return; }
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        const lineStart = before.lastIndexOf('\n') + 1;
        const line = before.slice(lineStart);
        const sl = /^\/([A-Za-z0-9 ]{0,20})$/.exec(line);
        if (sl) { openSlash(lineStart, sl[1]); return; }
        const m = /\[\[([^\[\]\n|]{0,100})$/.exec(before);
        if (m) { openLink(m.index, m[1]); return; }
        if (st) close();
    }

    // true when the key was used by the menu
    function onKeydown(e) {
        if (!st || list.hidden || e.isComposing) return false;
        const n = st.items.length;
        if (e.key === 'ArrowDown') { st.active = (st.active + 1) % n; mark(); }
        else if (e.key === 'ArrowUp') { st.active = (st.active - 1 + n) % n; mark(); }
        else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && st.items[st.active] && st.items[st.active].kind === 'create-entity') cycle(st.items[st.active], e.key === 'ArrowRight' ? 1 : -1);
        else if (e.key === 'Enter' || e.key === 'Tab') { if (!st.items[st.active]) return false; accept(st.items[st.active]); }
        else if (e.key === 'Escape') { close(); e.stopPropagation(); }
        else return false;
        e.preventDefault();
        return true;
    }

    ta.setAttribute('role', 'combobox');
    ta.setAttribute('aria-autocomplete', 'list');
    ta.setAttribute('aria-haspopup', 'listbox');
    setExpanded(false);
    ta.addEventListener('blur', () => setTimeout(() => { if (st && document.activeElement !== ta) close(); }, 120));

    return { onInput, onKeydown, close, isOpen: () => Boolean(st && !list.hidden), destroy: () => { close(); list.remove(); } };
}
