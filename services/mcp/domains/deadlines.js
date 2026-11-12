// MCP tool for the deadlines domain. Reuses services/deadlines.js, so validation, roll-forward and revisions behave
// exactly as through /hub/deadlines. Agents may read (list, get, upcoming) and, in write mode with deadlines:agent-write,
// add, edit, done and end. Restoring an older version stays with a person (admin API and REST).
// reference (a document or policy number): left out of every answer; has_reference says one is stored. `get`
// includes it only when the key has deadlines:read (the tool's read scope, checked by the registry) and passes
// include_reference=true. Lists, upcoming and the results of writes never carry it. The audit row (mcp_call) never
// holds arguments or results.
const deadlines = require('../../deadlines');
const { ToolError, clip } = require('../util');

const LIST_MAX = 50;
const NOTES_CHARS = 300;
const EDIT_FIELDS = ['title', 'kind', 'due_date', 'due_time', 'repeat_kind', 'repeat_n', 'lead_days', 'urgent_days', 'status', 'reference',
    'issuer', 'amount_cents', 'currency', 'cycle', 'auto_renew', 'cancel_by', 'trip_id', 'notes'];

function need(value, what, action) {
    if (value == null || value === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`);
    return value;
}

// An item for an agent: no reference (has_reference instead) unless asked for, notes cut in lists.
function item(d, { notesMax = NOTES_CHARS, withRef = false } = {}) {
    const { reference: ref, created_at: _c, updated_by: _u, ...out } = d;
    if (withRef) out.reference = ref;
    else if (ref || d.has_reference) out.has_reference = true;
    if (notesMax) {
        const n = clip(out.notes, notesMax);
        out.notes = n.text;
        if (n.truncated) out.notesTruncated = true;
    }
    return out;
}

const pick = (args, names) => Object.fromEntries(names.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

module.exports = {
    domain: 'deadlines',
    readScope: 'deadlines:read',
    // Titles and notes are free text written by people and agents, so results are marked as data.
    untrusted: true,
    description: "Atit's deadlines: dates he must not miss (documents, insurance, licences, subscriptions, memberships, bills and casual tasks). "
        + 'Dates are LOCAL dates (YYYY-MM-DD, no time zone; "today" is Chicago time); due_time is an optional HH:MM. '
        + 'Each item has its own windows: window is urgent (overdue, or days_left <= urgent_days), attention (days_left <= lead_days) or later; days_left is negative when overdue. '
        + 'A repeating item (repeat_kind yearly, monthly or every_n_months with repeat_n) rolls to its next due date when marked done and stays active; a one-off becomes done; end stops reminders. '
        + 'Money fields (amount_cents in cents, currency, cycle, auto_renew, cancel_by) are only for subscription, membership and bill, and are a schedule, not payments. '
        + 'Reference numbers are left out (has_reference says one is stored).',
    actions: {
        list: { scope: 'deadlines:read', describe: `list: items soonest first (default status active; optional kind, status (active, done, ended, all), due_before, due_after (inclusive dates), overdue=true, q (part of the title); limit 1-${LIST_MAX}, offset)` },
        get: { scope: 'deadlines:read', describe: 'get: one item (id); include_reference=true adds its reference number' },
        upcoming: { scope: 'deadlines:read', describe: `upcoming: active items that are overdue or due within days (default 60, 1-730), soonest first, with days_left and window (limit 1-${LIST_MAX})` },
        add: { scope: 'deadlines:agent-write', write: true, describe: 'add: file an item (title and due_date required; optional kind, due_time, repeat_kind, repeat_n, lead_days (default 14), urgent_days (default 3, at most lead_days), reference, issuer, amount_cents, currency, cycle, auto_renew, cancel_by, trip_id, notes)' },
        edit: { scope: 'deadlines:agent-write', write: true, describe: 'edit: change one item (id; only the fields sent change, null clears; status active reopens an ended item; optional note = why)' },
        done: { scope: 'deadlines:agent-write', write: true, describe: 'done: mark one item done (id). A repeating item moves to its next due date and stays active; a one-off becomes done' },
        end: { scope: 'deadlines:agent-write', write: true, describe: 'end: stop reminders for one item (id), for example a cancelled subscription. Nothing is deleted' },
    },

    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        const text = (n) => z.string().max(n);
        if (has('list', 'upcoming')) shape.limit = z.number().int().min(1).max(LIST_MAX).optional().describe('list/upcoming: how many');
        if (has('list')) {
            shape.offset = z.number().int().min(0).optional().describe('list: skip this many');
            shape.due_before = text(10).optional().describe('list: due on or before this date');
            shape.due_after = text(10).optional().describe('list: due on or after this date');
            shape.overdue = z.boolean().optional().describe('list: true for active items past their due date');
            shape.q = text(80).optional().describe('list: part of the title');
        }
        if (has('upcoming')) shape.days = z.number().int().min(1).max(730).optional().describe('upcoming: how many days ahead (default 60)');
        if (has('get', 'edit', 'done', 'end')) shape.id = z.number().int().positive().optional().describe('get/edit/done/end: the item id');
        if (has('get')) shape.include_reference = z.boolean().optional().describe('get: true to include the reference number');
        if (has('list', 'add', 'edit')) shape.kind = text(20).optional().describe('document, insurance, license, subscription, membership, bill, task or other');
        if (has('add', 'edit')) {
            shape.title = text(120).optional().describe('what is due, 1-120 characters');
            shape.due_date = text(10).optional().describe('the local due date, like 2027-03-01');
            shape.due_time = text(5).nullable().optional().describe('optional time, like 14:30');
            shape.repeat_kind = text(20).optional().describe('none (default), yearly, monthly or every_n_months');
            shape.repeat_n = z.number().int().min(1).max(600).nullable().optional().describe('months, only with every_n_months');
            shape.lead_days = z.number().int().min(0).max(730).optional().describe('attention starts this many days before the due date (default 14)');
            shape.urgent_days = z.number().int().min(0).max(730).optional().describe('urgent starts this many days before (default 3, at most lead_days)');
            shape.reference = text(120).nullable().optional().describe('document or policy number (stored privately)');
            shape.issuer = text(120).nullable().optional().describe('who issued or charges it');
            shape.amount_cents = z.number().int().min(0).nullable().optional().describe('subscription, membership, bill only: amount in cents');
            shape.currency = text(3).nullable().optional().describe('3-letter code, like USD (needed with amount_cents)');
            shape.cycle = text(10).nullable().optional().describe('weekly, monthly, quarterly or yearly');
            shape.auto_renew = z.boolean().nullable().optional().describe('renews by itself');
            shape.cancel_by = text(10).nullable().optional().describe('last day to cancel, a local date');
            shape.trip_id = z.number().int().positive().nullable().optional().describe('a flights trip this belongs to');
            shape.notes = z.string().max(2000).nullable().optional();
        }
        if (has('list', 'edit')) shape.status = text(10).optional().describe('list: active (default), done, ended or all; edit: only active, to reopen an ended item');
        if (has('edit')) {
            shape.note = z.string().max(200).optional().describe('edit: why it changed');
        }
        return shape;
    },

    run(action, args, { db, key }) {
        switch (action) {
        case 'list': {
            const r = deadlines.list(db, {
                kind: args.kind, status: args.status, due_before: args.due_before, due_after: args.due_after, overdue: args.overdue,
                q: args.q, limit: args.limit || LIST_MAX, offset: args.offset,
            });
            return { count: r.deadlines.length, total: r.total, offset: r.offset, deadlines: r.deadlines.map((d) => item(d)) };
        }
        case 'get': {
            const d = deadlines.get(db, need(args.id, 'an id', action), { reference: args.include_reference === true });
            return item(d, { notesMax: 0, withRef: args.include_reference === true });
        }
        case 'upcoming':
            return { deadlines: deadlines.upcoming(db, { days: args.days || 60, limit: args.limit || LIST_MAX }).map((d) => item(d)) };
        case 'add':
            return deadlines.create(db, pick(args, EDIT_FIELDS.filter((k) => k !== 'status')), key.name);
        case 'edit': {
            const id = need(args.id, 'an id', action);
            const fields = pick(args, [...EDIT_FIELDS, 'note']);
            if (!Object.keys(fields).some((k) => k !== 'note')) throw new ToolError('bad_request', 'The edit action needs at least one field to change.');
            if (fields.status !== undefined && fields.status !== 'active') throw new ToolError('bad_request', 'Edit can only set status to active; use the done and end actions otherwise.');
            return deadlines.update(db, id, fields, key.name);
        }
        case 'done':
            return deadlines.done(db, need(args.id, 'an id', action), key.name);
        case 'end':
            return deadlines.end(db, need(args.id, 'an id', action), key.name);
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
