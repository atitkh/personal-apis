// Keyboard shortcuts: one list (shown in Settings, the palette and the ? dialog) and the global handler.
// Single-key shortcuts are ignored while typing in a field or while a dialog, drawer or the palette is open.
import { h, infoDialog, isMac } from './ui.js';

const MOD = isMac ? '⌘' : 'Ctrl';

// `g` then a letter: [letter, route, page name]
export const GO = [
    ['o', 'overview', 'Overview'],
    ['d', 'digests', 'Digests'],
    ['p', 'places', 'Places'],
    ['f', 'flights', 'Flights'],
    ['r', 'deadlines', 'Deadlines'],
    ['k', 'keys', 'API keys'],
    ['a', 'agents', 'Agent access'],
    ['s', 'settings', 'Settings'],
];

// [keys, how they combine ('+' together, 'then' one after the other, '/' any of them), what it does]
export const SHORTCUTS = [
    [[MOD, 'K'], '+', 'Search, jump to any page, digest or key, and run actions'],
    ...GO.map(([k, , title]) => [['G', k.toUpperCase()], 'then', `Go to ${title}`]),
    [['/'], '+', 'Search this page (opens the palette where a page has no search field)'],
    [['?'], '+', 'Show the keyboard shortcuts'],
    [['['], '+', 'Show or hide the side menu'],
    [['Esc'], '+', 'Close a drawer, dialog or the palette; cancel editing a digest'],
    [['←', '→', '↑', '↓'], '/', 'Move between days in the digest calendar and the 30-day strip, between options in a selector, and between tabs'],
    [['Page Up', 'Page Down'], '/', 'Previous or next month in the digest calendar'],
    [['Home', 'End'], '/', 'Start or end of the week in the calendar'],
    [[MOD, 'Enter'], '+', 'Save a digest while editing'],
];

const JOIN = { '+': ' + ', then: ' then ', '/': ' ' };

export function keysLabel(keys, join) {
    return keys.map((k, i) => [i ? h('span', { class: 'kbd-join', text: JOIN[join] }) : null, h('kbd', { text: k })]);
}

export function shortcutList() {
    return h('dl', { class: 'shortcuts' }, SHORTCUTS.map(([keys, join, text]) => [
        h('dt', {}, keysLabel(keys, join)),
        h('dd', { text }),
    ]));
}

export function showShortcuts() {
    if (document.querySelector('dialog[open]')) return null;
    return infoDialog({
        title: 'Keyboard shortcuts',
        cls: 'shortcuts-dialog',
        content: [h('p', { class: 'note', text: 'Letter keys work anywhere except while you type in a field.' }), shortcutList()],
    });
}

const isTyping = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));

// enabled(): only after sign-in. go(route), toggleRail(), openPalette(), content() -> the main element.
export function installShortcuts({ enabled, go, toggleRail, openPalette, content }) {
    let gAt = 0; // when `g` was pressed; the next key within 1.5 s picks the page
    document.addEventListener('keydown', (event) => {
        if (!enabled() || event.defaultPrevented || event.repeat || event.isComposing) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isTyping(event.target) || isTyping(document.activeElement)) return;
        if (document.querySelector('dialog[open]')) return;
        const key = event.key;
        if (gAt && Date.now() - gAt < 1500) {
            gAt = 0;
            const hit = GO.find(([k]) => k === key.toLowerCase());
            if (hit) { event.preventDefault(); go(hit[1]); }
            return;
        }
        gAt = 0;
        if (key === 'g' && !event.shiftKey) { gAt = Date.now(); return; }
        if (key === '/') {
            event.preventDefault();
            const field = content() && content().querySelector('input[type="search"]');
            if (field) { field.focus(); field.select(); } else openPalette();
        } else if (key === '?') {
            event.preventDefault();
            showShortcuts();
        } else if (key === '[') {
            event.preventDefault();
            toggleRail();
        }
    });
}
