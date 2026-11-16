// Seeds a SCRATCH hub with invented entities, a trip and links for the Graph browser flow (relations: related, for, about, during, member-of, works-on, part-of; one link has a note). Never use on real data.
const db = require('/app/db');
const entities = require('/app/services/entities');
const trips = require('/app/services/trips');
const links = require('/app/services/links');
const places = require('/app/services/places');
const lifelog = require('/app/services/lifelog');
const flights = require('/app/services/flights');
const digests = require('/app/services/digests');
const deadlines = require('/app/services/deadlines');
const c = db.get();
const e = (kind, name) => String(entities.create(c, { kind, name }, 'seed').id);
const mira = e('person', 'Mira Delgado');
const proj = e('project', 'Hub redesign');
const org = e('organization', 'Example Foundation');
const topic = e('topic', 'Tides');
e('person', 'Loner Vance');
const trip = String(trips.create(c, { title: 'Spring break', destination: 'Orlando', kind: 'leisure', start_date: '2026-01-20', end_date: '2026-01-27' }, 'seed').id);
const ent = (id) => ({ domain: 'entities', id });
links.add(c, { from: ent(mira), to: ent(proj), rel: 'works-on' }, 'seed');
links.add(c, { from: ent(proj), to: ent(org), rel: 'part-of' }, 'seed');
links.add(c, { from: ent(org), to: ent(topic), rel: 'about' }, 'seed');
links.add(c, { from: ent(mira), to: { domain: 'trips', id: trip }, rel: 'during' }, 'seed');
// Six invented clusters (a hub and its members) so the whole-graph overview has something to lay out.
const trip2 = String(trips.create(c, { title: 'Field week', destination: 'Tampa', kind: 'leisure', start_date: '2026-03-02', end_date: '2026-03-08' }, 'seed').id);
const HUBS = ['Tidal Mapping', 'Orchard Co-op', 'Night Sky Club', 'Bike Repair Collective', 'Language Exchange', 'Harbor Choir'];
const FIRST = ['Ines', 'Tobias', 'Leila', 'Anders', 'Priya', 'Marcus', 'Noor', 'Felix', 'Yara', 'Owen', 'Sofia', 'Kenji', 'Amara', 'Hugo'];
const LAST = ['Marrow', 'Okafor', 'Lindqvist', 'Bellamy', 'Castellan', 'Whitlock'];
for (let k = 0; k < 6; k += 1) {
    const hub = e('topic', HUBS[k]);
    const leaves = [];
    for (let i = 0; i < 14; i += 1) {
        const leaf = e(i % 3 ? 'person' : 'project', i % 3 ? `${FIRST[i]} ${LAST[k]}` : `${HUBS[k].split(' ')[0]} project ${i / 3 + 1}`);
        leaves.push(leaf);
        links.add(c, { from: ent(hub), to: ent(leaf), rel: 'related' }, 'seed');
        if (i > 0 && i % 4 === 0) links.add(c, { from: ent(leaves[i - 1]), to: ent(leaf), rel: 'related' }, 'seed');
    }
    if (k % 3 === 0) links.add(c, { from: ent(hub), to: { domain: 'trips', id: k ? trip2 : trip }, rel: 'about' }, 'seed');
}
// Places and deadlines (invented) hang off the clusters, so the overview has four linked domains to colour and cluster.
const place = (label, kind) => String(places.create(c, { label, kind }, 'seed').id);
const due = (title, kind, date) => String(deadlines.create(c, { title, kind, due_date: date }, 'seed').id);
const spots = [place('Riverside Library', 'other'), place('Harbor Cafe', 'store'), place('Campus Gym', 'campus'), place('Maple Street Flat', 'home'), place('Corner Pharmacy', 'store'), place('Lakeview Hostel', 'other')];
const dues = [due('Library card renewal', 'document', '2026-02-10'), due('Gym membership', 'membership', '2026-03-01'), due('Renter insurance', 'insurance', '2026-04-15'),
    due('Lab safety certificate', 'license', '2026-05-20'), due('Bike registration', 'document', '2026-06-01'), due('Pharmacy refill', 'task', '2026-02-28')];
const hubs = c.prepare("SELECT id FROM entities WHERE name IN ('Tidal Mapping','Orchard Co-op','Night Sky Club','Bike Repair Collective','Language Exchange','Harbor Choir') ORDER BY id").all().map((r) => String(r.id));
const leafOf = (k, i) => String(c.prepare('SELECT to_id FROM links WHERE from_domain = ? AND from_id = ? AND to_domain = ? ORDER BY id LIMIT 1 OFFSET ?').get('entities', hubs[k], 'entities', i).to_id);
hubs.forEach((hub, k) => {
    const place2 = { domain: 'places', id: spots[k] };
    const due2 = { domain: 'deadlines', id: dues[k] };
    links.add(c, { from: ent(hub), to: place2, rel: 'about' }, 'seed');
    links.add(c, { from: ent(leafOf(k, 2)), to: place2, rel: 'member-of' }, 'seed');
    links.add(c, { from: ent(hub), to: due2, rel: 'for', note: 'renew before the date' }, 'seed');
    links.add(c, { from: ent(leafOf(k, 5)), to: due2, rel: 'related' }, 'seed');
    if (k < 5) links.add(c, { from: ent(hub), to: ent(hubs[k + 1]), rel: 'related' }, 'seed');
});
// Dated records for the timeline (all in 2026 and in the past (lifelog refuses the future), so the span is fixed): three lifelog episodes, a flight and
// two digests (one weekly, with a period id instead of a date), each linked to a cluster; entities, places and preferences stay undated.
const episode = (title, day, kind) => String(lifelog.createEpisode(c, { source: 'manual', kind, title, start_at: `${day}T18:30:00Z`, end_at: `${day}T19:10:00Z` }, 'seed').id);
const eps = [episode('Harbor walk', '2026-02-05', 'walk'), episode('Choir rehearsal', '2026-04-22', 'other'), episode('Study session', '2026-07-08', 'work')];
const flight = String(flights.create(c, { status: 'scheduled', source: 'manual', airline_iata: 'AA', airline_name: 'American', flight_number: '1203', origin_iata: 'LIT', dest_iata: 'DFW', sched_dep: '2026-04-10T14:00:00Z', sched_arr: '2026-04-10T15:10:00Z' }, 'seed').id);
digests.put(c, 'weekly', '2026-W20', { body: 'A quiet week.', source: 'generated', actor: 'seed' });
digests.put(c, 'daily', '2026-06-02', { body: 'A day.', source: 'generated', actor: 'seed' });
links.add(c, { from: ent(hubs[0]), to: { domain: 'lifelog', id: eps[0] }, rel: 'during' }, 'seed');
links.add(c, { from: ent(leafOf(5, 1)), to: { domain: 'lifelog', id: eps[1] }, rel: 'during' }, 'seed');
links.add(c, { from: ent(hubs[2]), to: { domain: 'lifelog', id: eps[2] }, rel: 'about' }, 'seed');
links.add(c, { from: ent(hubs[1]), to: { domain: 'flights', id: flight }, rel: 'related' }, 'seed');
links.add(c, { from: { domain: 'trips', id: trip2 }, to: { domain: 'flights', id: flight }, rel: 'during' }, 'seed');
links.add(c, { from: ent(hubs[3]), to: { domain: 'digests', id: 'weekly/2026-W20' }, rel: 'about' }, 'seed');
links.add(c, { from: ent(hubs[4]), to: { domain: 'digests', id: 'daily/2026-06-02' }, rel: 'about' }, 'seed');
// Every link was made "now"; spread their created_at over 2026 (one every two days, in the order they were made) so Links mode grows too.
c.prepare('SELECT id FROM links ORDER BY id').all().forEach((r, i) => c.prepare('UPDATE links SET created_at = ? WHERE id = ?').run(new Date(Date.UTC(2026, 0, 5) + i * 2 * 86400000).toISOString(), r.id));
console.log('graph seeded');
db.close();
