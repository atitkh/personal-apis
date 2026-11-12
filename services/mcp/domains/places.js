// MCP tool for the places domain. Reuses services/places.js, so validation, revisions and matching behave
// exactly as through /hub/places. Agents may read, resolve, file suggestions and (write mode, places:agent-write)
// add and edit places; deleting, restoring and working off the suggestions queue stay with a person.
// Rule values (streets, coordinates) are personal data: they are returned to a key with places:read, but
// resolve answers with the TYPE of the rule that matched, and the audit row never holds arguments.
const places = require('../../places');
const { ToolError, clip } = require('../util');

const LIST_MAX = 50;
const LIST_NOTES_CHARS = 300;

function need(value, what, action) {
    if (value == null || value === '') throw new ToolError('bad_request', `The ${action} action needs ${what}.`);
    return value;
}

// A rule without the fields that are empty for its type.
function rule(r) {
    const out = { id: r.id, type: r.type };
    if (r.value != null) out.value = r.value;
    if (r.type === 'radius') Object.assign(out, { lat: r.lat, lon: r.lon, radius_m: r.radius_m });
    if (r.exclude) out.exclude = true;
    if (r.priority) out.priority = r.priority;
    return out;
}

function place(p, notesMax) {
    const notes = notesMax ? clip(p.notes, notesMax) : { text: p.notes, truncated: false };
    const out = { id: p.id, label: p.label, kind: p.kind, notes: notes.text, rev: p.rev, rules: p.rules.map(rule) };
    if (notes.truncated) out.notesTruncated = true;
    return out;
}

// Label, kind, notes and how sure; the rule that matched is given by type only, never its street text.
function resolved(r) {
    if (!r.match) return { match: null };
    const out = { match: { id: r.match.id, label: r.match.label, kind: r.match.kind, notes: r.match.notes }, confidence: r.confidence, matched_rule_type: r.matched_rule.type };
    if (r.alternatives) out.alternatives = r.alternatives.map((a) => a.label);
    if (r.excluded) out.excluded = r.excluded.map((e) => e.label);
    return out;
}

const query = (args, suggest) => ({ geocode: args.geocode, lat: args.lat, lon: args.lon, zone: args.zone, suggest });

// edit: label/kind/notes, then rules to add, change and remove, all in one transaction (each step is its own
// revision, so any of them can be undone in the dashboard).
function edit(db, args, actor) {
    const id = need(args.id, 'an id', 'edit');
    const rules = { add: args.add_rules || [], update: args.update_rules || [], remove: args.remove_rule_ids || [] };
    const fields = {};
    for (const f of ['label', 'kind', 'notes', 'note']) if (args[f] !== undefined) fields[f] = args[f];
    const hasFields = ['label', 'kind', 'notes'].some((f) => fields[f] !== undefined);
    const steps = rules.add.length + rules.update.length + rules.remove.length;
    if (!hasFields && steps === 0) throw new ToolError('bad_request', 'The edit action needs label, kind, notes or rules to change.');

    return db.transaction(() => {
        const changes = [];
        let last = null;
        const keep = (what, r) => {
            last = r;
            if (r.status !== 'unchanged') changes.push(r.rule_id == null ? { what } : { what, rule_id: r.rule_id, rule_type: r.rule_type });
        };
        if (hasFields) keep('place', places.update(db, id, fields, actor));
        for (const r of rules.add) keep('rule_added', places.addRule(db, id, r, actor));
        for (const { id: ruleId, ...r } of rules.update) keep('rule_updated', places.updateRule(db, id, need(ruleId, 'an id for each rule to update', 'edit'), r, actor));
        for (const ruleId of rules.remove) keep('rule_removed', places.removeRule(db, id, ruleId, actor));
        return { status: changes.length ? 'updated' : 'unchanged', id: last.id, label: last.label, rev: last.rev, changes };
    })();
}

module.exports = {
    domain: 'places',
    readScope: 'places:read',
    // Labels and notes are typed by a person and may hold any words, so results are marked as data.
    untrusted: true,
    description: "Atit's places: spots he keeps returning to (home, campus, family, friends, stores, transit) and the rules that recognise a location as one of them (street text in a geocoded address, a Home Assistant zone, or a circle around lat/lon; an exclude rule says \"not this place\").",
    actions: {
        list: { scope: 'places:read', describe: `list: places with their rules, by label (optional kind, limit 1-${LIST_MAX})` },
        get: { scope: 'places:read', describe: 'get: one place with all its rules and notes (id)' },
        resolve: { scope: 'places:read', describe: 'resolve: which place a location is (geocode text and/or lat+lon and/or zone); returns label, kind, notes, confidence, the type of rule that matched and other candidates. Never files anything' },
        suggest: { scope: 'places:suggest', write: true, describe: 'suggest: resolve, and when no place matches file the street of the geocode in the "needs a name" queue for a person to name (same input as resolve)' },
        add: { scope: 'places:agent-write', write: true, describe: `add: create a place (label, kind one of ${places.KINDS.join('/')}, optional notes, rules)` },
        edit: { scope: 'places:agent-write', write: true, describe: 'edit: change one place (id; any of label, kind, notes, add_rules, update_rules [{id, fields to change}], remove_rule_ids; optional note = why). Every change is kept as a revision' },
    },

    // Fields for write actions are only offered to a key that can use them.
    input(z, actions) {
        const shape = {};
        const has = (...names) => names.some((n) => actions.includes(n));
        if (has('list', 'add', 'edit')) shape.kind = z.enum(places.KINDS).optional().describe('list: only this kind; add/edit: the kind');
        if (has('list')) shape.limit = z.number().int().min(1).max(LIST_MAX).optional().describe(`list: how many (default ${LIST_MAX})`);
        if (has('get', 'edit')) shape.id = z.number().int().positive().optional().describe('get/edit: the place id');
        if (has('resolve', 'suggest')) {
            shape.geocode = z.string().max(500).optional().describe('resolve/suggest: a geocoded address, like "12 Example Ave, Springfield"');
            shape.lat = z.number().min(-90).max(90).optional().describe('resolve/suggest: latitude, with lon');
            shape.lon = z.number().min(-180).max(180).optional().describe('resolve/suggest: longitude, with lat');
            shape.zone = z.string().max(120).optional().describe('resolve/suggest: a Home Assistant zone, like home or zone.home');
        }
        if (has('add', 'edit')) {
            const rule = {
                type: z.enum(places.RULE_TYPES),
                value: z.string().max(120).optional().describe('street text, or zone id; a caption for radius'),
                lat: z.number().optional(),
                lon: z.number().optional(),
                radius_m: z.number().optional().describe('radius rules: metres'),
                exclude: z.boolean().optional().describe('true: a location matching this rule is NOT this place'),
                priority: z.number().int().optional(),
            };
            shape.label = z.string().max(80).optional().describe('add/edit: the name of the place');
            shape.notes = z.string().max(2000).nullable().optional().describe('add/edit: notes (edit: null clears them)');
            if (actions.includes('add')) shape.rules = z.array(z.object(rule)).max(50).optional().describe('add: the rules of the new place');
            if (actions.includes('edit')) {
                shape.note = z.string().max(200).optional().describe('edit: why it changed');
                shape.add_rules = z.array(z.object(rule)).max(50).optional().describe('edit: rules to add');
                shape.update_rules = z.array(z.object({ ...rule, id: z.number().int().positive(), type: rule.type.optional() })).max(50).optional()
                    .describe('edit: rules to change, by rule id; only the fields sent change');
                shape.remove_rule_ids = z.array(z.number().int().positive()).max(50).optional().describe('edit: ids of rules to remove');
            }
        }
        return shape;
    },

    run(action, args, { db, key }) {
        switch (action) {
        case 'list': {
            const all = places.list(db, { kind: args.kind });
            const shown = all.slice(0, args.limit || LIST_MAX);
            return { count: shown.length, total: all.length, places: shown.map((p) => place(p, LIST_NOTES_CHARS)) };
        }
        case 'get': {
            const p = places.get(db, need(args.id, 'an id', action));
            return { ...place(p), source: p.source, revisions: p.revisions, updated_at: p.updated_at };
        }
        case 'resolve':
            return resolved(places.resolve(db, query(args, false)));
        case 'suggest': {
            const r = places.resolve(db, query(args, true));
            const out = resolved(r);
            if (!r.match) out.suggestion = r.suggestion ? { id: r.suggestion.id, status: r.suggestion.status, count: r.suggestion.count } : null;
            return out;
        }
        case 'add':
            return places.create(db, { label: args.label, kind: args.kind, notes: args.notes, rules: args.rules }, key.name);
        case 'edit':
            return edit(db, args, key.name);
        default:
            throw new ToolError('bad_action', `Unknown action "${action}".`);
        }
    },
};
