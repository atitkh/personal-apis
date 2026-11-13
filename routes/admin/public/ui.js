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
    settings: ['c12 12 6', 'c12 12 2.5', 'M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3', 'M5.6 5.6l2.2 2.2', 'M16.2 16.2l2.2 2.2', 'M5.6 18.4l2.2-2.2', 'M16.2 7.8l2.2-2.2'],
    copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
    edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
    history: ['M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3 4v4h4', 'M12 8v4l3 2'],
    calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    retry: ['M20.5 12a8.5 8.5 0 1 1-2.5-6', 'M21 4v4h-4'],
    offline: ['M3 3l18 18', 'M8.5 6.2A6 6 0 0 1 17.6 10H18a4 4 0 0 1 2 7.5', 'M16 19H7a4 4 0 0 1-1.6-7.7'],
    keyboard: ['M3 7h18v10H3z', 'M7 11h.01', 'M11 11h.01', 'M15 11h.01', 'M8 14h8'],
    prev: ['M15 6l-6 6 6 6'],
    next: ['M9 6l6 6-6 6'],
    places: ['M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z', 'c12 10 2.3'],
    flights: ['M21 15.5l-8-4.5V5.5a1.5 1.5 0 0 0-3 0V11l-8 4.5v2l8-2.2V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-3.7l8 2.2z'],
    trips: ['M5 8h14v12H5z', 'M9 8V5h6v3', 'M9 8v12', 'M15 8v12'],
    lifelog: ['M6 4h11a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2z', 'M6 18a2 2 0 0 1 2-2h11', 'M10 8h6', 'M10 11.5h4'],
    deadlines: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4', 'M12 13v3l2 1.5'],
    preferences: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'c15 7 2', 'c9 17 2'],
    lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
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
// `pressed`: plain toggle buttons with aria-pressed (in a role=group) instead of radios; every button stays in the tab order.
export function segmented({ options, value, label, onChange, iconOnly = false, key, cls = '', pressed = false }) {
    const group = h('div', { class: `segmented ${iconOnly ? 'icon-seg' : ''} ${cls}`.trim(), role: pressed ? 'group' : 'radiogroup', 'aria-label': label });
    const buttons = options.map((o) => h('button', {
        type: 'button',
        role: pressed ? null : 'radio',
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
            if (pressed) b.setAttribute('aria-pressed', String(on));
            else { b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
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

// A modal <dialog>: focus stays inside (showModal makes the page inert), Esc and a backdrop click close it,
// and focus goes back to the opener afterwards. `returnFocus()` picks the target when the opener may have been
// re-rendered away; `beforeClose()` may return false (or a promise of false) to keep it open.
function modal(cls, labelId, children, { returnFocus, beforeClose } = {}) {
    const dlg = h('dialog', { class: cls, 'aria-labelledby': labelId }, children);
    const opener = document.activeElement;
    let asking = false;
    dlg.tryClose = async (value) => {
        if (asking || !dlg.open) return;
        if (beforeClose) {
            asking = true;
            const ok = await beforeClose();
            asking = false;
            if (ok === false) return;
        }
        dlg.close(value);
    };
    dlg.addEventListener('cancel', (event) => { event.preventDefault(); dlg.tryClose('cancel'); });
    dlg.addEventListener('close', () => {
        dlg.remove();
        const target = (returnFocus && returnFocus()) || opener;
        if (target && target.isConnected && typeof target.focus === 'function') target.focus();
    });
    // A click on the backdrop (outside the box) closes it.
    dlg.addEventListener('mousedown', (event) => { if (event.target === dlg) dlg.tryClose('cancel'); });
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

// A modal form: `fields` are the form's contents (labels and inputs), `submit` the button text. `onSubmit(form)`
// runs on submit; a thrown error is shown in the dialog (it stays open), anything it returns resolves the promise.
// Cancel, Esc and the backdrop resolve null. Focus starts on the first field and returns to the opener.
export function formDialog({ title, intro, fields, submit = 'Save', danger = false, onSubmit, cls = '' }) {
    return new Promise((resolve) => {
        const id = nextId('dlg');
        let result = null;
        const error = h('p', { class: 'error', role: 'alert' });
        const yes = button({ text: submit, type: 'submit', variant: danger ? 'danger' : 'primary' });
        const no = button({ text: 'Cancel', variant: 'quiet', onClick: () => dlg.tryClose() });
        const form = h('form', {
            class: 'dialog-form',
            novalidate: true,
            onsubmit: async (event) => {
                event.preventDefault();
                if (yes.disabled) return;
                error.textContent = '';
                yes.disabled = true;
                try {
                    result = await onSubmit(form);
                    if (result === undefined) result = true;
                    dlg.close();
                } catch (err) {
                    error.textContent = err.message || 'That did not work.';
                    yes.disabled = false;
                    const bad = err.field && form.querySelector(`[name="${err.field}"]`);
                    if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); }
                }
            },
        },
        (Array.isArray(intro) ? intro : [intro]).filter(Boolean).map((t) => (typeof t === 'string' ? h('p', { class: 'dialog-intro', text: t }) : t)),
        h('div', { class: 'dialog-fields' }, fields),
        error,
        h('div', { class: 'dialog-actions' }, no, yes));
        const dlg = modal(`dialog form-dialog ${cls}`.trim(), id, [h('h2', { id, text: title }), form]);
        dlg.addEventListener('close', () => resolve(result));
        const first = form.querySelector('input:not([type="hidden"]):not([disabled]), select, textarea');
        if (first) first.focus();
    });
}

// "Delete permanently": a red confirm that says what goes (`goes`), what does not (`stays`) and that it cannot be undone,
// an optional `warn` sentence, with a "Back up the database first" box (on by default) and any `options` ({ name, label, help, checked }).
// `run({ backup, ...options })` makes the request; its error stays in the dialog (a 409 explains itself). Resolves the
// result of `run`, or null when cancelled.
export function deleteDialog({ title, goes = [], stays = [], warn = null, options = [], run }) {
    const boxes = [
        { name: 'backup', label: 'Back up the database first', help: 'Saves a copy named hub-pre-delete-<time>.db next to the daily backups. If the copy fails, nothing is deleted.', checked: true },
        ...options,
    ];
    const fields = boxes.map((o) => {
        const id = nextId('del');
        const input = h('input', { type: 'checkbox', name: o.name, id });
        input.checked = Boolean(o.checked);
        return h('div', { class: 'check-field' },
            h('label', { class: 'check', for: id }, input, h('span', { text: o.label })),
            o.help ? h('p', { class: 'help', text: o.help }) : null);
    });
    const list = (items) => h('ul', { class: 'delete-list' }, items.map((t) => h('li', { text: t })));
    return formDialog({
        title,
        cls: 'delete-dialog',
        intro: [
            h('p', { class: 'dialog-intro' }, h('strong', { text: 'This deletes' })),
            list(goes),
            stays.length ? h('p', { class: 'dialog-intro' }, h('strong', { text: 'This does not delete' })) : null,
            stays.length ? list(stays) : null,
            warn ? h('p', { class: 'dialog-intro', text: warn }) : null,
            h('p', { class: 'dialog-intro' }, h('strong', { text: 'This cannot be undone.' })),
        ],
        fields,
        submit: 'Delete permanently',
        danger: true,
        onSubmit: (form) => run(Object.fromEntries(boxes.map((o) => [o.name, form.elements[o.name].checked]))),
    });
}

// A dialog that only shows something (the shortcut list); a Close button, Esc and the backdrop close it.
export function infoDialog({ title, content, cls = '' }) {
    const id = nextId('dlg');
    const dlg = modal(`dialog ${cls}`.trim(), id, [
        h('div', { class: 'dialog-top' },
            h('h2', { id, text: title }),
            button({ variant: 'ghost', iconName: 'close', label: 'Close', onClick: () => dlg.tryClose() })),
        content,
    ]);
    return dlg;
}

// A bottom sheet (phones): the More menu. Returns the dialog; links inside close it when followed.
export function openSheet({ title, content }) {
    const id = nextId('sheet');
    const dlg = modal('sheet', id, [
        h('div', { class: 'sheet-top' },
            h('h2', { id, text: title }),
            button({ variant: 'ghost', iconName: 'close', label: 'Close', onClick: () => dlg.tryClose() })),
        content,
    ]);
    dlg.addEventListener('click', (event) => { if (event.target.closest('a[href]')) dlg.close(); });
    return dlg;
}

// Right-hand drawer (a full sheet on small screens). `close()` asks beforeClose first; `close(true)` does not.
export function openDrawer({ title, subtitle, content, onClose, returnFocus, beforeClose, wide = false }) {
    const id = nextId('drawer');
    const heading = h('h2', { id, text: title });
    const sub = h('p', { class: 'drawer-sub', text: subtitle || '' });
    const body = h('div', { class: 'drawer-body' }, content);
    const dlg = modal(`drawer${wide ? ' wide' : ''}`, id, [
        h('header', { class: 'drawer-head' },
            h('div', { class: 'drawer-titles' }, heading, sub),
            button({ variant: 'ghost', iconName: 'close', label: 'Close', onClick: () => dlg.tryClose() })),
        body,
    ], { returnFocus, beforeClose });
    dlg.addEventListener('close', () => { if (onClose) onClose(); });
    return {
        el: dlg,
        body,
        close: (force) => (force ? dlg.open && dlg.close() : dlg.tryClose()),
        isOpen: () => dlg.open,
        setTitle(text, subText) { heading.textContent = text; sub.textContent = subText || ''; },
        setContent(...kids) { body.replaceChildren(...kids.flat().filter(Boolean)); body.scrollTop = 0; },
    };
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

// The standard head of a page, under the title in the top bar: an optional heading (sub-pages), a one-line
// lede, optional meta chips (counts), and the page's primary action(s) on the right. `lede` may be a string
// or a list of nodes (a link inside the sentence); `actions` one node or a list.
export function pageHeader({ title, lede, actions, meta } = {}) {
    const acts = [].concat(actions || []).filter(Boolean);
    const chips = [].concat(meta || []).filter(Boolean);
    return h('header', { class: 'page-header' },
        h('div', { class: 'page-header-main' },
            title ? h('h2', { class: 'page-header-title', text: title }) : null,
            lede ? h('p', { class: 'lede' }, lede) : null,
            chips.length ? h('p', { class: 'page-meta' }, chips.map((c) => (typeof c === 'string' ? h('span', { class: 'chip', text: c }) : c))) : null),
        acts.length ? h('div', { class: 'page-header-actions' }, acts) : null);
}

// The action row at the foot of a form (drawer or page): primary first, then quiet buttons. Sticks to the
// bottom of a drawer so Save stays in reach on a long form.
export function formActions(...kids) {
    return h('div', { class: 'form-actions' }, kids.flat().filter(Boolean));
}

export function emptyState({ title, text, action, iconName = 'info' }) {
    return h('div', { class: 'empty' },
        icon(iconName, 'empty-icon'),
        h('p', { class: 'empty-title', text: title }),
        text ? h('p', { class: 'empty-text', text }) : null,
        action || null);
}

// A failed load, shown in place of what did not load, with Retry. Network failures say so plainly.
export function errorState({ err, retry, what = 'This page' }) {
    const net = Boolean(err && err.network);
    return h('div', { class: 'empty error-state', role: 'alert' },
        icon(net ? 'offline' : 'bad', 'empty-icon'),
        h('p', { class: 'empty-title', text: net ? 'The hub did not answer.' : `${what} did not load.` }),
        h('p', { class: 'empty-text', text: net ? 'The connection or the service may be down. Nothing was changed; try again in a moment.' : (err && err.message) || 'Something went wrong.' }),
        retry ? button({
            text: 'Retry', variant: 'quiet', iconName: 'retry', 'data-key': 'retry',
            onClick: async (event) => {
                const b = event.currentTarget;
                if (b.getAttribute('aria-disabled') === 'true') return;
                b.setAttribute('aria-disabled', 'true');
                b.querySelector('span').textContent = 'Retrying…';
                try { await retry(); } finally {
                    if (b.isConnected) { b.removeAttribute('aria-disabled'); b.querySelector('span').textContent = 'Retry'; }
                }
            },
        }) : null);
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

/* ---------- chips, copy, roving focus ---------- */

// A small pill. `hue` colours its swatch (domain identity); the text always says what it is.
export function chip(text, { hue, cls = '', title } = {}) {
    return h('span', { class: `chip ${cls}`.trim(), title },
        hue ? h('span', { class: `swatch hue-${hue}`, 'aria-hidden': 'true' }) : null,
        h('span', { text }));
}

// Filter chips as links (the filter lives in the URL). items: [{ id, label, href }].
export function chipNav({ label, items, current }) {
    return h('nav', { class: 'chip-nav', 'aria-label': label },
        h('ul', {}, items.map((i) => h('li', {}, h('a', {
            class: 'chip-link',
            href: i.href,
            'data-key': `chip:${i.id}`,
            'aria-current': i.id === current ? 'true' : null,
        }, i.id === current ? icon('check') : null, h('span', { text: i.label }))))));
}

// Copies `value` with the clipboard API. Where that is not available (plain http, older browsers) it selects
// the text in `field` and tries the old copy command; failing that it asks for Ctrl C. Says what happened.
export function copyButton({ value, field, text = 'Copy', done = 'Copied', variant = 'quiet', size = '', label, onCopied }) {
    const btn = button({
        text, variant, size, iconName: 'copy', label,
        onClick: async () => {
            const v = typeof value === 'function' ? value() : value;
            let ok = false;
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(v);
                    ok = true;
                }
            } catch (e) { ok = false; }
            if (!ok && field) {
                field.focus();
                field.select();
                try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            }
            const span = btn.querySelector('span');
            if (ok) {
                if (span) span.textContent = done;
                btn.replaceChildren(icon('check'), span);
                setTimeout(() => { if (span) span.textContent = text; btn.replaceChildren(icon('copy'), span); }, 2400);
                toast(done);
                if (onCopied) onCopied();
            } else {
                toast(field ? `Selected. Press ${isMac ? 'Cmd' : 'Ctrl'} C to copy.` : 'This browser blocked copying. Select the text and copy it by hand.', { kind: 'info' });
            }
        },
    });
    return btn;
}

// One tab stop for a group of cells: arrow keys move focus within it (roving tabindex).
// next(i, key) returns the new index, false for a key it handled without moving, or undefined to ignore the key.
// The default walks a flat list: Left/Up back, Right/Down forward, Home/End to the ends.
export function roving(container, cells, { start = 0, next } = {}) {
    if (!cells.length) return;
    const linear = (i, key) => ({
        ArrowRight: Math.min(i + 1, cells.length - 1),
        ArrowDown: Math.min(i + 1, cells.length - 1),
        ArrowLeft: Math.max(i - 1, 0),
        ArrowUp: Math.max(i - 1, 0),
        Home: 0,
        End: cells.length - 1,
    }[key]);
    const set = (i) => cells.forEach((c, j) => { c.tabIndex = j === i ? 0 : -1; });
    set(Math.min(Math.max(start, 0), cells.length - 1));
    container.addEventListener('keydown', (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const i = cells.indexOf(event.target);
        if (i < 0) return;
        const j = (next || linear)(i, event.key);
        if (j === undefined) return;
        event.preventDefault();
        if (j === false || j === i) return;
        set(j);
        cells[j].focus();
    });
    container.addEventListener('focusin', (event) => {
        const i = cells.indexOf(event.target);
        if (i >= 0) set(i);
    });
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// The one person who signs in here; the audit log and revisions record them as "admin".
export const ADMIN_NAME = 'Atit';
export const actorName = (actor) => (actor === 'admin' ? ADMIN_NAME : actor);

// Domain colour slots. Known domains have fixed colours; new ones take the spare slots in order.
const DOMAIN_HUES = { digests: 'amber', portfolio: 'cobalt', flights: 'teal', places: 'plum', deadlines: 'rose', preferences: 'brick', trips: 'indigo', lifelog: 'moss' };
const SPARE = ['neutral', 'muted'];
export function domainHue(name, index = 0) {
    return DOMAIN_HUES[name] || SPARE[index % SPARE.length];
}
