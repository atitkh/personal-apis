// Edit a key's scopes in place: checkboxes grouped by domain (labels come from scopes.js), a diff sentence, and the
// save call. Used by the Keys drawer (every domain) and the Agent access cells (one domain). The key's secret never
// changes, and the hub reads a key's scopes on every call, so a change applies to its next request.
import { h, button, confirmDialog } from './ui.js';
import { CATALOGUE, explain, scopeHue } from './scopes.js';

export const APPLIES = "Changes apply on the key's next call. The key itself does not change, so whatever uses it needs no new setup.";

export function diffScopes(before, after) {
    return { added: after.filter((s) => !before.includes(s)), removed: before.filter((s) => !after.includes(s)) };
}

const list = (items) => items.join(', ');

// "Adds flights:observe. Removes places:agent-write."
export function diffSentence(added, removed) {
    const parts = [];
    if (added.length) parts.push(`Adds ${list(added)}.`);
    if (removed.length) parts.push(`Removes ${list(removed)}.`);
    return parts.join(' ');
}

const known = new Set(CATALOGUE.flatMap((d) => [...d.scopes.map((s) => s.scope), `${d.domain}:*`]));
const idOf = (prefix, scope) => `${prefix}-${scope === '*' ? 'star' : scope.replace(':*', '-all').replace(/[^a-z0-9_-]/gi, '-')}`;

function pick(prefix, { scope, label, text, write, cls = '' }, box) {
    box.id = idOf(prefix, scope);
    return h('li', {}, h('label', { class: `pick ${cls}`, for: box.id }, box,
        h('span', { class: 'pick-text' },
            h('span', { class: 'pick-name' }, h('span', { text: label }), write ? h('span', { class: 'chip chip-write', text: 'changes data' }) : null),
            h('span', { class: 'pick-help', text }),
            h('code', { class: 'scope-code', text: scope }))));
}

// initial: the key's scopes now. only: a domain name to show just that domain (Agent access cells).
// Returns { el, get(), diff(), dirty(), reset() }; onChange fires after every change.
export function scopeEditor({ initial, only = null, prefix = 'se', onChange = () => {} }) {
    const start = [...initial];
    let sel = new Set(start);
    let stash = start.filter((s) => s !== '*');
    const boxes = []; // { box, scope, domain, kind: 'star' | 'wild' | 'scope' | 'extra' }
    const hasStar = () => sel.has('*');

    const track = (scope, domain, kind) => {
        const box = h('input', { type: 'checkbox', value: scope });
        boxes.push({ box, scope, domain, kind });
        box.addEventListener('change', () => toggle({ scope, domain, kind }, box.checked));
        return box;
    };

    function toggle({ scope, domain, kind }, on) {
        if (kind === 'star') {
            if (on) { stash = [...sel].filter((s) => s !== '*'); sel = new Set(['*']); } else { sel = new Set(stash); }
        } else if (kind === 'wild') {
            if (on) { for (const s of [...sel]) if (s.startsWith(`${domain}:`)) sel.delete(s); sel.add(scope); } else sel.delete(scope);
        } else if (on) sel.add(scope); else sel.delete(scope);
        sync();
        onChange();
    }

    function sync() {
        for (const { box, scope, domain, kind } of boxes) {
            box.checked = hasStar() ? kind === 'star' : sel.has(scope);
            box.disabled = kind === 'star' ? false : hasStar() || (kind === 'scope' && sel.has(`${domain}:*`));
        }
    }

    const domainFieldset = (d) => {
        const items = d.scopes.map((s) => pick(prefix, s, track(s.scope, d.domain, 'scope')));
        const all = pick(prefix, { scope: `${d.domain}:*`, label: `Everything in ${d.title}`, text: 'Includes actions added later.', cls: 'pick-all' }, track(`${d.domain}:*`, d.domain, 'wild'));
        return h('fieldset', { class: `pick-group hue-${scopeHue(d.domain)}` },
            h('legend', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), d.title),
            h('ul', {}, items, all));
    };

    const parts = [];
    if (only) {
        const d = CATALOGUE.find((x) => x.domain === only);
        if (d) parts.push(domainFieldset(d));
    } else {
        parts.push(...CATALOGUE.map(domainFieldset));
        const extras = start.filter((s) => s !== '*' && !known.has(s));
        if (extras.length) {
            parts.push(h('fieldset', { class: 'pick-group hue-neutral' },
                h('legend', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), 'Other scopes on this key'),
                h('p', { class: 'help' }, 'Not in the list above (older or custom). They stay unless you untick them.'),
                h('ul', {}, extras.map((s) => { const e = explain(s); return pick(prefix, { scope: s, label: e.label, text: e.text, write: e.write }, track(s, null, 'extra')); }))));
        }
        parts.push(h('fieldset', { class: 'pick-group hue-neutral' },
            h('legend', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), 'Everything'),
            h('ul', {}, pick(prefix, { scope: '*', label: 'All access', text: explain('*').text, write: true }, track('*', null, 'star')))));
    }
    sync();

    const order = (set) => [...start.filter((s) => set.has(s)), ...[...set].filter((s) => !start.includes(s))];
    return {
        el: h('div', { class: 'pick-groups' }, parts),
        get: () => order(sel),
        diff: () => diffScopes(start, order(sel)),
        dirty: () => { const d = diffScopes(start, order(sel)); return d.added.length > 0 || d.removed.length > 0; },
        reset: () => { sel = new Set(start); stash = start.filter((s) => s !== '*'); sync(); onChange(); },
    };
}

// PATCH the key. Asks first when the change gives it every scope. Resolves with the updated key, or null when the
// person backs out. Errors are thrown for the caller to show.
export async function saveKey(ctx, k, { name, scopes }) {
    const body = {};
    if (name !== undefined && name !== k.name) body.name = name;
    if (scopes !== undefined) {
        const { added, removed } = diffScopes(k.scopes, scopes);
        if (added.length || removed.length) body.scopes = scopes;
        if (added.includes('*')) {
            const ok = await confirmDialog({
                title: `Give ${k.name} access to everything?`,
                body: ['"All access" lets this key use every domain and every action, including ones added later, and change data.',
                    'Keep it for your own tools. Agents are safer with only what they need.'],
                confirm: 'Give all access',
                danger: true,
            });
            if (!ok) return null;
            body.confirm_all = true;
        }
    }
    if (!Object.keys(body).length) return k;
    return ctx.api(`/keys/${k.id}`, { method: 'PATCH', body });
}

// Save and Cancel with a live diff line; shared by the drawer form and the domain popover.
export function saveBar({ editor, onSave, onCancel, saveText = 'Save changes', extraDirty = () => false, extraDiff = () => '' }) {
    const diff = h('p', { class: 'diff-line', role: 'status', 'aria-live': 'polite' });
    const error = h('p', { class: 'error', role: 'alert' });
    const save = button({ text: saveText, type: 'submit' });
    const cancel = button({ text: 'Cancel', variant: 'quiet', onClick: onCancel });
    const refresh = () => {
        const { added, removed } = editor.diff();
        const empty = editor.get().length === 0;
        const dirty = added.length > 0 || removed.length > 0 || extraDirty();
        const text = [extraDiff(), diffSentence(added, removed)].filter(Boolean).join(' ');
        diff.textContent = empty ? 'Pick at least one thing the key may do.' : (dirty ? text : 'No changes yet.');
        diff.classList.toggle('is-empty', !dirty && !empty);
        diff.classList.toggle('is-bad', empty);
        save.disabled = empty || !dirty;
        error.textContent = '';
    };
    refresh();
    return { el: h('div', { class: 'save-bar' }, diff, error, h('div', { class: 'row' }, save, cancel)), refresh, error, save, setBusy: (b) => { save.disabled = b; } };
}

