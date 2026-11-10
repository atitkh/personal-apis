process.env.HUB_DB_FILE = ':memory:';

// Every address, street and coordinate in this file is invented.
const db = require('../db');
const places = require('../services/places');
const domains = require('../services/domains');
const importer = require('../scripts/places-import');

let conn;
beforeEach(() => { conn = db.open(':memory:'); });
afterEach(() => conn.close());

const street = (value, extra = {}) => ({ type: 'street', value, ...extra });
const circle = (lat, lon, radius_m, extra = {}) => ({ type: 'radius', lat, lon, radius_m, ...extra });
const zone = (value, extra = {}) => ({ type: 'zone', value, ...extra });
const add = (label, rules = [], extra = {}) => places.create(conn, { label, rules, ...extra }, 'tester').id;
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'no error'; };
const HOME = '410 Maple Ridge Dr, Springfield, AR 70000, USA';

describe('places and their history', () => {
    test('create stores the place with its rules as revision 1', () => {
        const made = places.create(conn, { label: '  Home ', kind: 'home', notes: 'The flat.', rules: [street('Maple Ridge Dr'), zone('zone.home')] }, 'tester');
        expect(made).toEqual({ status: 'created', id: expect.any(Number), label: 'Home', rev: 1 });

        const p = places.get(conn, made.id);
        expect(p).toMatchObject({ id: made.id, label: 'Home', kind: 'home', notes: 'The flat.', source: 'manual', rev: 1, revisions: 1, updated_by: 'tester' });
        expect(p.rules).toEqual([
            { id: expect.any(Number), type: 'street', value: 'Maple Ridge Dr', lat: null, lon: null, radius_m: null, exclude: false, priority: 0 },
            { id: expect.any(Number), type: 'zone', value: 'home', lat: null, lon: null, radius_m: null, exclude: false, priority: 0 },
        ]);
        expect(places.list(conn)).toEqual([expect.objectContaining({ label: 'Home', rules: p.rules })]);
        expect(places.list(conn, { kind: 'store' })).toEqual([]);
    });

    test('labels are unique whatever the case, and input is checked', () => {
        add('Home');
        expect(code(() => add('home'))).toBe('label_taken');
        expect(code(() => add(''))).toBe('bad_label');
        expect(code(() => add('X', [], { kind: 'castle' }))).toBe('bad_kind');
        expect(code(() => add('X', [], { source: 'guessed' }))).toBe('bad_source');
        expect(code(() => add('X', [street('ab')]))).toBe('bad_rule');
        expect(code(() => add('X', [{ type: 'wifi', value: 'attic' }]))).toBe('bad_rule');
        expect(code(() => add('X', [{ type: 'radius', lat: 10 }]))).toBe('bad_rule');
        expect(code(() => add('X', [circle(95, 10, 50)]))).toBe('bad_rule');
        expect(code(() => add('X', [circle(10, 10, 0)]))).toBe('bad_rule');
        expect(code(() => add('X', [zone('not_home')]))).toBe('bad_rule');
        expect(code(() => add('X', [street('Maple Ridge', { priority: 1.5 })]))).toBe('bad_rule');
        expect(code(() => add('X', [street('Maple Ridge'), street('maple  ridge', { exclude: true })]))).toBe('duplicate_rule');
        expect(code(() => places.get(conn, 999))).toBe('not_found');
        expect(code(() => places.get(conn, 'abc'))).toBe('not_found');
        expect(places.list(conn).map((p) => p.label)).toEqual(['Home']); // nothing half-made
    });

    test('update writes a revision only when something changes', () => {
        const id = add('Campus', [], { kind: 'campus', notes: 'Lab and gym.' });
        expect(places.update(conn, id, { kind: 'campus' }, 'tester')).toMatchObject({ status: 'unchanged', rev: 1 });
        expect(places.update(conn, id, { label: 'Campus (lab)', note: 'clearer' }, 'admin')).toEqual({ status: 'updated', id, label: 'Campus (lab)', rev: 2 });
        expect(places.update(conn, id, { notes: null }, 'admin')).toMatchObject({ status: 'updated', rev: 3 });
        expect(places.get(conn, id)).toMatchObject({ label: 'Campus (lab)', kind: 'campus', notes: null, rev: 3, revisions: 3, updated_by: 'admin' });

        expect(code(() => places.update(conn, id, {}, 'admin'))).toBe('bad_request');
        add('Home');
        expect(code(() => places.update(conn, id, { label: 'HOME' }, 'admin'))).toBe('label_taken');
        expect(code(() => places.update(conn, 999, { label: 'x' }, 'admin'))).toBe('not_found');
    });

    test('rules can be added, changed and removed; each is a revision', () => {
        const id = add('Home', [street('Maple Ridge Dr')]);
        const other = add('Campus', [street('Quill Park Ave')]);

        const added = places.addRule(conn, id, circle(10.5, 20.5, 80, { priority: 2 }), 'tester');
        expect(added).toEqual({ status: 'updated', id, label: 'Home', rev: 2, rule_id: expect.any(Number), rule_type: 'radius' });
        expect(code(() => places.addRule(conn, id, street('MAPLE RIDGE DR.'), 'tester'))).toBe('duplicate_rule');

        expect(places.updateRule(conn, id, added.rule_id, { radius_m: 80 }, 'tester').status).toBe('unchanged');
        expect(places.updateRule(conn, id, added.rule_id, { radius_m: 120, exclude: true }, 'tester')).toMatchObject({ status: 'updated', rev: 3 });
        expect(places.get(conn, id).rules[1]).toMatchObject({ type: 'radius', lat: 10.5, lon: 20.5, radius_m: 120, exclude: true, priority: 2 });

        // A rule belongs to its place.
        const foreign = places.get(conn, other).rules[0].id;
        expect(code(() => places.updateRule(conn, id, foreign, { value: 'Elsewhere Rd' }, 'tester'))).toBe('no_rule');
        expect(code(() => places.removeRule(conn, id, foreign, 'tester'))).toBe('no_rule');

        expect(places.removeRule(conn, id, added.rule_id, 'tester')).toMatchObject({ status: 'updated', rev: 4, rule_id: added.rule_id });
        expect(places.get(conn, id).rules.map((r) => r.type)).toEqual(['street']);
    });

    test('history lists every revision without rule values, and an old revision can be read', () => {
        const id = add('Home', [street('Maple Ridge Dr')]);
        places.update(conn, id, { label: 'Flat' }, 'admin');
        places.addRule(conn, id, zone('home'), 'admin');

        const hist = places.history(conn, id);
        expect(hist.map((h) => [h.rev, h.source, h.actor, h.label, h.rules, h.current])).toEqual([
            [3, 'rule', 'admin', 'Flat', 2, true],
            [2, 'edit', 'admin', 'Flat', 1, false],
            [1, 'create', 'tester', 'Home', 1, false],
        ]);
        expect(JSON.stringify(hist)).not.toMatch(/Maple/);

        expect(places.get(conn, id, { rev: 1 })).toMatchObject({ label: 'Home', rev: 1, revisions: 3, rules: [expect.objectContaining({ value: 'Maple Ridge Dr' })] });
        expect(code(() => places.get(conn, id, { rev: 9 }))).toBe('no_revision');
    });

    test('restore brings back the place and its rules, under their old ids', () => {
        const id = add('Home', [street('Maple Ridge Dr'), zone('home')], { notes: 'first' });
        const before = places.get(conn, id);
        places.update(conn, id, { label: 'Wrong', notes: 'oops' }, 'admin');
        places.removeRule(conn, id, before.rules[0].id, 'admin');
        places.addRule(conn, id, street('Typo Street'), 'admin');

        expect(places.restore(conn, id, 1, 'admin')).toEqual({ status: 'updated', id, label: 'Home', rev: 5 });
        const after = places.get(conn, id);
        expect(after).toMatchObject({ label: 'Home', notes: 'first', rev: 5, revisions: 5 });
        expect(after.rules).toEqual(before.rules);
        expect(places.history(conn, id)[0]).toMatchObject({ source: 'restore', note: 'Restored revision 1' });

        expect(places.restore(conn, id, 1, 'admin').status).toBe('unchanged');
        expect(code(() => places.restore(conn, id, 99, 'admin'))).toBe('no_revision');

        // A label someone else took in the meantime is not stolen back.
        places.update(conn, id, { label: 'Flat' }, 'admin');
        add('Home');
        expect(code(() => places.restore(conn, id, 1, 'admin'))).toBe('label_taken');
    });

    test('delete is final and takes rules and history along', () => {
        const id = add('Cafe', [street('Juniper Hollow')]);
        conn.prepare("INSERT INTO place_suggestions (street, count, first_seen, last_seen, status, resolved_place_id) VALUES ('Juniper Hollow', 3, 'a', 'b', 'accepted', ?)").run(id);

        expect(places.remove(conn, id)).toEqual({ status: 'deleted', id, label: 'Cafe', rev: 1 });
        expect(code(() => places.get(conn, id))).toBe('not_found');
        expect(conn.prepare('SELECT COUNT(*) AS n FROM place_rules').get().n).toBe(0);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM place_revisions').get().n).toBe(0);
        expect(places.suggestions(conn, { status: 'accepted' })[0].resolved_place_id).toBeNull();
        expect(add('Cafe')).toBeGreaterThan(id); // ids are not reused
    });

    test('the domain is registered and counts places', () => {
        expect(places.stats(conn)).toEqual({ records: 0, label: 'places', lastChange: null });
        add('Home');
        const d = domains.list(conn).find((x) => x.name === 'places');
        expect(d).toMatchObject({ title: 'Places', sensitivity: 'private', storage: 'db', enabled: true, records: 1, recordLabel: 'place' });
        expect(d.lastChange).toBeTruthy();
    });
});

describe('resolve', () => {
    test('a street rule is found anywhere in the address, in any case', () => {
        const id = add('Home', [street('Maple Ridge Dr')], { kind: 'home', notes: 'The flat.' });
        const r = places.resolve(conn, { geocode: HOME });
        expect(r).toEqual({
            match: { id, label: 'Home', kind: 'home', notes: 'The flat.' },
            matched_rule: { id: expect.any(Number), type: 'street', value: 'Maple Ridge Dr', priority: 0 },
            confidence: 'street',
        });
        expect(places.resolve(conn, { geocode: '9 MAPLE RIDGE DR.\nSpringfield AR' }).match.id).toBe(id);
        expect(places.resolve(conn, { geocode: '12 maple   ridge dr' }).match.id).toBe(id);
        expect(places.resolve(conn, { geocode: '410 Maple Dr, Springfield' })).toEqual({ match: null });
    });

    test('an exclude rule takes its place out, even though another of its rules matches', () => {
        const friend = add("Mira's place", [street('Eastborough'), street('Fenwick Heights', { exclude: true })]);
        expect(places.resolve(conn, { geocode: '5 Larch Ave, Eastborough, NY' }).match.id).toBe(friend);

        const out = places.resolve(conn, { geocode: '12-34 Larch Ave, Fenwick Heights, Eastborough, NY' });
        expect(out.match).toBeNull();
        expect(out.excluded).toEqual([{ id: friend, label: "Mira's place", matched_rule: expect.objectContaining({ type: 'street', value: 'Fenwick Heights' }) }]);

        // Another place may still claim the spot.
        const diner = add('Diner', [street('Larch Ave')]);
        const again = places.resolve(conn, { geocode: '12-34 Larch Ave, Fenwick Heights, Eastborough, NY' });
        expect(again.match.id).toBe(diner);
        expect(again).not.toHaveProperty('alternatives');
        expect(again.excluded.map((e) => e.id)).toEqual([friend]);
    });

    test('exclude rules work for zones and circles too', () => {
        const id = add('Campus', [street('Quill Park Ave'), circle(10, 20, 60, { exclude: true }), zone('stadium', { exclude: true })]);
        expect(places.resolve(conn, { geocode: '1 Quill Park Ave' }).match.id).toBe(id);
        expect(places.resolve(conn, { geocode: '1 Quill Park Ave', lat: 10, lon: 20 }).match).toBeNull();
        expect(places.resolve(conn, { geocode: '1 Quill Park Ave', zone: 'zone.stadium' }).match).toBeNull();
    });

    test('zone or radius beats street, and the others are listed as alternatives', () => {
        const byStreet = add('Campus', [street('Quill Park Ave')]);
        const byCircle = add('Lab', [circle(10, 20, 60)]);
        const byZone = add('Gym', [zone('gym')], { kind: 'other' });

        const r = places.resolve(conn, { geocode: '1 Quill Park Ave', lat: 10.0001, lon: 20 });
        expect(r.match.id).toBe(byCircle);
        expect(r.confidence).toBe('exact');
        expect(r.matched_rule).toEqual({ id: expect.any(Number), type: 'radius', value: null, priority: 0, radius_m: 60, distance_m: 11 });
        expect(r.alternatives).toEqual([{ id: byStreet, label: 'Campus', kind: 'other', matched_rule: expect.objectContaining({ type: 'street' }), confidence: 'street' }]);

        const z = places.resolve(conn, { geocode: '1 Quill Park Ave', zone: 'gym' });
        expect(z.match.id).toBe(byZone);
        expect(z.confidence).toBe('exact');
        expect(z.alternatives.map((a) => a.id)).toEqual([byStreet]);
    });

    test('between streets the longer text wins, then priority, then the older place', () => {
        const short = add('Maple area', [street('Maple', { priority: 50 })]);
        const long = add('Home', [street('Maple Ridge Dr')]);
        const r = places.resolve(conn, { geocode: HOME });
        expect(r.match.id).toBe(long); // length before priority
        expect(r.alternatives.map((a) => a.id)).toEqual([short]);

        const a = add('Older', [street('Quill Park')]);
        const b = add('Newer', [street('Quill Park')]);
        expect(places.resolve(conn, { geocode: '8 Quill Park' }).match.id).toBe(a);
        places.updateRule(conn, b, places.get(conn, b).rules[0].id, { priority: 1 }, 'tester');
        const tie = places.resolve(conn, { geocode: '8 Quill Park' });
        expect(tie.match.id).toBe(b);
        expect(tie.alternatives.map((x) => x.id)).toEqual([a]);
    });

    test('a place is represented by its most specific rule', () => {
        const id = add('Home', [street('Maple'), street('Maple Ridge Dr'), zone('home')]);
        expect(places.resolve(conn, { geocode: HOME }).matched_rule.value).toBe('Maple Ridge Dr');
        const r = places.resolve(conn, { geocode: HOME, zone: 'home' });
        expect(r.match.id).toBe(id);
        expect(r.matched_rule.type).toBe('zone');
        expect(r).not.toHaveProperty('alternatives');
    });

    test('between circles the smaller wins, unless priority says otherwise; a circle beats a zone on a tie', () => {
        const campus = add('Campus', [circle(10, 20, 900)]);
        const lab = add('Lab', [circle(10, 20, 50)]);
        const zoned = add('Campus zone', [zone('campus')]);

        const r = places.resolve(conn, { lat: 10, lon: 20, zone: 'campus' });
        expect([r.match.id, ...r.alternatives.map((a) => a.id)]).toEqual([lab, campus, zoned]);

        places.updateRule(conn, zoned, places.get(conn, zoned).rules[0].id, { priority: 5 }, 'tester');
        expect(places.resolve(conn, { lat: 10, lon: 20, zone: 'campus' }).match.id).toBe(zoned);
    });

    test('radius uses haversine metres', () => {
        // One degree of longitude on the equator, and of latitude anywhere, is 111.195 km on the mean sphere.
        expect(places.haversine(0, 0, 0, 1)).toBeCloseTo(111195.08, 1);
        expect(places.haversine(40, -75, 41, -75)).toBeCloseTo(111195.08, 1);
        expect(places.haversine(60, 10, 60, 11)).toBeCloseTo(55597.5, -1); // half as far at 60 degrees north
        expect(places.haversine(12.5, 33.25, 12.5, 33.25)).toBe(0);

        // 0.001 degrees of latitude = 111.2 m.
        const id = add('Spot', [circle(40, -75, 112)]);
        expect(places.resolve(conn, { lat: 40.001, lon: -75 })).toMatchObject({ match: { id }, matched_rule: { distance_m: 111, radius_m: 112 }, confidence: 'exact' });
        expect(places.resolve(conn, { lat: '40.001', lon: '-75' }).match.id).toBe(id); // numbers sent as text
        places.updateRule(conn, id, places.get(conn, id).rules[0].id, { radius_m: 110 }, 'tester');
        expect(places.resolve(conn, { lat: 40.001, lon: -75 })).toEqual({ match: null });
    });

    test('zone rules match a Home Assistant zone id or name', () => {
        const home = add('Home', [zone('zone.home')]);
        const campus = add('Campus', [zone('Quill Park Campus')]);
        expect(places.resolve(conn, { zone: 'zone.home' }).match.id).toBe(home);
        expect(places.resolve(conn, { zone: 'Home' }).match.id).toBe(home);
        expect(places.resolve(conn, { zone: 'zone.quill_park_campus' }).match.id).toBe(campus);
        expect(places.resolve(conn, { zone: 'quill park campus' }).matched_rule).toMatchObject({ type: 'zone', value: 'quill_park_campus' });
        expect(places.resolve(conn, { zone: 'not_home' })).toEqual({ match: null });
        expect(places.resolve(conn, { zone: 'work' })).toEqual({ match: null });
    });

    test('no match is { match: null } and files nothing unless asked', () => {
        add('Home', [street('Maple Ridge Dr')]);
        expect(places.resolve(conn, { geocode: '77 Juniper Hollow, Springfield' })).toEqual({ match: null });
        expect(places.resolve(conn, { geocode: '77 Juniper Hollow, Springfield', suggest: 'yes' })).toEqual({ match: null });
        expect(places.suggestions(conn, { status: 'all' })).toEqual([]);

        expect(code(() => places.resolve(conn, {}))).toBe('bad_query');
        expect(code(() => places.resolve(conn, null))).toBe('bad_query');
        expect(code(() => places.resolve(conn, { lat: 10 }))).toBe('bad_query');
        expect(code(() => places.resolve(conn, { lat: 'north', lon: 3 }))).toBe('bad_query');
        expect(code(() => places.resolve(conn, { geocode: 42 }))).toBe('bad_query');
        expect(code(() => places.resolve(conn, { geocode: 'x'.repeat(501) }))).toBe('too_large');
    });

    test('suggest: true files the unmatched street once and counts later sightings', () => {
        const first = places.resolve(conn, { geocode: '77 Juniper Hollow, Springfield, AR', lat: 11.5, lon: 22.5, suggest: true });
        expect(first.match).toBeNull();
        expect(first.suggestion).toMatchObject({ street: 'Juniper Hollow', count: 1, status: 'pending', example_lat: 11.5, example_lon: 22.5, example_text: '77 Juniper Hollow, Springfield, AR', resolved_place_id: null });

        const second = places.resolve(conn, { geocode: '81 juniper hollow, Springfield, AR', suggest: true });
        expect(second.suggestion).toMatchObject({ id: first.suggestion.id, street: 'Juniper Hollow', count: 2, example_text: '77 Juniper Hollow, Springfield, AR' });
        expect(places.suggestions(conn)).toHaveLength(1);

        // Nothing usable as a street: nothing filed.
        expect(places.resolve(conn, { geocode: '12345', suggest: true })).toEqual({ match: null, suggestion: null });
        expect(places.resolve(conn, { lat: 1, lon: 2, suggest: true })).toEqual({ match: null, suggestion: null });

        // A match is not a suggestion.
        add('Home', [street('Maple Ridge Dr')]);
        expect(places.resolve(conn, { geocode: HOME, suggest: true })).not.toHaveProperty('suggestion');
        expect(places.suggestions(conn, { status: 'all' })).toHaveLength(1);
    });

    test('a dismissed street stays dismissed; an accepted one that no longer matches is asked again', () => {
        const { suggestion } = places.resolve(conn, { geocode: '77 Juniper Hollow', suggest: true });
        conn.prepare("UPDATE place_suggestions SET status = 'dismissed' WHERE id = ?").run(suggestion.id);
        expect(places.resolve(conn, { geocode: '77 Juniper Hollow', suggest: true }).suggestion).toMatchObject({ status: 'dismissed', count: 2 });
        expect(places.suggestions(conn)).toEqual([]);

        const cafe = add('Cafe');
        conn.prepare("UPDATE place_suggestions SET status = 'accepted', resolved_place_id = ? WHERE id = ?").run(cafe, suggestion.id);
        expect(places.resolve(conn, { geocode: '77 Juniper Hollow', suggest: true }).suggestion).toMatchObject({ status: 'pending', count: 3, resolved_place_id: null });
        expect(code(() => places.suggestions(conn, { status: 'lost' }))).toBe('bad_status');
    });

    test('an excluded spot with no other claimant is suggested like any unknown street', () => {
        add("Mira's place", [street('Eastborough'), street('Fenwick Heights', { exclude: true })]);
        const out = places.resolve(conn, { geocode: '12-34 82nd St, Fenwick Heights, Eastborough', suggest: true });
        expect(out.match).toBeNull();
        expect(out.suggestion).toMatchObject({ street: '82nd St', status: 'pending' });
    });

    test('streetOf drops the house number and nothing else', () => {
        expect(places.streetOf('410 Maple Ridge Dr, Springfield, AR 70000, USA')).toBe('Maple Ridge Dr');
        expect(places.streetOf('12B Quill Park Ave\nSpringfield AR')).toBe('Quill Park Ave');
        expect(places.streetOf('37-12 82nd St, Eastborough')).toBe('82nd St');
        expect(places.streetOf('82nd St, Eastborough')).toBe('82nd St');
        expect(places.streetOf('Juniper Hollow')).toBe('Juniper Hollow');
        expect(places.streetOf('Corner Market, 9 Larch Ave')).toBe('Corner Market');
        expect(places.streetOf('70000, USA')).toBeNull();
        expect(places.streetOf('   ')).toBeNull();
    });
});

describe('importer', () => {
    const TABLE = [
        '# Known Places',
        '',
        'Some words about the table | with a pipe in them.',
        '',
        '| Match (street name substring) | Label | Notes |',
        '|---|---|---|',
        '| Maple Ridge Dr | Home | The flat. |',
        '| Quill Park Ave | Campus (lab) | Lab, gym and classes. |',
        '| Eastborough | Mira\'s place (NYC) | Broad on purpose. Fenwick Heights is NOT her place, that was a dinner. |',
        '| Larch Ave | Mira\'s place (NYC) | Her street. |',
        '| Tannery Row | Mira\'s place (NYC) | |',
        '| Sorrel Court | Brother\'s place | |',
        '',
        'Add new entries above.',
    ].join('\n');

    test('reads the table', () => {
        const rows = importer.parseTable(TABLE);
        expect(rows).toHaveLength(6);
        expect(rows[0]).toEqual({ match: 'Maple Ridge Dr', label: 'Home', notes: 'The flat.' });
        expect(rows[5]).toEqual({ match: 'Sorrel Court', label: "Brother's place", notes: '' });
        expect(() => importer.parseTable('| A | B |\n|---|---|\n| 1 | 2 |')).toThrow(/Match, Label and Notes/);
    });

    test('rows with one label become one place with several street rules', () => {
        const report = importer.run(conn, TABLE);
        expect(report.places.map((p) => [p.label, p.status, p.rules_added])).toEqual([
            ['Home', 'created', 1], ['Campus (lab)', 'created', 1], ["Mira's place (NYC)", 'created', 3], ["Brother's place", 'created', 1],
        ]);
        const all = places.list(conn);
        expect(all).toHaveLength(4);
        const mira = all.find((p) => p.label === "Mira's place (NYC)");
        expect(mira.rules.map((r) => [r.type, r.value, r.exclude])).toEqual([['street', 'Eastborough', false], ['street', 'Larch Ave', false], ['street', 'Tannery Row', false]]);
        expect(mira.notes).toBe('Eastborough: Broad on purpose. Fenwick Heights is NOT her place, that was a dinner.\nLarch Ave: Her street.');
        expect(all.find((p) => p.label === 'Home')).toMatchObject({ kind: 'home', notes: 'The flat.', source: 'manual', updated_by: 'places-import' });
        expect(all.find((p) => p.label === 'Campus (lab)').kind).toBe('campus');
        expect(all.find((p) => p.label === "Brother's place")).toMatchObject({ kind: 'family', notes: null });
        expect(places.history(conn, mira.id)[0].source).toBe('import');

        // The "NOT" note is reported for a person to act on, not guessed at.
        expect(report.manual).toEqual([{ label: "Mira's place (NYC)", match: 'Eastborough', notes: expect.stringContaining('Fenwick Heights is NOT') }]);
        expect(importer.print(report, {})).toMatch(/Manual step[\s\S]*Fenwick Heights is NOT/);
        expect(places.resolve(conn, { geocode: '3 Oak St, Fenwick Heights, Eastborough' }).match.id).toBe(mira.id); // until the manual step
    });

    test('running it again changes nothing', () => {
        importer.run(conn, TABLE);
        const before = JSON.stringify(places.list(conn));
        const again = importer.run(conn, TABLE);
        expect(again.places.every((p) => p.status === 'unchanged' && p.rules_added === 0)).toBe(true);
        expect(JSON.stringify(places.list(conn))).toBe(before);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM place_revisions').get().n).toBe(4);
    });

    test('a changed table updates: new streets are added, notes follow, nothing is duplicated or removed', () => {
        importer.run(conn, TABLE);
        const changed = TABLE.replace('| The flat. |', '| The flat, second floor. |') + '\n| Birch Lane | Home | |';
        const report = importer.run(conn, changed);
        expect(report.places.find((p) => p.label === 'Home')).toMatchObject({ status: 'updated', rules_added: 1, notes: 'updated' });
        const home = places.list(conn).find((p) => p.label === 'Home');
        expect(home.rules.map((r) => r.value)).toEqual(['Maple Ridge Dr', 'Birch Lane']);
        expect(home.notes).toBe('Maple Ridge Dr: The flat, second floor.');
        expect(places.list(conn)).toHaveLength(4);
    });

    test('notes edited by hand are kept unless forced; rules added by hand survive', () => {
        importer.run(conn, TABLE);
        const home = places.list(conn).find((p) => p.label === 'Home');
        places.update(conn, home.id, { notes: 'My own words.' }, 'admin');
        places.addRule(conn, home.id, zone('home'), 'admin');

        const changed = TABLE.replace('| The flat. |', '| The flat, second floor. |');
        expect(importer.run(conn, changed).places[0]).toMatchObject({ label: 'Home', status: 'unchanged', notes: expect.stringMatching(/^kept/) });
        expect(places.get(conn, home.id)).toMatchObject({ notes: 'My own words.', rules: [expect.anything(), expect.objectContaining({ type: 'zone' })] });

        expect(importer.run(conn, changed, { force: true }).places[0]).toMatchObject({ status: 'updated', notes: 'updated' });
        expect(places.get(conn, home.id).notes).toBe('The flat, second floor.');
        expect(places.get(conn, home.id).rules).toHaveLength(2);
    });

    test('--exclude is the manual step: it adds the exclude rule once', () => {
        const opts = { excludes: ["Mira's place (NYC)=Fenwick Heights", 'Nowhere=Something', "Mira's place (NYC)=Larch Ave"] };
        const report = importer.run(conn, TABLE, opts);
        expect(report.excludes.map((e) => e.status)).toEqual(['added', 'failed', 'failed']);

        const out = places.resolve(conn, { geocode: '3 Oak St, Fenwick Heights, Eastborough' });
        expect(out.match).toBeNull();
        expect(out.excluded[0].label).toBe("Mira's place (NYC)");
        expect(places.resolve(conn, { geocode: '3 Oak St, Eastborough' }).match.label).toBe("Mira's place (NYC)");

        expect(importer.run(conn, TABLE, opts).excludes[0].status).toBe('unchanged');
        expect(places.list(conn).find((p) => p.label === "Mira's place (NYC)").rules.filter((r) => r.exclude)).toHaveLength(1);
    });

    test('a dry run changes nothing', () => {
        const report = importer.run(conn, TABLE, { dryRun: true });
        expect(report.places).toHaveLength(4);
        expect(places.list(conn)).toEqual([]);
        expect(importer.print(report, { dryRun: true })).toMatch(/^Dry run/);
    });
});

describe('suggestion decisions', () => {
    const file = (geocode) => places.resolve(conn, { geocode, suggest: true }).suggestion;

    test('accept with a label creates a suggested place with the street rule, revision and decision', () => {
        const s = file('77 Juniper Hollow, Springfield');
        const out = places.acceptSuggestion(conn, s.id, { label: 'Book club', kind: 'friend', notes: 'Thursdays.' }, 'tester');
        expect(out).toMatchObject({ status: 'accepted', place: { status: 'created', label: 'Book club', rev: 1 } });
        expect(out.suggestion).toMatchObject({ id: s.id, status: 'accepted', resolved_place_id: out.place.id, decided_by: 'tester', decided_at: expect.any(String) });
        const p = places.get(conn, out.place.id);
        expect(p).toMatchObject({ kind: 'friend', notes: 'Thursdays.', source: 'suggested' });
        expect(p.rules).toEqual([expect.objectContaining({ type: 'street', value: 'Juniper Hollow', exclude: false })]);
        expect(places.history(conn, out.place.id)[0]).toMatchObject({ rev: 1, source: 'suggestion', actor: 'tester' });
        // The street now resolves to the new place, and is not filed again.
        expect(places.resolve(conn, { geocode: '80 Juniper Hollow', suggest: true })).toMatchObject({ match: { label: 'Book club' } });
        expect(places.suggestionCounts(conn)).toEqual({ pending: 0, accepted: 1, dismissed: 0 });
    });

    test('accept with place_id adds the street to an existing place as a new revision', () => {
        const cafe = add('Cafe', [zone('cafe')]);
        const s = file('5 Tannery Row, Springfield');
        const out = places.acceptSuggestion(conn, s.id, { place_id: cafe }, 'tester');
        expect(out.place).toMatchObject({ status: 'updated', id: cafe, rev: 2, rule_type: 'street', rule_id: expect.any(Number) });
        expect(places.get(conn, cafe).rules.map((r) => r.type)).toEqual(['zone', 'street']);
        expect(places.history(conn, cafe)[0]).toMatchObject({ rev: 2, source: 'suggestion' });
        expect(code(() => places.acceptSuggestion(conn, s.id, { place_id: cafe }, 'tester'))).toBe('already_accepted');
    });

    test('accept refuses unclear or bad input and changes nothing', () => {
        const cafe = add('Cafe');
        const s = file('5 Tannery Row');
        expect(code(() => places.acceptSuggestion(conn, s.id, {}, 't'))).toBe('bad_request');
        expect(code(() => places.acceptSuggestion(conn, s.id, { place_id: cafe, label: 'X' }, 't'))).toBe('bad_request');
        expect(code(() => places.acceptSuggestion(conn, s.id, { place_id: 999 }, 't'))).toBe('not_found');
        expect(code(() => places.acceptSuggestion(conn, s.id, { label: 'cafe' }, 't'))).toBe('label_taken');
        expect(code(() => places.acceptSuggestion(conn, s.id, { label: 'New', kind: 'castle' }, 't'))).toBe('bad_kind');
        expect(code(() => places.acceptSuggestion(conn, 999, { label: 'New' }, 't'))).toBe('not_found');
        expect(places.suggestions(conn)[0]).toMatchObject({ id: s.id, status: 'pending', resolved_place_id: null });
        expect(places.list(conn).map((p) => p.label)).toEqual(['Cafe']);
    });

    test('a dismissed street stays dismissed: later sightings only raise its count', () => {
        const s = file('77 Juniper Hollow');
        const out = places.dismissSuggestion(conn, s.id, 'tester');
        expect(out).toMatchObject({ status: 'dismissed', suggestion: { status: 'dismissed', decided_by: 'tester' } });
        expect(places.dismissSuggestion(conn, s.id, 'tester').status).toBe('unchanged');
        expect(file('79 juniper hollow')).toMatchObject({ id: s.id, status: 'dismissed', count: 2 });
        expect(places.suggestions(conn)).toEqual([]);
        expect(places.suggestionCounts(conn)).toEqual({ pending: 0, accepted: 0, dismissed: 1 });
        // Once a place claims the street there is no suggestion at all, and the count stays.
        add('Club', [street('Juniper Hollow')]);
        expect(places.resolve(conn, { geocode: '81 Juniper Hollow', suggest: true })).not.toHaveProperty('suggestion');
        expect(places.suggestions(conn, { status: 'dismissed' })[0].count).toBe(2);
    });

    test('a dismissed suggestion can still be accepted; an accepted one cannot be dismissed', () => {
        const s = file('5 Tannery Row');
        places.dismissSuggestion(conn, s.id, 'tester');
        const out = places.acceptSuggestion(conn, s.id, { label: 'Tannery' }, 'tester');
        expect(out.suggestion.status).toBe('accepted');
        expect(code(() => places.dismissSuggestion(conn, s.id, 'tester'))).toBe('already_accepted');
    });

    test('the audit detail of a decision has ids and labels, never the street', () => {
        const s = file('77 Juniper Hollow, Springfield');
        const detail = places.suggestionAuditDetail(places.acceptSuggestion(conn, s.id, { label: 'Book club' }, 'tester'));
        expect(detail).toEqual({ suggestion_id: s.id, status: 'accepted', id: expect.any(Number), label: 'Book club', rev: 1, created: true });
        expect(JSON.stringify(detail)).not.toMatch(/juniper|hollow|springfield/i);
    });
});
