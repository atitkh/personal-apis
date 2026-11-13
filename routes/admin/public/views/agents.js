// Agent access: per key and per domain what an agent can do right now (read, suggest, edit, publish) and why not,
// the latest MCP calls (tool.action, key, time, outcome; never content), and the endpoint itself.
// Every key name links to its drawer on the Keys page. Each key x domain cell is a button: it opens a drawer with
// just that domain's scopes to change (the PATCH leaves the key's other scopes alone).
import { h, icon, plural, when, ago, emptyState, copyButton, hidden, domainHue, openDrawer, confirmDialog, toast } from '../ui.js';
import { href } from '../router.js';
import { CATALOGUE } from '../scopes.js';
import { scopeEditor, saveKey, saveBar, APPLIES } from '../scopeEditor.js';
import { MCP_LABEL } from './overview.js';

const VERB = { read: 'Read', suggest: 'Suggest', observe: 'Observe', 'agent-write': 'Agent write', 'api-write': 'API write', publish: 'Publish' };
const verbLabel = (verb) => (VERB[verb] || verb).toLowerCase();
const verbOf = (scope) => scope.split(':')[1];
const hasScope = (granted, required) => {
    const domain = required.split(':')[0];
    return granted.some((g) => g === '*' || g === required || g === `${domain}:*`);
};
const callName = (c) => `${c.tool || 'unknown'}${c.action ? `.${c.action}` : ''}`;

// For one key and one domain tool: each verb the tool offers, whether the key has it now, and if not, why.
function access(key, tool, domain) {
    const seen = (key.visibleTools.find((v) => v.tool === tool.tool) || { actions: [] }).actions;
    const verbs = [];
    for (const a of tool.actions) {
        const verb = verbOf(a.scope);
        let entry = verbs.find((v) => v.verb === verb);
        if (!entry) { entry = { verb, scope: a.scope, write: a.write, yes: false }; verbs.push(entry); }
        if (seen.includes(a.name)) entry.yes = true;
    }
    for (const v of verbs) {
        if (v.yes) continue;
        if (!domain || !domain.enabled) v.why = 'the domain is off';
        else if (domain.mcpMode === 'off') v.why = 'agent access is off';
        else if (!hasScope(key.scopes, tool.readScope)) v.why = `the key has no ${tool.readScope}`;
        else if (!hasScope(key.scopes, v.scope)) v.why = `the key has no ${v.scope}`;
        else if (v.write && domain.mcpMode !== 'write') v.why = 'the domain allows reading only';
        else v.why = 'not offered';
    }
    return verbs;
}

function accessCell(verbs) {
    const yes = verbs.filter((v) => v.yes);
    const no = verbs.filter((v) => !v.yes);
    const reasons = [...new Set(no.map((v) => v.why))];
    return h('div', { class: 'access' },
        h('ul', { class: 'caps' }, verbs.map((v) => h('li', { class: `cap ${v.yes ? 'yes' : 'no'}${v.yes && v.write ? ' write' : ''}`, title: v.yes ? `Can ${verbLabel(v.verb)}` : `Cannot ${verbLabel(v.verb)}: ${v.why}` },
            icon(v.yes ? 'check' : 'close'), h('span', { text: VERB[v.verb] || v.verb }), hidden(v.yes ? ': yes' : `: no, ${v.why}`)))),
        !yes.length && reasons.length ? h('p', { class: 'access-why', 'aria-hidden': 'true', text: `No access: ${reasons[0]}.` }) : null);
}

// What the domain's agent access means for this key, in plain words.
function modeContext(d) {
    if (!d || !d.enabled) return 'Domain is off: agents see nothing here until you switch it on on the Overview board.';
    if (d.mcpMode === 'off') return 'Domain mode: Off: agents cannot use this domain until you allow agent access on the Overview board.';
    if (d.mcpMode === 'read') return 'Domain mode: Read: write actions stay hidden until you switch the domain to Read and write on the Overview board.';
    return 'Domain mode: Read and write: a key with the matching scopes can change data here.';
}

// A drawer for one key and one domain. Saves through the same PATCH as the Keys page.
function openCell(ctx, k, t, d) {
    const title = t.title || t.domain;
    const hasDomain = CATALOGUE.some((x) => x.domain === t.domain);
    const star = k.scopes.includes('*');
    const guard = { dirty: () => false };
    const intro = h('p', { class: 'note mode-context', text: modeContext(d) });
    const overview = h('a', { class: 'link', href: href('overview'), text: 'Open the Overview board' });
    const keyLink = h('a', { class: 'link', href: href('keys', [String(k.id)]), text: `Open ${k.name} on the Keys page` });
    let body;
    if (star || !hasDomain) {
        body = [intro, h('p', { class: 'note', text: star
            ? 'This key has all access (*), so it can use every domain. To narrow it, edit the key on the Keys page.'
            : `${title} has no scopes to pick here. Edit the key on the Keys page.` }), h('p', {}, keyLink)];
    } else {
        const editor = scopeEditor({ initial: k.scopes, only: t.domain, prefix: `ac-${k.id}`, onChange: () => bar.refresh() });
        const bar = saveBar({ editor, onCancel: () => handle.close() });
        guard.dirty = () => editor.dirty();
        body = [intro, h('p', {}, overview),
            h('p', { class: 'note', text: `${APPLIES} Only ${title} scopes change here; the key's other scopes stay as they are.` }),
            h('form', {
                class: 'access-form',
                novalidate: true,
                onsubmit: async (event) => {
                    event.preventDefault();
                    bar.save.disabled = true;
                    try {
                        const updated = await saveKey(ctx, k, { scopes: editor.get() });
                        if (!updated) { bar.refresh(); return; }
                        toast(`Saved ${updated.name}. It applies on the key's next call.`);
                        guard.dirty = () => false;
                        handle.close(true);
                        ctx.rerender();
                    } catch (err) {
                        bar.refresh();
                        bar.error.textContent = `Could not save. ${err.message}`;
                        toast(`Could not save the key. ${err.message}`, { kind: 'bad' });
                    }
                },
            }, editor.el, bar.el)];
    }
    const handle = openDrawer({
        title: `${k.name}: ${title}`,
        subtitle: 'What this key may do in this domain',
        content: h('div', { class: 'cell-editor' }, body),
        beforeClose: async () => !guard.dirty() || confirmDialog({
            title: 'Discard your changes?',
            body: `${k.name} has unsaved changes to its ${title} access.`,
            confirm: 'Discard changes',
            cancel: 'Keep editing',
            danger: true,
        }),
        returnFocus: () => document.querySelector(`[data-cell="${k.id}:${t.tool}"]`),
    });
}

// Which of the two general tools a key has (they have scopes of their own: overview:read, briefing:read).
const generalWords = (k) => {
    const has = new Set(k.general || []);
    return has.size === 2 ? 'Both' : has.has('hub_overview') ? 'Overview only' : has.has('hub_briefing') ? 'Briefing only' : 'Neither';
};

export async function render(ctx) {
    const [a, { domains }] = await Promise.all([ctx.api('/agents'), ctx.api('/domains')]);
    const active = a.keys.filter((k) => !k.revoked);
    const revokedCount = a.keys.length - active.length;
    const tools = a.tools.filter((t) => !t.alwaysOn && !t.general);
    const domainOf = (name) => domains.find((d) => d.name === name);
    const idByName = new Map(active.map((k) => [k.name, k.id]));
    const keyLink = (name) => (idByName.has(name)
        ? h('a', { class: 'link', href: href('keys', [String(idByName.get(name))]), text: name })
        : h('span', { text: name }));

    const matrix = active.length && tools.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'stack access-table' },
            h('thead', {}, h('tr', {},
                h('th', { scope: 'col', text: 'Key' }),
                tools.map((t, i) => {
                    const d = domainOf(t.domain);
                    const state = !d || !d.enabled ? 'Off' : MCP_LABEL[d.mcpMode] || d.mcpMode;
                    return h('th', { scope: 'col' },
                        h('span', { class: `th-domain hue-${domainHue(t.domain, i)}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), t.title || t.domain),
                        h('span', { class: 'th-sub', text: `Domain: ${state.toLowerCase()}` }));
                }),
                h('th', { scope: 'col' }, h('span', { class: 'th-domain' }, 'Overview and briefing'), h('span', { class: 'th-sub', text: 'Set in Keys' })),
                h('th', { scope: 'col', class: 'num', text: 'Calls, 30 days' }),
                h('th', { scope: 'col', text: 'Last call' }))),
            h('tbody', {}, active.map((k) => h('tr', {},
                h('th', { scope: 'row', class: 'cell-main' }, h('a', { class: 'row-link', href: href('keys', [String(k.id)]), 'data-key': `ak:${k.id}` }, k.name)),
                tools.map((t) => {
                    const verbs = access(k, t, domainOf(t.domain));
                    const can = verbs.filter((v) => v.yes).map((v) => VERB[v.verb] || v.verb);
                    return h('td', { 'data-label': t.title || t.domain },
                        h('button', {
                            type: 'button',
                            class: 'access-btn',
                            'data-cell': `${k.id}:${t.tool}`,
                            'aria-haspopup': 'dialog',
                            'aria-label': `${k.name}, ${t.title || t.domain}: ${can.length ? `can ${can.join(', ').toLowerCase()}` : 'no access now'}. Change access`,
                            onclick: () => openCell(ctx, k, t, domainOf(t.domain)),
                        }, accessCell(verbs), h('span', { class: 'access-edit', 'aria-hidden': 'true' }, icon('edit'))));
                }),
                h('td', { 'data-label': 'Overview and briefing', 'data-general': String(k.id), text: generalWords(k) }),
                h('td', { class: 'num', 'data-label': 'Calls, 30 days', text: k.calls30d.toLocaleString() }),
                h('td', { 'data-label': 'Last call', text: k.lastCallAt ? ago(k.lastCallAt) : 'Never' }),
                h('td', { class: 'cell-side only-narrow' }, h('a', { class: 'btn ghost icon-only', href: href('keys', [String(k.id)]), tabindex: '-1', 'aria-hidden': 'true' }, icon('next'))))))))
        : emptyState({
            title: active.length ? 'No domain has an agent tool yet.' : 'No active keys.',
            text: active.length ? 'Agents only get the hub overview and briefing, if their keys allow it.' : 'Create a key for the agent first.',
            iconName: 'agents',
            action: active.length
                ? h('a', { class: 'btn quiet small', href: href('overview'), text: 'Open the channel board' })
                : h('a', { class: 'btn quiet small', href: href('keys', [], { new: '1' }), text: 'Create key' }),
        });

    const recent = a.recent.slice(0, 25);
    const calls = recent.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'stack calls-table' },
            h('thead', {}, h('tr', {}, ['When', 'Key', 'Call', 'Result'].map((t) => h('th', { scope: 'col', text: t })))),
            h('tbody', {}, recent.map((c) => h('tr', {},
                h('td', { 'data-label': 'When' }, h('time', { datetime: c.at, title: when(c.at), text: ago(c.at) })),
                h('td', { 'data-label': 'Key' }, keyLink(c.key)),
                h('td', { class: 'cell-main' }, h('code', { text: callName(c) })),
                h('td', { class: 'cell-side' }, h('span', { class: `call-result ${c.ok ? 'ok' : 'failed'}` }, icon(c.ok ? 'good' : 'bad'), c.ok ? 'OK' : 'Failed')))))))
        : emptyState({
            title: 'No agent has called the hub yet.',
            text: 'Calls show up here as soon as a key uses the endpoint below.',
            iconName: 'agents',
            action: h('a', { class: 'btn quiet small', href: '#ag-endpoint', onclick: (e) => { e.preventDefault(); const f = document.querySelector('.endpoint-panel input'); if (f) { f.focus(); f.scrollIntoView({ block: 'center' }); } }, text: 'Go to the endpoint' }),
        });

    const url = `${location.origin}${a.endpoint}`;
    const endpointField = h('input', { type: 'text', class: 'secret', readonly: true, value: url, 'aria-label': 'Agent endpoint URL', onfocus: (e) => e.target.select() });

    return h('div', { class: 'view agents' },
        h('p', { class: 'lede', text: "Agents reach the hub through one MCP endpoint. What a key can do depends on its scopes, whether the domain is on, and the domain's agent access on the overview. Select a cell to change what that key may do in that domain." }),
        h('section', { 'aria-labelledby': 'ag-matrix' },
            h('div', { class: 'section-head' },
                h('h2', { id: 'ag-matrix', class: 'section-title', text: 'What each key can do now' }),
                h('span', { class: 'section-links' },
                    h('a', { class: 'btn small', href: href('keys', [], { new: '1' }), 'data-key': 'new-key-shortcut' }, icon('plus'), h('span', { text: 'New key' })),
                    h('a', { class: 'link', href: href('overview'), text: 'Change domain access' }))),
            matrix,
            revokedCount ? h('p', { class: 'note', text: `${plural(revokedCount, 'revoked key')} not shown.` }) : null),
        h('section', { 'aria-labelledby': 'ag-calls' },
            h('div', { class: 'section-head' },
                h('h2', { id: 'ag-calls', class: 'section-title', text: 'Recent calls' }),
                h('a', { class: 'link', href: href('activity', [], { type: 'agents' }), text: 'All agent activity' })),
            h('p', { class: 'note', text: 'Which tool and action, by which key, and whether it worked. What was read or written is never logged.' }),
            calls),
        h('section', { class: 'panel endpoint-panel', 'aria-labelledby': 'ag-endpoint' },
            h('h2', { id: 'ag-endpoint', text: 'Endpoint' }),
            h('div', { class: 'copy-row' }, endpointField, copyButton({ value: url, field: endpointField, text: 'Copy', done: 'Copied', size: 'small', label: 'Copy the endpoint URL' })),
            h('p', { class: 'note' }, 'Send a hub API key as ', h('code', { text: 'Authorization: Bearer <key>' }), '. The tools ', h('code', { text: 'hub_overview' }), ' (what the key can reach) and ', h('code', { text: 'hub_briefing' }), ' (what needs attention) come with the scopes ', h('code', { text: 'overview:read' }), ' and ', h('code', { text: 'briefing:read' }), '.'),
            h('details', { class: 'tools-ref' },
                h('summary', {}, 'Tools and actions'),
                h('ul', {}, tools.map((t) => h('li', {},
                    h('code', { text: t.tool }), ` (${t.title}): `,
                    t.actions.map((x, i) => [i ? ', ' : '', h('code', { text: x.name }), x.write ? ` (changes data, needs ${x.scope})` : ''])))))));
}
