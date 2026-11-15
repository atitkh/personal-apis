// MCP tool for links between records of any two domains. Agents may read a record's links (related) and, in write mode
// with links:agent-write, add one (link) or take one away (unlink). A key only sees and makes links between domains it
// can read itself; links to other domains are only counted. Taking a link away never touches the records.
const links = require('../../links');
const briefing = require('../../briefing');
const { ToolError } = require('../util');

const domainNames = () => links.linkable().join(', ');

module.exports = {
    domain: 'links',
    readScope: 'links:read',
    // Titles come from records written by people and agents, so results are marked as data.
    untrusted: true,
    description: 'Links between records: a preference for a trip, a deadline for a flight, a lifelog episode during a trip. '
        + `A record is { domain, id } (${domainNames()}); a digest id is kind/period such as daily/2026-11-10. `
        + 'You only see and make links between domains you can read.',
    actions: {
        related: { scope: 'links:read', describe: 'related: the links of one record (domain, id), each with the other record\'s title; hidden counts links to domains you cannot read' },
        link: { scope: 'links:agent-write', write: true, describe: 'link: connect two records (domain, id, to_domain, to_id; optional rel such as for, about, during; optional note up to 200 characters)' },
        unlink: { scope: 'links:agent-write', write: true, describe: 'unlink: take one link away (link_id from related). The two records stay' },
    },

    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        if (has('related', 'link')) {
            shape.domain = z.string().max(20).optional().describe('related/link: the record\'s domain');
            shape.id = z.union([z.number().int().positive(), z.string().max(40)]).optional().describe('related/link: the record\'s id');
        }
        if (has('link')) {
            shape.to_domain = z.string().max(20).optional().describe('link: the other record\'s domain');
            shape.to_id = z.union([z.number().int().positive(), z.string().max(40)]).optional().describe('link: the other record\'s id');
            shape.rel = z.string().max(30).optional().describe('link: a short lowercase word (for, about, during, related)');
            shape.note = z.string().max(200).nullable().optional().describe('link: optional note');
        }
        if (has('unlink')) shape.link_id = z.number().int().positive().optional().describe('unlink: the link id');
        return shape;
    },

    run(action, args, { db, key }) {
        const visible = briefing.visibleDomainsFor(db, key);
        const need = (v, what) => { if (v == null || v === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`); return v; };
        switch (action) {
        case 'related':
            return links.listFor(db, need(args.domain, 'domain'), need(args.id, 'id'), { visible });
        case 'link': {
            const r = links.add(db, { from: { domain: need(args.domain, 'domain'), id: need(args.id, 'id') }, to: { domain: need(args.to_domain, 'to_domain'), id: need(args.to_id, 'to_id') }, rel: args.rel, note: args.note }, key.name, { visible });
            return r;
        }
        case 'unlink':
            return links.remove(db, need(args.link_id, 'link_id'), { visible });
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
