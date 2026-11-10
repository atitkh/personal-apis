// Command palette (Ctrl/Cmd+K): jump to any view, any digest by date, any key by name, and run actions.
// A combobox over a listbox; arrows move, Enter runs, Escape closes.
import { h, icon, dayLabel, isMac } from './ui.js';
import * as router from './router.js';

let open = null;          // the dialog while it is open
let sources = [];         // functions returning commands (static) or promises of commands (loaded on open)

// A command: { id, label, hint, icon, group, keywords, keys (shortcut shown on the right), run() }
export function addSource(fn) {
    sources.push(fn);
}

function score(cmd, q) {
    if (!q) return 1;
    const hay = `${cmd.label} ${cmd.keywords || ''} ${cmd.group}`.toLowerCase();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let total = 0;
    for (const w of words) {
        const i = hay.indexOf(w);
        if (i < 0) return 0;
        total += i === 0 || hay[i - 1] === ' ' ? 3 : 1;
    }
    return total + (cmd.label.toLowerCase().startsWith(q.toLowerCase()) ? 5 : 0);
}

export function isOpen() {
    return Boolean(open);
}

export async function openPalette() {
    if (open) return;
    const input = h('input', {
        type: 'text', class: 'palette-input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list',
        'aria-autocomplete': 'list', 'aria-label': 'Search views, digests, keys and actions', placeholder: 'Jump to a view, a digest date, a key, or an action',
        autocomplete: 'off', spellcheck: 'false',
    });
    const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
    const status = h('p', { class: 'palette-status', role: 'status' });
    const opener = document.activeElement;
    const dlg = h('dialog', { class: 'palette', 'aria-label': 'Command palette' },
        h('div', { class: 'palette-field' }, icon('search'), input, h('kbd', { text: 'Esc' })),
        list, status);
    open = dlg;

    let commands = [];
    let shown = [];
    let active = 0;

    const run = (cmd) => {
        dlg.close();
        Promise.resolve().then(() => cmd.run());
    };

    const paint = () => {
        const q = input.value.trim();
        shown = commands.map((c) => [c, score(c, q)]).filter(([, s]) => s > 0)
            .sort((a, b) => b[1] - a[1] || (a[0].order || 0) - (b[0].order || 0)).map(([c]) => c).slice(0, q ? 30 : 14);
        active = Math.min(active, Math.max(0, shown.length - 1));
        let lastGroup = null;
        const items = [];
        shown.forEach((c, i) => {
            if (c.group !== lastGroup) {
                items.push(h('li', { class: 'palette-group', role: 'presentation', text: c.group }));
                lastGroup = c.group;
            }
            items.push(h('li', {
                id: `pal-${i}`, role: 'option', class: 'palette-item', 'aria-selected': String(i === active),
                onmousedown: (e) => e.preventDefault(),
                onclick: () => run(c),
                onmousemove: () => { if (active !== i) { active = i; mark(); } },
            }, icon(c.icon || 'expand'), h('span', { class: 'palette-label', text: c.label }), c.hint ? h('span', { class: 'palette-hint', text: c.hint }) : null,
            c.keys ? h('span', { class: 'palette-keys', 'aria-label': `Shortcut: ${c.keys.join(' then ')}` }, c.keys.map((k) => h('kbd', { text: k }))) : null));
        });
        list.replaceChildren(...items);
        status.textContent = shown.length ? '' : q ? `Nothing matches "${q}".` : '';
        mark();
    };
    const mark = () => {
        for (const li of list.querySelectorAll('[role="option"]')) li.setAttribute('aria-selected', String(li.id === `pal-${active}`));
        const el = list.querySelector(`#pal-${active}`);
        if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
    };

    input.addEventListener('input', () => { active = 0; paint(); });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % Math.max(1, shown.length); mark(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); active = (active - 1 + shown.length) % Math.max(1, shown.length); mark(); }
        else if (event.key === 'Enter') { event.preventDefault(); if (shown[active]) run(shown[active]); }
    });
    dlg.addEventListener('mousedown', (event) => { if (event.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => {
        dlg.remove();
        open = null;
        if (opener && opener.isConnected && opener !== document.body) opener.focus();
    });

    document.body.append(dlg);
    dlg.showModal();
    input.focus();

    // Static commands first, loaded ones (digests, keys) join when they arrive.
    const add = (cmds) => { commands = commands.concat(cmds || []); paint(); };
    for (const src of sources) {
        let out;
        try { out = src(); } catch (e) { out = []; }
        if (out && typeof out.then === 'function') {
            status.textContent = 'Loading digests and keys…';
            out.then((cmds) => { if (open === dlg) add(cmds); }).catch(() => {});
        } else {
            add(out);
        }
    }
}

// `enabled` says whether the palette makes sense right now (not before sign-in).
export function installShortcut(enabled = () => true) {
    document.addEventListener('keydown', (event) => {
        if ((isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
            if (!enabled()) return;
            event.preventDefault();
            if (open) open.close();
            else openPalette();
        }
    });
}

// Helpers the app uses to describe digests and keys as commands.
export const digestCommand = (d, order) => ({
    id: `digest:${d.kind}:${d.period}`,
    group: 'Digests',
    icon: 'digests',
    label: d.kind === 'daily' ? dayLabel(d.period, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : `Week ${d.period}`,
    hint: d.kind === 'daily' ? d.period : 'Weekly',
    keywords: `${d.period} ${d.kind} digest`,
    order,
    run: () => router.navigate(router.href('digests', [d.kind, d.period])),
});
