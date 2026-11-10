// Component kit. Plain DOM, no framework. Text from the server only ever goes in through textContent
// (h() sets `text` and string children as text nodes), never innerHTML.

/* ---------- elements ---------- */

export function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    setProps(el, props);
    append(el, kids);
    return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag, props, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    setProps(el, props);
    append(el, kids);
    return el;
}

function setProps(el, props) {
    for (const [key, value] of Object.entries(props || {})) {
        if (value == null || value === false) continue;
        if (key === 'class') el.setAttribute('class', value);
        else if (key === 'text') el.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? '' : value);
    }
}

function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
        if (kid == null || kid === false) continue;
        el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
}

export const hidden = (text) => h('span', { class: 'visually-hidden', text });

/* ---------- formatting ---------- */

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

export function bytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    const v = n / 1024 ** i;
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const when = (iso) => (iso ? dateFmt.format(new Date(iso)) : 'never');

export function ago(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    for (const [size, name] of [[86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
        if (s >= size) return `${plural(Math.floor(s / size), name)} ago`;
    }
    return 'just now';
}

export function span(seconds) {
    const d = Math.floor(seconds / 86400);
    const hrs = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${plural(d, 'day')}, ${plural(hrs, 'hour')}`;
    if (hrs) return `${plural(hrs, 'hour')}, ${plural(m, 'minute')}`;
    return plural(m, 'minute');
}

export function dayLabel(day, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
    return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, opts);
}

export const fact = (label, ...value) => [h('dt', { text: label }), h('dd', {}, ...value)];
export const dot = (kind) => h('span', { class: `dot ${kind}`, 'aria-hidden': 'true' });

/* ---------- icons (24px grid, stroked with currentColor) ---------- */

const ICONS = {
    overview: ['M3 7h7', 'M14 7h7', 'M3 17h4', 'M11 17h10', 'c12 7 2', 'c9 17 2'],
    digests: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6', 'M10 17h6'],
    keys: ['c8 15 4', 'M11 12l8-8', 'M16 7l2.5 2.5', 'M13.5 9.5l2 2'],
    agents: ['M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 4v4', 'M9.5 12.5v1.5', 'M14.5 12.5v1.5'],
    backups: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
    portfolio: ['M4 8h16v11H4z', 'M9 8V5h6v3', 'M4 13h16'],
    activity: ['M3 12h4l3-7 4 14 3-7h4'],
    search: ['c11 11 6.5', 'M20 20l-4.2-4.2'],
    sun: ['c12 12 4', 'M12 2.5v2', 'M12 19.5v2', 'M2.5 12h2', 'M19.5 12h2', 'M5.3 5.3l1.4 1.4', 'M17.3 17.3l1.4 1.4', 'M5.3 18.7l1.4-1.4', 'M17.3 6.7l1.4-1.4'],
    moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
    system: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
    more: ['c5 12 1', 'c12 12 1', 'c19 12 1'],
    collapse: ['M15 6l-6 6 6 6'],
    expand: ['M9 6l6 6-6 6'],
    warn: ['M12 3.5l9 16H3z', 'M12 10v4', 'M12 17h.01'],
    bad: ['c12 12 9', 'M9 9l6 6', 'M15 9l-6 6'],
    good: ['c12 12 9', 'M8 12.5l2.5 2.5L16 9.5'],
    info: ['c12 12 9', 'M12 11v5', 'M12 8h.01'],
    user: ['c12 8 4', 'M4 21a8 8 0 0 1 16 0'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    backup: ['M12 4v10', 'M8 10l4 4 4-4', 'M5 19h14'],
    plus: ['M12 5v14', 'M5 12h14'],
    signout: ['M14 4h5v16h-5', 'M10 8l-4 4 4 4', 'M6 12h10'],
    menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
};

export function icon(name, cls = '') {
    const parts = (ICONS[name] || ICONS.info).map((d) => {
        if (d.startsWith('c')) {
            const [cx, cy, r] = d.slice(1).split(' ');
            return svg('circle', { cx, cy, r });
        }
        return svg('path', { d });
    });
    return svg('svg', { class: `icon ${cls}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, parts);
}

/* ---------- controls ---------- */

// variant: primary (default), quiet, danger, ghost. size: '' or 'small'.
export function button({ text, variant = 'primary', size = '', iconName, onClick, type = 'button', label, ...rest } = {}) {
    const cls = ['btn', variant !== 'primary' ? variant : '', size, iconName && !text ? 'icon-only' : ''].filter(Boolean).join(' ');
    return h('button', { class: cls, type, onclick: onClick, 'aria-label': label, ...rest },
        iconName ? icon(iconName) : null, text ? h('span', { text }) : null);
}

// A real switch: <button role="switch">. The visible state text sits next to it, so state never relies on colour.
export function toggleSwitch({ checked, label, onChange, disabled = false, key }) {
    const el = h('button', {
        type: 'button',
        role: 'switch',
        class: 'switch',
        'aria-checked': String(Boolean(checked)),
        'aria-label': label,
        'data-key': key,
        disabled,
        onclick: () => onChange(el.getAttribute('aria-checked') !== 'true'),
    }, h('span', { class: 'switch-thumb', 'aria-hidden': 'true' }));
    el.setChecked = (v) => el.setAttribute('aria-checked', String(Boolean(v)));
    return el;
}

// Segmented control as a radio group: one tab stop, arrow keys move and select.
export function segmented({ options, value, label, onChange, iconOnly = false, key, cls = '' }) {
    const group = h('div', { class: `segmented ${iconOnly ? 'icon-seg' : ''} ${cls}`.trim(), role: 'radiogroup', 'aria-label': label });
    const buttons = options.map((o) => h('button', {
        type: 'button',
        role: 'radio',
        class: 'seg',
        'data-value': o.value,
        'data-key': key ? `${key}:${o.value}` : null,
        'aria-label': iconOnly ? o.label : null,
        title: iconOnly ? o.label : null,
        onclick: () => choose(o.value, true),
    }, o.icon ? icon(o.icon) : null, iconOnly ? null : h('span', { text: o.label })));
    group.append(...buttons);

    const paint = (v) => {
        for (const b of buttons) {
            const on = b.dataset.value === v;
            b.setAttribute('aria-checked', String(on));
            b.tabIndex = on ? 0 : -1;
        }
        group.dataset.value = v;
    };
    const choose = (v, fromUser) => {
        if (fromUser && v === group.dataset.value) return;
        if (fromUser && onChange) onChange(v);
    };
    group.addEventListener('keydown', (event) => {
        const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        const i = buttons.findIndex((b) => b === document.activeElement);
        const next = buttons[(i + keys[event.key] + buttons.length) % buttons.length];
        next.focus();
        choose(next.dataset.value, true);
    });
    paint(value);
    group.setValue = paint;
    return group;
}

/* ---------- dialogs, drawer ---------- */

function modal(cls, labelId, children) {
    const dlg = h('dialog', { class: cls, 'aria-labelledby': labelId }, children);
    const opener = document.activeElement;
    dlg.addEventListener('close', () => {
        dlg.remove();
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    });
    // A click on the backdrop (outside the box) closes it.
    dlg.addEventListener('mousedown', (event) => { if (event.target === dlg) dlg.close('cancel'); });
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
}

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

// A focus-trapped confirmation. Resolves true only when the confirm button is used.
export function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
        const id = nextId('dlg');
        let ok = false;
        const yes = button({ text: confirm, variant: danger ? 'danger' : 'primary', onClick: () => { ok = true; dlg.close(); } });
        const no = button({ text: cancel, variant: 'quiet', onClick: () => dlg.close(), autofocus: true });
        const dlg = modal('dialog', id, [
            h('h2', { id, text: title }),
            (Array.isArray(body) ? body : [body]).filter(Boolean).map((t) => (typeof t === 'string' ? h('p', { text: t }) : t)),
            h('div', { class: 'dialog-actions' }, no, yes),
        ]);
        dlg.addEventListener('close', () => resolve(ok));
    });
}

// Right-hand drawer (a full sheet on small screens). Returns { close, body }.
export function openDrawer({ title, content, onClose }) {
    const id = nextId('drawer');
    const body = h('div', { class: 'drawer-body' }, content);
    const dlg = modal('drawer', id, [
        h('header', { class: 'drawer-head' },
            h('h2', { id, text: title }),
            button({ variant: 'ghost', iconName: 'close', label: 'Close', onClick: () => dlg.close() })),
        body,
    ]);
    dlg.addEventListener('close', () => { if (onClose) onClose(); });
    return { close: () => dlg.close(), body };
}

/* ---------- toasts ---------- */

let politeRegion;
let alertRegion;

function regions() {
    if (!politeRegion || !politeRegion.isConnected) {
        politeRegion = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
        alertRegion = h('div', { class: 'toasts toasts-alert', role: 'alert', 'aria-live': 'assertive' });
        document.body.append(h('div', { class: 'toast-stack' }, alertRegion, politeRegion));
    }
}

// kind: good, bad, info. Errors stay longer and are announced assertively.
export function toast(message, { kind = 'good', timeout } = {}) {
    regions();
    const item = h('div', { class: `toast ${kind}` },
        icon(kind === 'bad' ? 'bad' : kind === 'info' ? 'info' : 'good'),
        h('span', { class: 'toast-text', text: message }),
        button({ variant: 'ghost', size: 'small', iconName: 'close', label: 'Dismiss', onClick: () => dismiss() }));
    const dismiss = () => {
        item.classList.add('leaving');
        setTimeout(() => item.remove(), 160);
    };
    (kind === 'bad' ? alertRegion : politeRegion).append(item);
    setTimeout(dismiss, timeout || (kind === 'bad' ? 9000 : 4500));
    return dismiss;
}

/* ---------- placeholders ---------- */

export function skeleton(rows = 3, cls = '') {
    return h('div', { class: `skeleton-block ${cls}`.trim(), 'aria-busy': 'true' },
        hidden('Loading'),
        Array.from({ length: rows }, (_, i) => h('div', { class: `skeleton ${i === 0 ? 'wide' : ''}`.trim(), 'aria-hidden': 'true' })));
}

export function emptyState({ title, text, action, iconName = 'info' }) {
    return h('div', { class: 'empty' },
        icon(iconName, 'empty-icon'),
        h('p', { class: 'empty-title', text: title }),
        text ? h('p', { class: 'empty-text', text }) : null,
        action || null);
}

// Re-render part of the page without losing keyboard focus: elements carry data-key and the focused one
// is focused again after `fn` replaced them.
export function keepFocus(container, fn) {
    const active = document.activeElement;
    const key = active && container.contains(active) ? active.getAttribute('data-key') : null;
    fn();
    if (key) {
        const again = [...container.querySelectorAll('[data-key]')].find((el) => el.getAttribute('data-key') === key);
        if (again) again.focus();
    }
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Domain colour slots. Known domains have fixed colours; new ones take the spare slots in order.
const DOMAIN_HUES = { digests: 'amber', portfolio: 'cobalt', flights: 'teal' };
const SPARE = ['plum', 'brick'];
export function domainHue(name, index = 0) {
    return DOMAIN_HUES[name] || SPARE[index % SPARE.length];
}
