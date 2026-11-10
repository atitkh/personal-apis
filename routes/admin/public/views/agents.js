// Agent access: the MCP endpoint, its tools, what each key sees now and recent calls.
// Ported from the old app; stage 2 redoes it.
import { h, plural, when, ago, dot, emptyState } from '../ui.js';
import { href } from '../router.js';

const callName = (tool, action) => `${tool || 'unknown tool'}${action ? `.${action}` : ''}`;

export async function render(ctx) {
    const a = await ctx.api('/agents');
    const active = a.keys.filter((k) => !k.revoked);
    const revoked = a.keys.length - active.length;
    const domainTools = a.tools.filter((t) => !t.alwaysOn);

    const toolRows = a.tools.map((t) => h('tr', {},
        h('td', {}, h('code', { text: t.tool })),
        h('td', { text: t.alwaysOn ? 'Every key' : (t.title || t.domain) }),
        h('td', {}, t.alwaysOn
            ? h('span', { class: 'muted', text: 'Lists what the key can reach and a short brief.' })
            : t.actions.map((x, i) => [i ? ', ' : '', x.name, x.write ? h('span', { class: 'muted', text: ` (changes data, needs ${x.scope})` }) : null]))));

    const keyRows = active.map((k) => {
        const sees = k.visibleTools.length
            ? k.visibleTools.map((t) => h('div', { text: `${t.tool}: ${t.actions.join(', ')}` }))
            : h('span', { class: 'muted', text: 'Nothing: its scopes or the domain settings hide every tool' });
        return h('tr', {},
            h('td', {}, h('a', { class: 'link', href: href('keys', [String(k.id)]), text: k.name })),
            h('td', {}, h('span', { class: 'scopes', text: k.scopes.join(', ') })),
            h('td', {}, k.canWrite ? h('div', { class: 'warn-text' }, dot('warn'), 'Can change data') : null, sees),
            h('td', { class: 'num', text: String(k.calls30d) }),
            h('td', { text: k.lastCallAt ? ago(k.lastCallAt) : 'Never' }));
    });

    const callRows = a.recent.map((c) => h('tr', {},
        h('td', { text: when(c.at) }),
        h('td', { text: c.key }),
        h('td', {}, h('code', { text: callName(c.tool, c.action) })),
        h('td', {}, dot(c.ok ? 'good' : 'bad'), c.ok ? 'OK' : 'Failed')));

    return h('div', { class: 'legacy' },
        h('p', { class: 'lede', text: "Agents reach the hub through one MCP endpoint. What a key sees depends on its scopes, whether the domain is on, and the domain's agent access on the Overview." }),
        h('section', {},
            h('h2', { text: 'Endpoint' }),
            h('p', {}, h('code', { class: 'endpoint', text: `${location.origin}${a.endpoint}` })),
            h('p', { class: 'note', text: 'Send a hub API key as Authorization: Bearer <key>. Create keys on the API keys page.' })),
        h('section', {},
            h('h2', { text: 'Tools' }),
            domainTools.length ? null : h('p', { class: 'muted', text: 'No domain has an agent tool yet, so agents only get the overview.' }),
            h('div', { class: 'table-wrap' }, h('table', {},
                h('thead', {}, h('tr', {}, ['Tool', 'Domain', 'Actions'].map((t) => h('th', { text: t })))),
                h('tbody', {}, toolRows)))),
        h('section', {},
            h('h2', { text: 'Keys' }),
            h('p', { class: 'note', text: `Worked out now from each key's scopes and the domain settings.${revoked ? ` ${plural(revoked, 'revoked key')} not shown.` : ''}` }),
            active.length
                ? h('div', { class: 'table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {}, [['Name'], ['Scopes'], ['Sees now'], ['Calls, 30 days', 'num'], ['Last call']].map(([t, c]) => h('th', { class: c || null, text: t })))),
                    h('tbody', {}, keyRows)))
                : emptyState({ title: 'No active keys.', text: 'Create one on the API keys page.', action: h('a', { class: 'btn quiet small', href: href('keys', [], { new: '1' }), text: 'Create key' }) })),
        h('section', {},
            h('h2', { text: 'Recent calls' }),
            a.recent.length
                ? h('div', { class: 'table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {}, ['When', 'Key', 'Call', 'Result'].map((t) => h('th', { text: t })))),
                    h('tbody', {}, callRows)))
                : emptyState({ title: 'No agent has called the hub yet.', text: 'Calls show up here as soon as a key uses the endpoint.' })));
}
