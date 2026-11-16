// A small, safe markdown renderer for notes. Two halves:
//   parse(src)                 pure and DOM-free: text -> a tree of plain objects (this is what the tests exercise)
//   render(src, opts)          builds DOM nodes from that tree with createElement/textContent only. Never innerHTML, so raw
//                              HTML in the text is shown as text; there is no way for markup in a note to become an element.
// Supported: headings, paragraphs (a single newline is a line break), **bold**, *italic*, ~~strike~~, `code`, fenced code,
// > quotes, bullet / numbered / task lists, links, horizontal rules, simple tables, and [[wikilinks]]. Links open only when
// the address is http, https, mailto or a hub route (#/...); anything else stays as the text you typed. Images are shown as
// links (nothing is loaded from the web: privacy and the page's content security policy).
// Limits keep a hostile or huge note from hanging the page: input, lines, nesting depth and inline depth are all capped.

export const LIMITS = { chars: 200000, lines: 20000, depth: 8, inlineDepth: 6, wikilinkChars: 400 };

const PUNCT = '\\`*_{}[]()#+-.!~|<>[]"\'/:';

/* ---------- links ---------- */

// -> { href, external } for an address a note may link to, else null.
export function safeHref(raw) {
    const url = String(raw == null ? '' : raw).trim();
    if (!url || url.length > 2000 || /[\u0000-\u0020\u007f-\u009f"<>\\^`{|}]/.test(url)) return null;
    if (/^https?:\/\/[^/?#\s]+/i.test(url)) return { href: url, external: true };
    if (/^mailto:[^\s@/?#]+@[^\s@/?#]+$/i.test(url)) return { href: url, external: true };
    if (/^#\/[A-Za-z0-9._~\/%?=&:+,@!*'()-]*$/.test(url)) return { href: url, external: false };
    return null;
}

/* ---------- inline ---------- */

// text -> [{ t: 'text', v } | { t: 'code', v } | { t: 'strong' | 'em' | 'del', c: [...] } | { t: 'link', href, external, c: [...] }
//          | { t: 'wikilink', target, label } | { t: 'br' }]
export function parseInline(text, depth = 0) {
    const out = [];
    const src = String(text);
    const n = src.length;
    const failed = {};          // marker -> position from which no closing marker exists (so a failed search is never repeated)
    let buf = '';
    let i = 0;
    const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
    const isWord = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
    const isSpace = (ch) => !ch || /\s/.test(ch);

    // The closing marker for an emphasis run that opens at i (marker m): returns its index or -1.
    const close = (m, from) => {
        if (failed[m] != null && from >= failed[m]) return -1;
        let j = from;
        for (;;) {
            j = src.indexOf(m, j);
            if (j < 0) { failed[m] = from; return -1; }
            const before = src[j - 1];
            const after = src[j + m.length];
            const sameRun = after === m[0] && m.length === 1;       // keep ** from closing a single *
            if (j > from && !isSpace(before) && !sameRun && (m[0] !== '_' || !isWord(after))) return j;
            j += 1;
        }
    };

    while (i < n) {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n && PUNCT.includes(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
        if (ch === '\n') { flush(); out.push({ t: 'br' }); i += 1; continue; }
        if (ch === '`') {
            let run = 1;
            while (src[i + run] === '`') run += 1;
            const tick = '`'.repeat(run);
            let j = i + run;
            let found = -1;
            while (!(failed[tick] != null && i >= failed[tick]) && (j = src.indexOf(tick, j)) >= 0) {
                if (src[j + run] !== '`' && src[j - 1] !== '`') { found = j; break; }
                j += 1;
                while (src[j] === '`') j += 1;
            }
            if (found < 0 && failed[tick] == null) failed[tick] = i;
            if (found > 0) {
                let v = src.slice(i + run, found).replace(/\n/g, ' ');
                if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ')) v = v.slice(1, -1);
                flush(); out.push({ t: 'code', v }); i = found + run; continue;
            }
            buf += tick; i += run; continue;
        }
        if (ch === '[' && src[i + 1] === '[') {
            const rel = src.slice(i + 2, i + 2 + LIMITS.wikilinkChars).indexOf(']]');
            const end = rel < 0 ? -1 : i + 2 + rel;
            if (end > i + 2) {
                const inner = src.slice(i + 2, end);
                if (!/[\[\]\n]/.test(inner)) {
                    const bar = inner.indexOf('|');
                    const target = (bar < 0 ? inner : inner.slice(0, bar)).replace(/\s+/g, ' ').trim();
                    const label = bar < 0 ? '' : inner.slice(bar + 1).replace(/\s+/g, ' ').trim();
                    if (target) { flush(); out.push({ t: 'wikilink', target, label: label || null }); i = end + 2; continue; }
                }
            }
        }
        if ((ch === '[' || (ch === '!' && src[i + 1] === '[')) && depth < LIMITS.inlineDepth) {
            const image = ch === '!';
            const start = i + (image ? 1 : 0);
            // the matching ] (brackets may nest a little)
            let k = start + 1;
            let level = 1;
            while (k < n && level > 0 && k - start < 300) {
                if (src[k] === '\\') k += 1;
                else if (src[k] === '[') level += 1;
                else if (src[k] === ']') level -= 1;
                k += 1;
            }
            if (level === 0 && src[k] === '(') {
                let p = k + 1;
                let parens = 1;
                while (p < n && parens > 0 && p - k < 2000) {
                    if (src[p] === '\\') p += 1;
                    else if (src[p] === '(') parens += 1;
                    else if (src[p] === ')') parens -= 1;
                    p += 1;
                }
                if (parens === 0) {
                    const label = src.slice(start + 1, k - 1);
                    const dest = src.slice(k + 1, p - 1).trim().replace(/\s+"[^"]*"$/, '').replace(/^<(.*)>$/, '$1');
                    const ok = safeHref(dest);
                    if (ok) {
                        flush();
                        const c = image ? [{ t: 'text', v: label.trim() || dest }] : parseInline(label, depth + 1).filter((x) => x.t !== 'link');
                        out.push({ t: 'link', href: ok.href, external: ok.external, image, c });
                    } else {
                        buf += src.slice(i, p);                   // an address a note may not link to stays as typed
                    }
                    i = p;
                    continue;
                }
            }
        }
        if (ch === '<') {
            const m = /^<((?:https?:\/\/|mailto:)[^\s<>]{1,1000})>/i.exec(src.slice(i, i + 1010));
            if (m) {
                const ok = safeHref(m[1]);
                if (ok) { flush(); out.push({ t: 'link', href: ok.href, external: ok.external, c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
            }
        }
        if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(src.slice(i, i + 8)) && !isWord(src[i - 1])) {
            let j = i;
            while (j < n && !/[\s<>]/.test(src[j]) && j - i < 1000) j += 1;
            let url = src.slice(i, j);
            while (/[.,;:!?)'"\]*_~]$/.test(url)) url = url.slice(0, -1);
            const ok = safeHref(url);
            if (ok) { flush(); out.push({ t: 'link', href: ok.href, external: true, c: [{ t: 'text', v: url }] }); i += url.length; continue; }
        }
        if ((ch === '*' || ch === '_' || ch === '~') && depth < LIMITS.inlineDepth) {
            const two = src[i + 1] === ch;
            const m = ch === '~' ? (two ? '~~' : '') : two ? ch + ch : ch;
            const after = src[i + m.length];
            const openOk = m && !isSpace(after) && (ch !== '_' || !isWord(src[i - 1]));
            if (openOk) {
                const j = close(m, i + m.length);
                if (j > 0) {
                    flush();
                    out.push({ t: m.length === 2 ? (ch === '~' ? 'del' : 'strong') : 'em', c: parseInline(src.slice(i + m.length, j), depth + 1) });
                    i = j + m.length;
                    continue;
                }
            }
        }
        buf += ch;
        i += 1;
    }
    flush();
    return out;
}

/* ---------- blocks ---------- */

// Block openers are scanned by hand where a regular expression could backtrack badly on a long line of spaces.
function fenceOf(s) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(s);
    if (!m) return null;
    const info = s.slice(m[0].length).trim();
    if (m[1][0] === '`' && info.includes('`')) return null;
    const sp = info.search(/\s/);
    return [s, m[1], (sp < 0 ? info : info.slice(0, sp))];
}
function headingOf(s) {
    let i = 0;
    while (i < 3 && s[i] === ' ') i += 1;
    let level = 0;
    while (s[i + level] === '#') level += 1;
    if (level < 1 || level > 6 || (s[i + level] !== ' ' && s[i + level] !== '\t')) return null;
    let text = s.slice(i + level).trim();
    let e = text.length;
    while (e > 0 && text[e - 1] === '#') e -= 1;
    if (e < text.length && (e === 0 || text[e - 1] === ' ' || text[e - 1] === '\t')) text = text.slice(0, e).trim();
    return [s, '#'.repeat(level), text];
}
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const isTableSep = (line) => { const t = line.trim(); return t.includes('-') && /^[|:\- ]+$/.test(t); };

const splitRow = (line) => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};

// lines: [{ s, n }] (text and its line number in the original note). -> blocks
function blocks(lines, depth) {
    const out = [];
    let i = 0;
    const starts = (line) => !!fenceOf(line) || !!headingOf(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line);
    while (i < lines.length) {
        const { s, n } = lines[i];
        if (!s.trim()) { i += 1; continue; }
        let m = fenceOf(s);
        if (m) {
            const mark = m[1];
            const body = [];
            i += 1;
            while (i < lines.length) {
                const t = lines[i].s;
                const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(t);
                if (c && c[1][0] === mark[0] && c[1].length >= mark.length) { i += 1; break; }
                body.push(t);
                i += 1;
            }
            out.push({ t: 'code', lang: (m[2] || '').slice(0, 30), text: body.join('\n'), line: n });
            continue;
        }
        if ((m = headingOf(s))) { out.push({ t: 'heading', level: m[1].length, c: parseInline(m[2]), line: n }); i += 1; continue; }
        if (HR.test(s)) { out.push({ t: 'hr', line: n }); i += 1; continue; }
        if (QUOTE.test(s)) {
            const inner = [];
            while (i < lines.length && QUOTE.test(lines[i].s)) { inner.push({ s: lines[i].s.replace(/^ {0,3}> ?/, ''), n: lines[i].n }); i += 1; }
            out.push(depth >= LIMITS.depth ? { t: 'p', c: parseInline(inner.map((l) => l.s).join('\n')), line: n } : { t: 'quote', c: blocks(inner, depth + 1), line: n });
            continue;
        }
        if ((m = ITEM.exec(s))) {
            const ordered = /\d/.test(m[2]);
            const list = { t: 'list', ordered, start: ordered ? Number(m[2].replace(/\D/g, '')) : 1, items: [], line: n };
            while (i < lines.length) {
                const im = ITEM.exec(lines[i].s);
                if (!im || /\d/.test(im[2]) !== ordered || im[1].length > 3) break;
                const width = im[1].length + im[2].length + Math.min(Math.max(im[3].length, 1), 4);
                let first = im[4];
                let task = null;
                const tm = /^\[([ xX])\][ \t]+(.*)$/.exec(first) || (/^\[([ xX])\]$/.test(first) ? [null, first[1], ''] : null);
                if (tm) { task = tm[1] !== ' '; first = tm[2]; }
                const body = [{ s: first, n: lines[i].n }];
                const at = lines[i].n;
                i += 1;
                while (i < lines.length) {
                    const t = lines[i].s;
                    if (!t.trim()) {
                        // a blank line stays in the item only if an indented line follows
                        let k = i;
                        while (k < lines.length && !lines[k].s.trim()) k += 1;
                        if (k < lines.length && /^ {2,}\S/.test(lines[k].s) && lines[k].s.search(/\S/) >= Math.min(width, 2)) { while (i < k) { body.push({ s: '', n: lines[i].n }); i += 1; } continue; }
                        break;
                    }
                    const ind = t.search(/\S/);
                    if (ind >= Math.min(width, 2) && (ind >= 2)) { body.push({ s: t.slice(Math.min(ind, width)), n: lines[i].n }); i += 1; continue; }
                    if (ITEM.test(t) || starts(t)) break;
                    body.push({ s: t, n: lines[i].n });      // lazy continuation of the item's paragraph
                    i += 1;
                }
                list.items.push({ task, line: at, c: depth >= LIMITS.depth ? [{ t: 'p', c: parseInline(body.map((l) => l.s).join('\n')), line: at }] : blocks(body, depth + 1) });
                while (i < lines.length && !lines[i].s.trim() && i + 1 < lines.length && ITEM.test(lines[i + 1].s) && /\d/.test(ITEM.exec(lines[i + 1].s)[2]) === ordered) i += 1;
            }
            out.push(list);
            continue;
        }
        if (s.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1].s)) {
            const head = splitRow(s);
            const seps = splitRow(lines[i + 1].s);
            if (head.length === seps.length && head.length > 1 && seps.every((c) => /^:?-+:?$/.test(c))) {
                const align = seps.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
                const rows = [];
                i += 2;
                while (i < lines.length && lines[i].s.trim() && lines[i].s.includes('|') && rows.length < 500) { rows.push(splitRow(lines[i].s).slice(0, head.length)); i += 1; }
                out.push({ t: 'table', align, head: head.map((c) => parseInline(c)), rows: rows.map((r) => r.map((c) => parseInline(c))), line: n });
                continue;
            }
        }
        const para = [s];
        i += 1;
        while (i < lines.length && lines[i].s.trim() && !starts(lines[i].s)) { para.push(lines[i].s); i += 1; }
        out.push({ t: 'p', c: parseInline(para.map((x) => x.replace(/^ +/, '')).join('\n')), line: n });
    }
    return out;
}

// Markdown text -> block tree. Over-long input is cut at LIMITS.chars / LIMITS.lines (the rest is simply not shown).
export function parse(src) {
    const text = String(src == null ? '' : src).slice(0, LIMITS.chars).replace(/\r\n?/g, '\n');
    const lines = text.split('\n').slice(0, LIMITS.lines).map((s, n) => ({ s: s.replace(/\t/g, '    '), n }));
    return blocks(lines, 0);
}

// Every [[target]] a note's text names (outside code), in order, once each: for the editor's live resolve.
export function wikilinkTargets(src) {
    const found = [];
    const seen = new Set();
    const walk = (nodes) => {
        for (const b of nodes) {
            const inl = (list) => { for (const x of list || []) { if (x.t === 'wikilink' && !seen.has(x.target.toLowerCase())) { seen.add(x.target.toLowerCase()); found.push(x.target); } else if (x.c) inl(x.c); } };
            inl(b.c); inl(b.head); (b.rows || []).forEach((r) => r.forEach(inl));
            if (b.t === 'quote') walk(b.c);
            if (b.t === 'list') b.items.forEach((it) => walk(it.c));
        }
    };
    walk(parse(src));
    return found.slice(0, 100);
}

// Flips the task marker on one source line ([ ] <-> [x]); null when that line has no task marker.
export function toggleTaskLine(src, line) {
    const lines = String(src).split('\n');
    const l = lines[line];
    if (l == null) return null;
    const m = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\](?=\s|$)/.exec(l);
    if (!m) return null;
    lines[line] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${l.slice(m[0].length)}`;
    return lines.join('\n');
}

/* ---------- DOM ---------- */

const defaultAdapter = {
    el: (tag, attrs, kids) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
        for (const kid of kids || []) e.append(kid);
        return e;
    },
    text: (s) => document.createTextNode(s),
};

// opts: { adapter?, wikilink?(node) -> { href?, missing?, title?, label? } | null, onToggleTask?(line, checked), onMissing?(target) }
// Returns a <div class="md"> (or the adapter's equivalent).
export function render(src, opts = {}) {
    const a = opts.adapter || defaultAdapter;
    const inline = (nodes) => nodes.map((x) => {
        switch (x.t) {
        case 'text': return a.text(x.v);
        case 'br': return a.el('br', {}, []);
        case 'code': return a.el('code', {}, [a.text(x.v)]);
        case 'strong': return a.el('strong', {}, inline(x.c));
        case 'em': return a.el('em', {}, inline(x.c));
        case 'del': return a.el('del', {}, inline(x.c));
        case 'link': return a.el('a', { href: x.href, class: x.image ? 'md-link md-image' : 'md-link', ...(x.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, inline(x.c));
        case 'wikilink': {
            const info = (opts.wikilink && opts.wikilink(x)) || null;
            const shown = x.label || (info && info.label) || x.target;
            if (info && info.href) return a.el('a', { href: info.href, class: 'wikilink', ...(info.title ? { title: info.title } : {}) }, [a.text(shown)]);
            if (info && info.missing) return a.el('a', { href: '#', class: 'wikilink missing', role: 'button', 'data-create': x.target, title: `No note or entity is called "${x.target}". Click to create it.` }, [a.text(shown)]);
            return a.el('span', { class: 'wikilink pending' }, [a.text(shown)]);
        }
        default: return a.text('');
        }
    });
    const block = (b) => {
        switch (b.t) {
        case 'heading': return a.el(`h${b.level}`, {}, inline(b.c));
        case 'p': return a.el('p', {}, inline(b.c));
        case 'hr': return a.el('hr', {}, []);
        case 'code': return a.el('pre', {}, [a.el('code', b.lang && /^[\w+#.-]+$/.test(b.lang) ? { class: `lang-${b.lang}` } : {}, [a.text(b.text)])]);
        case 'quote': return a.el('blockquote', {}, b.c.map(block));
        case 'list': return a.el(b.ordered ? 'ol' : 'ul', b.ordered && b.start !== 1 ? { start: String(b.start) } : {}, b.items.map((it) => {
            const kids = it.c.map(block);
            if (it.task != null) {
                const box = a.el('input', { type: 'checkbox', class: 'md-task', 'data-line': String(it.line), 'aria-label': 'Task', ...(it.task ? { checked: true } : {}), ...(opts.onToggleTask ? {} : { disabled: true }) }, []);
                if (box.addEventListener && opts.onToggleTask) box.addEventListener('change', () => opts.onToggleTask(it.line, !!box.checked));
                return a.el('li', { class: 'md-task-item' }, [box, a.el('div', {}, kids)]);
            }
            return a.el('li', {}, kids);
        }));
        case 'table': return a.el('div', { class: 'md-table-wrap' }, [a.el('table', {}, [
            a.el('thead', {}, [a.el('tr', {}, b.head.map((c, k) => a.el('th', b.align[k] ? { style: `text-align:${b.align[k]}` } : {}, inline(c))))]),
            a.el('tbody', {}, b.rows.map((r) => a.el('tr', {}, r.map((c, k) => a.el('td', b.align[k] ? { style: `text-align:${b.align[k]}` } : {}, inline(c)))))),
        ])]);
        default: return a.text('');
        }
    };
    const root = a.el('div', { class: 'md' }, parse(src).map(block));
    if (opts.onMissing && root.addEventListener) {
        root.addEventListener('click', (event) => {
            const t = event.target && event.target.closest ? event.target.closest('a.wikilink.missing') : null;
            if (t) { event.preventDefault(); opts.onMissing(t.getAttribute('data-create'), t); }
        });
    }
    return root;
}
