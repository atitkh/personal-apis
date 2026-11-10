// Activity: the audit log, newest first, with a filter that lives in the URL (#/activity?type=agents).
// Ported from the old app; stage 2 adds day grouping and chips.
import { h, when, emptyState } from '../ui.js';
import { href } from '../router.js';
import { MCP_LABEL } from './overview.js';

const callName = (tool, action) => `${tool || 'unknown tool'}${action ? `.${action}` : ''}`;

const WHAT = {
    domain_enabled: (d) => `Turned on ${d && d.name ? d.name : 'a domain'}`,
    domain_disabled: (d) => `Turned off ${d && d.name ? d.name : 'a domain'}`,
    digest_edited: (d) => `Edited the ${d ? `${d.kind} digest for ${d.period}` : 'digest'}`,
    digest_restored: (d) => `Restored an older version of the ${d ? `${d.kind} digest for ${d.period}` : 'digest'}`,
    login: () => 'Signed in',
    logout: () => 'Signed out',
    login_failed: () => 'Tried a wrong key',
    key_created: (d) => `Created key ${d && d.name ? d.name : ''}${d && d.scopes ? ` (${d.scopes.join(', ')})` : ''}`,
    key_revoked: (d) => `Revoked key ${d && d.name ? d.name : ''}`,
    backup_run: () => 'Made a backup by hand',
    mcp_call: (d) => (d ? `Agent ${d.key} called ${callName(d.tool, d.action)}${d.ok ? '' : ' (failed)'}` : 'Agent call'),
    domain_mcp_changed: (d) => `Set agent access for ${d && d.name ? d.name : 'a domain'} to ${d && MCP_LABEL[d.to] ? MCP_LABEL[d.to] : 'an unknown mode'}`,
};

const GROUPS = [
    ['all', 'Everything', null],
    ['signins', 'Sign-ins', ['login', 'logout', 'login_failed']],
    ['keys', 'Keys', ['key_created', 'key_revoked']],
    ['domains', 'Domains', ['domain_enabled', 'domain_disabled']],
    ['digests', 'Digests', ['digest_edited', 'digest_restored']],
    ['backups', 'Backups', ['backup_run']],
    ['agents', 'Agents', ['mcp_call', 'domain_mcp_changed']],
];

export async function render(ctx) {
    const { events: all } = await ctx.api('/activity?limit=200');
    const type = ctx.route.query.get('type') || 'all';
    const group = GROUPS.find((g) => g[0] === type) || GROUPS[0];
    const events = group[2] ? all.filter((e) => group[2].includes(e.action)) : all;
    return h('div', { class: 'legacy' },
        h('p', { class: 'lede', text: 'Sign-ins, key and domain changes, digest edits, backups and agent calls, newest first.' }),
        h('section', {},
            h('nav', { class: 'row', 'aria-label': 'Filter activity' }, GROUPS.map(([id, label]) => h('a', {
                class: `btn small ${group[0] === id ? '' : 'quiet'}`,
                href: href('activity', [], { type: id === 'all' ? null : id }),
                'aria-current': group[0] === id ? 'true' : null,
                text: label,
            }))),
            events.length
                ? h('div', { class: 'table-wrap' }, h('table', {},
                    h('thead', {}, h('tr', {}, ['When', 'What', 'From'].map((t) => h('th', { text: t })))),
                    h('tbody', {}, events.map((e) => h('tr', {},
                        h('td', { text: when(e.at) }),
                        h('td', { text: (WHAT[e.action] || (() => e.action))(e.detail).trim() }),
                        h('td', { class: 'muted', text: e.ip || '' }))))))
                : emptyState({ title: all.length ? 'Nothing of that kind in the recent events.' : 'Nothing has happened yet.', text: all.length ? 'Pick Everything to see all recent events.' : null })));
}
