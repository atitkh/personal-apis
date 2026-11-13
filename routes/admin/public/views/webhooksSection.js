// Settings > Webhooks: where the hub pushes briefing changes (new, more urgent, resolved). The address and secret are
// credentials: the list shows only the host, and the edit form leaves the secret blank to keep it.
import { h, button, toast, when, ago, confirmDialog, formDialog, plural, hidden } from '../ui.js';

const SEVERITY = [['attention', 'Needs attention or urgent'], ['urgent', 'Urgent only'], ['info', 'Everything, also what is coming up']];
const AUTH = [['bearer', 'Bearer token (Axis, n8n, ntfy)'], ['hmac', 'Signed body, X-Hub-Signature-256 (Gitea style)'], ['none', 'No authentication']];

function field(id, label, input, help) {
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('p', { class: 'note', text: help }) : null);
}
const select = (id, name, options, value) => h('select', { id, name }, options.map(([v, t]) => h('option', { value: v, text: t, ...(v === value ? { selected: 'selected' } : {}) })));
const checkbox = (id, name, label, checked) => {
    const input = h('input', { type: 'checkbox', id, name });
    input.checked = Boolean(checked);
    return h('div', { class: 'check-field' }, h('label', { class: 'check', for: id }, input, h('span', { text: label })));
};

function statusLine(w) {
    const bits = [];
    if (!w.enabled) bits.push('Off');
    else if (w.last_status === 'failing') bits.push(`Failing: ${w.last_error || 'no answer'}`);
    else if (w.last_status === 'ok') bits.push(`Last delivery ${ago(w.last_at)}`);
    else bits.push('Nothing sent yet');
    if (w.pending) bits.push(`${plural(w.pending, 'message')} waiting`);
    if (w.failed) bits.push(`${w.failed} failed`);
    if (w.sent_24h) bits.push(`${w.sent_24h} sent in the last day`);
    return bits.join(' · ');
}

function form(ctx, existing) {
    const w = existing || {};
    const fields = [
        field('wh-name', 'Name', h('input', { type: 'text', id: 'wh-name', name: 'name', value: w.name || '', maxlength: '60', autocomplete: 'off' })),
        field('wh-url', 'Address', h('input', { type: 'text', id: 'wh-url', name: 'url', value: '', placeholder: w.host ? `${w.host}/… (leave empty to keep the saved address)` : 'http://10.0.0.5:8440/v1/hook/personal-hub', autocomplete: 'off', spellcheck: 'false' }),
            'Private network addresses are fine. The address can hold a token, so it is never shown again after saving.'),
        field('wh-auth', 'Authentication', select('wh-auth', 'auth_mode', AUTH, w.auth_mode || 'bearer')),
        field('wh-secret', 'Secret', h('input', { type: 'password', id: 'wh-secret', name: 'secret', value: '', autocomplete: 'off', placeholder: w.has_secret ? 'Saved. Type to replace it.' : '' }),
            'The bearer token, or the shared secret used to sign the body.'),
        field('wh-sev', 'Send', select('wh-sev', 'min_severity', SEVERITY, w.min_severity || 'attention')),
        field('wh-dom', 'Only these domains', h('input', { type: 'text', id: 'wh-dom', name: 'domains', value: (w.domains || []).join(', '), placeholder: 'all domains', autocomplete: 'off', spellcheck: 'false' }),
            'Comma separated, for example deadlines, flights. Empty means all.'),
        checkbox('wh-res', 'send_resolved', 'Also send a message when an item is resolved', w.send_resolved),
    ];
    if (!existing) {
        fields.push(field('wh-start', 'First check', select('wh-start', 'start', [['now', 'Start from now: record what exists, send only changes'], ['send', 'Send everything that exists once']], 'now')));
    } else {
        fields.push(checkbox('wh-on', 'enabled', 'On', w.enabled));
    }
    return fields;
}

function read(f, existing) {
    const body = {
        name: f.elements.namedItem('name').value.trim(),
        auth_mode: f.elements.namedItem('auth_mode').value,
        min_severity: f.elements.namedItem('min_severity').value,
        domains: f.elements.namedItem('domains').value.split(',').map((s) => s.trim()).filter(Boolean),
        send_resolved: f.elements.namedItem('send_resolved').checked,
    };
    const url = f.elements.namedItem('url').value.trim();
    const secret = f.elements.namedItem('secret').value;
    if (url || !existing) body.url = url;
    if (secret || !existing) body.secret = secret || null;
    if (existing) body.enabled = f.elements.namedItem('enabled').checked;
    else body.start = f.elements.namedItem('start').value;
    return body;
}

export function webhooksSection(rawCtx, data) {
    const hooks = data.webhooks;
    // the dialog marks the field a 400 names, so it needs the field on the error
    const ctx = { ...rawCtx, api: async (path, opts) => { try { return await rawCtx.api(path, opts); } catch (e) { if (e.data && e.data.field) e.field = e.data.field; throw e; } } };

    const add = async () => {
        const saved = await formDialog({
            title: 'Add a webhook',
            intro: 'The hub tells this address when something in the briefing appears, becomes more urgent or is resolved. It checks every few minutes and shortly after any change.',
            fields: form(ctx, null),
            submit: 'Add webhook',
            onSubmit: (f) => ctx.api('/webhooks', { method: 'POST', body: read(f, null) }),
        });
        if (saved) { toast('Webhook added'); ctx.rerender(); }
    };

    const edit = async (w) => {
        const saved = await formDialog({
            title: `Edit ${w.name}`,
            fields: form(ctx, w),
            submit: 'Save',
            onSubmit: (f) => ctx.api(`/webhooks/${w.id}`, { method: 'PUT', body: read(f, w) }),
        });
        if (saved) { toast('Webhook saved'); ctx.rerender(); }
    };

    const act = async (btn, fn, done) => {
        btn.disabled = true;
        try { await fn(); if (done) toast(done); ctx.rerender(); } catch (e) { toast(e.message, { kind: 'bad' }); } finally { btn.disabled = false; }
    };

    const row = (w) => {
        const test = button({ text: 'Send test', variant: 'quiet', 'data-key': `webhook-test-${w.id}` });
        test.addEventListener('click', () => act(test, async () => {
            const r = await ctx.api(`/webhooks/${w.id}/test`, { method: 'POST', body: {} });
            if (!r.ok) throw new Error(r.error || `The receiver answered ${r.status}`);
        }, 'Test sent'));
        const run = button({ text: 'Check now', variant: 'quiet', 'data-key': `webhook-run-${w.id}` });
        run.addEventListener('click', () => act(run, async () => {
            const r = await ctx.api(`/webhooks/${w.id}/run`, { method: 'POST', body: { retry_failed: true } });
            toast(r.checked.baseline ? `Recorded ${plural(r.checked.baseline, 'item')} as the starting point` : `${r.delivered.sent} sent, ${r.checked.new + r.checked.escalated + r.checked.resolved} change${r.checked.new + r.checked.escalated + r.checked.resolved === 1 ? '' : 's'} found`);
        }));
        const editBtn = button({ text: 'Edit', variant: 'quiet', onClick: () => edit(w), 'data-key': `webhook-edit-${w.id}` });
        const del = button({ text: 'Delete', variant: 'quiet', 'data-key': `webhook-delete-${w.id}` });
        del.addEventListener('click', async () => {
            const ok = await confirmDialog({ title: `Delete ${w.name}?`, body: 'It stops sending, and its history here is removed. Messages already delivered stay where they arrived.', confirm: 'Delete', danger: true });
            if (ok) act(del, () => ctx.api(`/webhooks/${w.id}`, { method: 'DELETE', body: { confirm: true } }), 'Webhook deleted');
        });
        return h('li', { class: 'setting-row webhook-row' },
            h('div', {},
                h('strong', { text: w.name }), ' ', h('span', { class: 'note', text: w.host }),
                h('p', { class: `note${w.last_status === 'failing' && w.enabled ? ' error' : ''}`, text: statusLine(w) }),
                h('p', { class: 'note', text: `${SEVERITY.find((s) => s[0] === w.min_severity)[1]}${w.domains ? `, only ${w.domains.join(', ')}` : ''}${w.send_resolved ? ', with resolved messages' : ''}. Added ${when(w.created_at)}.` })),
            h('div', { class: 'form-actions' }, test, run, editBtn, del));
    };

    return h('section', { class: 'panel settings-form', 'aria-labelledby': 's-wh' },
        h('h2', { id: 's-wh', text: 'Webhooks' }),
        h('p', { class: 'note', text: 'Push the briefing\'s changes to another system, such as the VorteX Axis inbox. Each message says what changed and carries no booking references, addresses or document numbers. Setting these up is for people at this dashboard only: agents cannot see or change them.' }),
        hooks.length ? h('ul', { class: 'webhook-list' }, hooks.map(row)) : h('p', { class: 'note', text: 'No webhooks yet.' }),
        h('div', { class: 'form-actions' }, button({ text: 'Add webhook', iconName: 'plus', onClick: add, 'data-key': 'webhook-add' })),
        hidden('Webhooks'));
}
