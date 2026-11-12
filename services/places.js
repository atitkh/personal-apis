// Places: the spots Atit keeps returning to, and the rules that recognise a location as one of them.
// Reference data: curated and edited by a person, read by digests (and later flights, trips, automations).
//
// MODEL (migration 005)
//   places             label (unique, any case), kind, notes, source manual|suggested
//   place_rules        how a location is recognised as the place:
//                        street  value appears in the geocoded address (any case, see fold())
//                        zone    value is a Home Assistant zone ("home", "zone.home" and "Home" are the same)
//                        radius  within radius_m metres of lat, lon (haversine)
//                      exclude turns a rule around: when it matches, the location is NOT this place.
//   place_revisions    every change to a place OR to one of its rules stores the whole place (label, kind,
//                      notes, all rules) as a new revision, so any earlier state can be restored. Restore
//                      brings rules back under their old ids. Nothing is ever rewritten; a restore is itself
//                      a new revision. Deleting a place is final and takes rules and revisions with it.
//   place_suggestions  streets seen that no place claims, waiting for a person to name or dismiss them.
//
// RESOLVE ({ geocode, lat, lon, zone, suggest }) is deterministic, no model involved:
//   1. Every rule is tried against what was given (street rules need geocode, radius rules lat and lon,
//      zone rules zone). A place with a matching exclude rule is out, whatever else matches.
//   2. Each remaining place is represented by its most specific matching rule, and the places are ranked
//      the same way:
//        a. zone or radius beats street
//        b. between street rules, the longer matched text
//        c. the higher rule priority
//        d. the smaller circle (a zone has no known size and counts as the widest)
//        e. the older place, then the older rule
//   3. The answer is { match, matched_rule, confidence } with confidence "exact" (zone or radius) or
//      "street"; `alternatives` lists the other places that matched, best first; `excluded` lists places
//      that would have matched but for an exclude rule. Nothing matched: { match: null }.
//   4. Only when the caller sends suggest: true and nothing matched, the street is filed in
//      place_suggestions (count + 1 per call). The street is the text before the first comma or line
//      break with a leading house number removed ("12 Example Ave, Springfield" gives "Example Ave"), see streetOf().
//      A dismissed street stays dismissed; an accepted one whose place no longer matches is pending again.
//   5. A person works the queue off (acceptSuggestion, dismissSuggestion; REST places:api-write and the admin
//      API, never the agent tool): accept adds the street as a street rule to a place or creates a place with
//      it (revision source "suggestion"); dismiss keeps the row, so later sightings only raise its count.
//
// JSON uses the column names (updated_at, radius_m, matched_rule). Audit entries carry ids and labels only,
// never rule values: a rule value can be the home address. Use auditDetail() for them.
const { HubError } = require('./errors');
const { toId } = require('./lib/validate');
const { needRow, commitRevision, findRevision } = require('./lib/revisions');
const { clampLimit } = require('./lib/listing');

const KINDS = ['home', 'campus', 'family', 'friend', 'store', 'transit', 'other'];
const SOURCES = ['manual', 'suggested'];
const RULE_TYPES = ['street', 'zone', 'radius'];
const STATUSES = ['pending', 'accepted', 'dismissed'];
const RULE_FIELDS = ['type', 'value', 'lat', 'lon', 'radius_m', 'exclude', 'priority'];
const MAX_LABEL = 80;
const MAX_NOTES = 2000;
const MAX_VALUE = 120;
const MIN_STREET = 3;         // a shorter text would match almost any address
const MAX_RULES = 50;
const MAX_GEOCODE = 500;
const MAX_RADIUS_M = 50000;
const MAX_PRIORITY = 100;
const EARTH_RADIUS_M = 6371008.8;
// What Home Assistant reports when the person is in no zone.
const NO_ZONE = new Set(['', 'not_home', 'unknown', 'unavailable', 'none']);

class PlaceError extends HubError {}

const bad = (code, message, status = 400) => new PlaceError(status, code, message);
const REVISIONS = { table: 'places', revTable: 'place_revisions', fk: 'place_id' };
const now = () => new Date().toISOString();
const who = (actor) => String(actor || 'unknown');

/* ---------- text, zones and distance ---------- */

// How addresses and street rules are compared: any case, full stops dropped, commas and white space
// (line breaks too) as one space. "Maple Ridge Dr." is found in "410 maple ridge dr, Springfield".
const fold = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\./g, '').replace(/[\s,]+/g, ' ').trim();

// "zone.ua_little_rock", "UA Little Rock" and "ua_little_rock" are the same zone.
const zoneId = (s) => String(s).trim().toLowerCase().replace(/^zone\./, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');

const rad = (deg) => (deg * Math.PI) / 180;
function haversine(lat1, lon1, lat2, lon2) {
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// The street of a geocoded address, for the suggestions queue. Deliberately simple: the text before the
// first comma or line break, minus a leading house number (3601, 12B, 37-12). Null when that leaves
// nothing with a letter in it.
function streetOf(geocode) {
    const first = String(geocode).split(/[,\n]/)[0].replace(/\s+/g, ' ').trim();
    const street = first.replace(/^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?\s+(?=\S)/, '');
    if (street.length < MIN_STREET || street.length > MAX_VALUE || !/\p{L}/u.test(street)) return null;
    return street;
}

/* ---------- validation ---------- */

function cleanLabel(v) {
    if (typeof v !== 'string' || !v.trim()) throw bad('bad_label', 'A label is required.');
    const label = v.replace(/\s+/g, ' ').trim();
    if (label.length > MAX_LABEL) throw bad('bad_label', `A label is at most ${MAX_LABEL} characters.`);
    return label;
}

function cleanKind(v) {
    if (!KINDS.includes(v)) throw bad('bad_kind', `Kind must be one of: ${KINDS.join(', ')}.`);
    return v;
}

function cleanNotes(v) {
    if (v == null) return null;
    if (typeof v !== 'string') throw bad('bad_notes', 'Notes must be text.');
    const text = v.replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_NOTES) throw bad('too_large', `Notes are at most ${MAX_NOTES} characters.`, 413);
    return text || null;
}

const number = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

function cleanPoint(lat, lon, code) {
    const point = { lat: number(lat), lon: number(lon) };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
        throw bad(code, 'lat (-90 to 90) and lon (-180 to 180) are needed together, as numbers.');
    }
    return point;
}

function cleanFlag(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0 || v == null) return false;
    throw bad('bad_rule', 'exclude must be true or false.');
}

// A complete, valid rule from `input` laid over `current` (the rule being changed, if any).
function cleanRule(input, current = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('bad_rule', 'A rule is an object with a type.');
    const m = {};
    for (const f of RULE_FIELDS) m[f] = input[f] !== undefined ? input[f] : current[f];
    if (!RULE_TYPES.includes(m.type)) throw bad('bad_rule', `Rule type must be one of: ${RULE_TYPES.join(', ')}.`);

    const priority = m.priority == null ? 0 : number(m.priority);
    if (!Number.isInteger(priority) || Math.abs(priority) > MAX_PRIORITY) throw bad('bad_rule', `priority is a whole number from -${MAX_PRIORITY} to ${MAX_PRIORITY}.`);
    const rule = { type: m.type, value: null, lat: null, lon: null, radius_m: null, exclude: cleanFlag(m.exclude), priority };

    const text = m.value == null ? '' : String(m.value).replace(/\s+/g, ' ').trim();
    if (text.length > MAX_VALUE) throw bad('bad_rule', `A rule value is at most ${MAX_VALUE} characters.`);
    if (m.type === 'street') {
        if (fold(text).length < MIN_STREET) throw bad('bad_rule', `A street rule needs at least ${MIN_STREET} characters of the address.`);
        rule.value = text;
    } else if (m.type === 'zone') {
        const zone = zoneId(text);
        if (NO_ZONE.has(zone)) throw bad('bad_rule', 'A zone rule needs a Home Assistant zone, like home or zone.home.');
        rule.value = zone;
    } else {
        Object.assign(rule, cleanPoint(m.lat, m.lon, 'bad_rule'));
        rule.radius_m = number(m.radius_m);
        if (!Number.isFinite(rule.radius_m) || rule.radius_m < 1 || rule.radius_m > MAX_RADIUS_M) {
            throw bad('bad_rule', `radius_m is a number of metres from 1 to ${MAX_RADIUS_M}.`);
        }
        rule.value = text || null; // an optional caption
    }
    return rule;
}

// Two rules of one place that say the same thing (or the opposite: the same match once as exclude).
const ruleKey = (r) => (r.type === 'radius' ? `radius:${r.lat}:${r.lon}:${r.radius_m}` : `${r.type}:${r.type === 'street' ? fold(r.value) : r.value}`);

function cleanRules(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw bad('bad_rule', 'rules must be a list.');
    if (list.length > MAX_RULES) throw bad('too_many_rules', `A place has at most ${MAX_RULES} rules.`);
    const seen = new Set();
    return list.map((item) => {
        const rule = cleanRule(item);
        if (seen.has(ruleKey(rule))) throw bad('duplicate_rule', 'The same rule is listed twice.', 409);
        seen.add(ruleKey(rule));
        return rule;
    });
}

/* ---------- rows ---------- */

const shapeRule = (r) => ({ id: r.id, type: r.type, value: r.value, lat: r.lat, lon: r.lon, radius_m: r.radius_m, exclude: r.exclude === 1 || r.exclude === true, priority: r.priority });
const rulesOf = (db, placeId) => db.prepare('SELECT * FROM place_rules WHERE place_id = ? ORDER BY id').all(placeId).map(shapeRule);

const need = (db, id) => needRow(db, 'places', id, () => bad('not_found', `There is no place ${id}.`, 404));

function needRule(db, place, ruleId) {
    const rule = toId(ruleId) && db.prepare('SELECT * FROM place_rules WHERE id = ? AND place_id = ?').get(toId(ruleId), place.id);
    if (!rule) throw bad('no_rule', `${place.label} has no rule ${ruleId}.`, 404);
    return rule;
}

function labelFree(db, label, exceptId = 0) {
    if (db.prepare('SELECT 1 FROM places WHERE label = ? AND id != ?').get(label, exceptId)) {
        throw bad('label_taken', `There is already a place called ${label}.`, 409);
    }
}

function insertRule(db, placeId, r, at, id = null) {
    return Number(db.prepare('INSERT INTO place_rules (id, place_id, type, value, lat, lon, radius_m, exclude, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, placeId, r.type, r.value, r.lat, r.lon, r.radius_m, r.exclude ? 1 : 0, r.priority, at).lastInsertRowid);
}

const snapshot = (db, p) => ({ label: p.label, kind: p.kind, notes: p.notes, rules: rulesOf(db, p.id) });

// Stores the place as it is now as its next revision. Every change ends here.
const commit = (db, id, meta) => commitRevision(db, REVISIONS, id, meta, (p) => snapshot(db, p));

function shape(p, rules) {
    return {
        id: p.id,
        label: p.label,
        kind: p.kind,
        notes: p.notes,
        source: p.source,
        rev: p.current_rev,
        created_at: p.created_at,
        updated_at: p.updated_at,
        updated_by: p.updated_by,
        rules,
    };
}

/* ---------- reading ---------- */

// Every place with its rules, by label.
function list(db, { kind } = {}) {
    if (kind != null && kind !== '') cleanKind(kind);
    const rows = kind
        ? db.prepare('SELECT * FROM places WHERE kind = ? ORDER BY label COLLATE NOCASE').all(kind)
        : db.prepare('SELECT * FROM places ORDER BY label COLLATE NOCASE').all();
    const rules = new Map();
    for (const r of db.prepare('SELECT * FROM place_rules ORDER BY id').all()) {
        if (!rules.has(r.place_id)) rules.set(r.place_id, []);
        rules.get(r.place_id).push(shapeRule(r));
    }
    return rows.map((p) => shape(p, rules.get(p.id) || []));
}

// One place with its rules and how many revisions it has. `rev` gives it as it was at that revision.
function get(db, id, { rev } = {}) {
    const p = need(db, id);
    if (rev == null || rev === '' || Number(rev) === p.current_rev) return { ...shape(p, rulesOf(db, p.id)), revisions: p.current_rev };
    const r = findRevision(db, REVISIONS, p.id, rev);
    if (!r) throw bad('no_revision', `Revision ${rev} does not exist.`, 404);
    const old = JSON.parse(r.snapshot);
    return { ...shape({ ...p, ...old, current_rev: r.rev, updated_at: r.at, updated_by: r.actor }, old.rules), revisions: p.current_rev };
}

// Newest first, without rule values: what changed is read with get(id, { rev }).
function history(db, id) {
    const p = need(db, id);
    return db.prepare('SELECT rev, snapshot, source, actor, note, at FROM place_revisions WHERE place_id = ? ORDER BY rev DESC').all(p.id)
        .map(({ snapshot: json, ...r }) => {
            const s = JSON.parse(json);
            return { ...r, label: s.label, kind: s.kind, rules: s.rules.length, current: r.rev === p.current_rev };
        });
}

function stats(db) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM places').get().n;
    const last = db.prepare('SELECT MAX(updated_at) AS at FROM places').get().at;
    return { records: total, label: total === 1 ? 'place' : 'places', lastChange: last };
}

/* ---------- writing ----------
   Each returns { status, id, label, rev } (plus rule_id and rule_type for rule changes); status is created,
   updated, unchanged or deleted. `source` in the options is what the revision is recorded as (the importer
   passes "import"). */

function create(db, input, actor, { source = 'create' } = {}) {
    const given = input || {};
    const label = cleanLabel(given.label);
    const kind = given.kind == null ? 'other' : cleanKind(given.kind);
    const notes = cleanNotes(given.notes);
    const origin = given.source == null ? 'manual' : given.source;
    if (!SOURCES.includes(origin)) throw bad('bad_source', `source must be one of: ${SOURCES.join(', ')}.`);
    const rules = cleanRules(given.rules);

    return db.transaction(() => {
        labelFree(db, label);
        const at = now();
        const id = Number(db.prepare('INSERT INTO places (label, kind, notes, source, current_rev, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
            .run(label, kind, notes, origin, at, at, who(actor)).lastInsertRowid);
        for (const rule of rules) insertRule(db, id, rule, at);
        return { status: 'created', id, label, rev: commit(db, id, { source, actor }) };
    })();
}

// Changes label, kind or notes; a field that is not sent stays as it is (notes: null clears them).
function update(db, id, input, actor, { source = 'edit' } = {}) {
    const given = input || {};
    if (given.label === undefined && given.kind === undefined && given.notes === undefined) {
        throw bad('bad_request', 'Send at least one of label, kind or notes.');
    }
    return db.transaction(() => {
        const p = need(db, id);
        const label = given.label === undefined ? p.label : cleanLabel(given.label);
        const kind = given.kind === undefined ? p.kind : cleanKind(given.kind);
        const notes = given.notes === undefined ? p.notes : cleanNotes(given.notes);
        if (label === p.label && kind === p.kind && notes === p.notes) return { status: 'unchanged', id: p.id, label, rev: p.current_rev };
        labelFree(db, label, p.id);
        db.prepare('UPDATE places SET label = ?, kind = ?, notes = ? WHERE id = ?').run(label, kind, notes, p.id);
        const note = given.note ? String(given.note).slice(0, 200) : null;
        return { status: 'updated', id: p.id, label, rev: commit(db, p.id, { source, actor, note }) };
    })();
}

// Puts the place, with all its rules, back to how it was at `rev`. Rules come back under their old ids.
function restore(db, id, rev, actor) {
    return db.transaction(() => {
        const p = need(db, id);
        const old = findRevision(db, REVISIONS, p.id, rev);
        if (!old) throw bad('no_revision', `Revision ${rev} does not exist.`, 404);
        const was = JSON.parse(old.snapshot);
        if (JSON.stringify(was) === JSON.stringify(snapshot(db, p))) return { status: 'unchanged', id: p.id, label: p.label, rev: p.current_rev };
        labelFree(db, was.label, p.id);
        db.prepare('UPDATE places SET label = ?, kind = ?, notes = ? WHERE id = ?').run(was.label, was.kind, was.notes, p.id);
        db.prepare('DELETE FROM place_rules WHERE place_id = ?').run(p.id);
        const at = now();
        for (const rule of was.rules) insertRule(db, p.id, rule, at, rule.id);
        return { status: 'updated', id: p.id, label: was.label, rev: commit(db, p.id, { source: 'restore', actor, note: `Restored revision ${old.rev}` }) };
    })();
}

// Final: the rules and the history go with it. Suggestions that led to it stay, without the link.
function remove(db, id) {
    return db.transaction(() => {
        const p = need(db, id);
        db.prepare('DELETE FROM places WHERE id = ?').run(p.id);
        return { status: 'deleted', id: p.id, label: p.label, rev: p.current_rev };
    })();
}

function addRule(db, id, input, actor, { source = 'rule' } = {}) {
    const rule = cleanRule(input);
    return db.transaction(() => {
        const p = need(db, id);
        const existing = rulesOf(db, p.id);
        if (existing.length >= MAX_RULES) throw bad('too_many_rules', `A place has at most ${MAX_RULES} rules.`);
        if (existing.some((r) => ruleKey(r) === ruleKey(rule))) throw bad('duplicate_rule', `${p.label} already has that rule.`, 409);
        const ruleId = insertRule(db, p.id, rule, now());
        const rev = commit(db, p.id, { source, actor, note: `Added ${rule.exclude ? 'an exclude' : 'a'} ${rule.type} rule` });
        return { status: 'updated', id: p.id, label: p.label, rev, rule_id: ruleId, rule_type: rule.type };
    })();
}

// Only the fields that are sent change.
function updateRule(db, id, ruleId, input, actor) {
    return db.transaction(() => {
        const p = need(db, id);
        const current = shapeRule(needRule(db, p, ruleId));
        const rule = cleanRule(input, current);
        const base = { status: 'unchanged', id: p.id, label: p.label, rev: p.current_rev, rule_id: current.id, rule_type: rule.type };
        if (RULE_FIELDS.every((f) => rule[f] === current[f])) return base;
        if (rulesOf(db, p.id).some((r) => r.id !== current.id && ruleKey(r) === ruleKey(rule))) throw bad('duplicate_rule', `${p.label} already has that rule.`, 409);
        db.prepare('UPDATE place_rules SET type = ?, value = ?, lat = ?, lon = ?, radius_m = ?, exclude = ?, priority = ? WHERE id = ?')
            .run(rule.type, rule.value, rule.lat, rule.lon, rule.radius_m, rule.exclude ? 1 : 0, rule.priority, current.id);
        return { ...base, status: 'updated', rev: commit(db, p.id, { source: 'rule', actor, note: `Changed a ${rule.type} rule` }) };
    })();
}

function removeRule(db, id, ruleId, actor) {
    return db.transaction(() => {
        const p = need(db, id);
        const rule = needRule(db, p, ruleId);
        db.prepare('DELETE FROM place_rules WHERE id = ?').run(rule.id);
        const rev = commit(db, p.id, { source: 'rule', actor, note: `Removed ${rule.exclude ? 'an exclude' : 'a'} ${rule.type} rule` });
        return { status: 'updated', id: p.id, label: p.label, rev, rule_id: rule.id, rule_type: rule.type };
    })();
}

// The only fields of a change that may go into the audit log. Never rule values.
function auditDetail(result) {
    const detail = { id: result.id, label: result.label, rev: result.rev };
    if (result.rule_id != null) Object.assign(detail, { rule_id: result.rule_id, rule_type: result.rule_type });
    return detail;
}

/* ---------- resolve ---------- */

function cleanQuery(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('bad_query', 'Send a geocode string, lat and lon, or a zone.');
    const given = (v) => v != null && v !== '';
    const q = { geocode: null, text: null, point: null, zone: null, suggest: input.suggest === true };
    if (!given(input.geocode) && !given(input.lat) && !given(input.lon) && !given(input.zone)) {
        throw bad('bad_query', 'Send a geocode string, lat and lon, or a zone.');
    }
    if (given(input.geocode)) {
        if (typeof input.geocode !== 'string') throw bad('bad_query', 'geocode must be text.');
        if (input.geocode.length > MAX_GEOCODE) throw bad('too_large', `geocode is at most ${MAX_GEOCODE} characters.`, 413);
        q.text = fold(input.geocode) || null;
        q.geocode = q.text ? input.geocode.trim() : null;
    }
    if (given(input.lat) || given(input.lon)) q.point = cleanPoint(input.lat, input.lon, 'bad_query');
    if (given(input.zone)) {
        if (typeof input.zone !== 'string') throw bad('bad_query', 'zone must be text.');
        const zone = zoneId(input.zone);
        q.zone = NO_ZONE.has(zone) ? null : zone;
    }
    return q;
}

// Does this rule match the query? Returns what is needed to rank it, or null.
function hit(rule, q) {
    let detail = null;
    if (rule.type === 'street' && q.text) {
        const text = fold(rule.value);
        if (text && q.text.includes(text)) detail = { exact: 0, length: text.length, width: 0 };
    } else if (rule.type === 'zone' && q.zone) {
        if (zoneId(rule.value) === q.zone) detail = { exact: 1, length: 0, width: Infinity };
    } else if (rule.type === 'radius' && q.point) {
        const distance = haversine(q.point.lat, q.point.lon, rule.lat, rule.lon);
        if (distance <= rule.radius_m) detail = { exact: 1, length: 0, width: rule.radius_m, distance_m: Math.round(distance) };
    }
    return detail && { rule, ...detail };
}

// Sorts the more specific hit first (step 2 in the notes at the top). A total order, so the answer never
// depends on the order rows come back in.
function bySpecificity(a, b) {
    const order = [
        [a.exact, b.exact, -1],
        [a.length, b.length, -1],
        [a.rule.priority, b.rule.priority, -1],
        [a.width, b.width, 1],
        [a.rule.place_id, b.rule.place_id, 1],
        [a.rule.id, b.rule.id, 1],
    ];
    for (const [x, y, direction] of order) {
        if (x !== y) return x < y ? -direction : direction;
    }
    return 0;
}

function ruleOut(h) {
    const out = { id: h.rule.id, type: h.rule.type, value: h.rule.value, priority: h.rule.priority };
    if (h.rule.type === 'radius') Object.assign(out, { radius_m: h.rule.radius_m, distance_m: h.distance_m });
    return out;
}

const confidence = (h) => (h.exact ? 'exact' : 'street');

function fileSuggestion(db, street, q) {
    const at = now();
    const point = q.point || { lat: null, lon: null };
    const seen = db.prepare('SELECT * FROM place_suggestions WHERE street = ?').get(street);
    if (!seen) {
        db.prepare("INSERT INTO place_suggestions (street, example_lat, example_lon, example_text, count, first_seen, last_seen, status) VALUES (?, ?, ?, ?, 1, ?, ?, 'pending')")
            .run(street, point.lat, point.lon, q.geocode, at, at);
    } else {
        // Seen again. Dismissed stays dismissed; "accepted" was evidently not settled, so it is asked again.
        db.prepare(`UPDATE place_suggestions SET count = count + 1, last_seen = ?,
                        example_lat = COALESCE(example_lat, ?), example_lon = COALESCE(example_lon, ?), example_text = COALESCE(example_text, ?),
                        status = CASE status WHEN 'accepted' THEN 'pending' ELSE status END,
                        resolved_place_id = CASE status WHEN 'accepted' THEN NULL ELSE resolved_place_id END,
                        decided_at = CASE status WHEN 'accepted' THEN NULL ELSE decided_at END,
                        decided_by = CASE status WHEN 'accepted' THEN NULL ELSE decided_by END
                    WHERE id = ?`).run(at, point.lat, point.lon, q.geocode, seen.id);
    }
    return db.prepare('SELECT * FROM place_suggestions WHERE street = ?').get(street);
}

function resolve(db, input) {
    const q = cleanQuery(input);
    const rows = db.prepare(`SELECT r.*, p.label, p.kind, p.notes FROM place_rules r JOIN places p ON p.id = r.place_id ORDER BY r.id`).all();

    const places = new Map();
    for (const row of rows) {
        const h = hit(row, q);
        if (!h) continue;
        if (!places.has(row.place_id)) places.set(row.place_id, { id: row.place_id, label: row.label, kind: row.kind, notes: row.notes, best: null, blocked: null });
        const place = places.get(row.place_id);
        if (row.exclude) place.blocked = place.blocked || h;
        else if (!place.best || bySpecificity(h, place.best) < 0) place.best = h;
    }
    const matched = [...places.values()].filter((p) => p.best && !p.blocked).sort((a, b) => bySpecificity(a.best, b.best));
    const excluded = [...places.values()].filter((p) => p.best && p.blocked).sort((a, b) => a.id - b.id);

    const out = { match: null };
    if (matched.length) {
        const [first, ...rest] = matched;
        out.match = { id: first.id, label: first.label, kind: first.kind, notes: first.notes };
        out.matched_rule = ruleOut(first.best);
        out.confidence = confidence(first.best);
        if (rest.length) {
            out.alternatives = rest.map((p) => ({ id: p.id, label: p.label, kind: p.kind, matched_rule: ruleOut(p.best), confidence: confidence(p.best) }));
        }
    }
    if (excluded.length) out.excluded = excluded.map((p) => ({ id: p.id, label: p.label, matched_rule: ruleOut(p.blocked) }));
    if (!out.match && q.suggest) {
        const street = q.geocode ? streetOf(q.geocode) : null;
        out.suggestion = street ? fileSuggestion(db, street, q) : null;
    }
    return out;
}

// The queue of unnamed streets, most recently seen first.
function suggestions(db, { status = 'pending', limit = 100 } = {}) {
    if (status !== 'all' && !STATUSES.includes(status)) throw bad('bad_status', `status must be one of: ${STATUSES.join(', ')}, all.`);
    const n = clampLimit(limit, 100, 500);
    return status === 'all'
        ? db.prepare('SELECT * FROM place_suggestions ORDER BY last_seen DESC, id DESC LIMIT ?').all(n)
        : db.prepare('SELECT * FROM place_suggestions WHERE status = ? ORDER BY last_seen DESC, id DESC LIMIT ?').all(status, n);
}

// How many suggestions there are in each status (every status is listed, 0 included).
function suggestionCounts(db) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM place_suggestions GROUP BY status').all()) counts[r.status] = r.n;
    return counts;
}

const needSuggestion = (db, id) => needRow(db, 'place_suggestions', id, () => bad('not_found', `There is no suggestion ${id}.`, 404));

function decide(db, s, status, placeId, actor) {
    db.prepare('UPDATE place_suggestions SET status = ?, resolved_place_id = ?, decided_at = ?, decided_by = ? WHERE id = ?')
        .run(status, placeId, now(), who(actor), s.id);
    return db.prepare('SELECT * FROM place_suggestions WHERE id = ?').get(s.id);
}

// Names a suggested street. Either { place_id } adds the street as a street rule to that place, or
// { label, kind, notes } creates a new place (source "suggested") with the street as its rule. Both store a
// revision of the place. A pending or dismissed suggestion can be accepted; an accepted one cannot again.
// Returns { status: 'accepted', suggestion, place } where place is the create/addRule result.
function acceptSuggestion(db, id, input, actor) {
    const given = input || {};
    const attach = given.place_id != null;
    if (attach && given.label != null) throw bad('bad_request', 'Send either place_id or a label for a new place, not both.');
    if (!attach && given.label == null) throw bad('bad_request', 'Send place_id (attach to a place) or label (create a new place).');
    return db.transaction(() => {
        const s = needSuggestion(db, id);
        if (s.status === 'accepted') throw bad('already_accepted', `Suggestion ${s.id} is already accepted.`, 409);
        const rule = { type: 'street', value: s.street };
        const place = attach
            ? addRule(db, given.place_id, rule, actor, { source: 'suggestion' })
            : create(db, { label: given.label, kind: given.kind, notes: given.notes, source: 'suggested', rules: [rule] }, actor, { source: 'suggestion' });
        return { status: 'accepted', suggestion: decide(db, s, 'accepted', place.id, actor), place };
    })();
}

// Says "not a place". The row stays as dismissed, so the street is never filed as pending again.
function dismissSuggestion(db, id, actor) {
    return db.transaction(() => {
        const s = needSuggestion(db, id);
        if (s.status === 'accepted') throw bad('already_accepted', `Suggestion ${s.id} is already accepted; remove the rule from its place instead.`, 409);
        if (s.status === 'dismissed') return { status: 'unchanged', suggestion: s };
        return { status: 'dismissed', suggestion: decide(db, s, 'dismissed', null, actor) };
    })();
}

// What a suggestion decision may put in the audit log: ids, the place label and rule type. Never the street.
function suggestionAuditDetail(result) {
    const detail = { suggestion_id: result.suggestion.id, status: result.suggestion.status };
    if (result.place) Object.assign(detail, auditDetail(result.place), { created: result.place.status === 'created' });
    return detail;
}

module.exports = {
    PlaceError, KINDS, RULE_TYPES, STATUSES,
    list, get, history, stats,
    create, update, restore, remove, addRule, updateRule, removeRule, auditDetail,
    resolve, suggestions, suggestionCounts, acceptSuggestion, dismissSuggestion, suggestionAuditDetail,
    streetOf, haversine, fold, zoneId,
};
