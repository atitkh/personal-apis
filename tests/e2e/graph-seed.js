// Seeds a SCRATCH hub with invented entities, a trip and links for the Graph browser flow. Never use on real data.
const db = require('/app/db');
const entities = require('/app/services/entities');
const trips = require('/app/services/trips');
const links = require('/app/services/links');
const places = require('/app/services/places');
const deadlines = require('/app/services/deadlines');
const c = db.get();
const e = (kind, name) => String(entities.create(c, { kind, name }, 'seed').id);
const mira = e('person', 'Mira Delgado');
const proj = e('project', 'Hub redesign');
const org = e('organization', 'Example Foundation');
const topic = e('topic', 'Tides');
e('person', 'Loner Vance');
const trip = String(trips.create(c, { title: 'Spring break', destination: 'Orlando', kind: 'leisure', start_date: '2099-01-20', end_date: '2099-01-27' }, 'seed').id);
const ent = (id) => ({ domain: 'entities', id });
links.add(c, { from: ent(mira), to: ent(proj), rel: 'works-on' }, 'seed');
links.add(c, { from: ent(proj), to: ent(org), rel: 'part-of' }, 'seed');
links.add(c, { from: ent(org), to: ent(topic), rel: 'about' }, 'seed');
links.add(c, { from: ent(mira), to: { domain: 'trips', id: trip }, rel: 'about' }, 'seed');
// Six invented clusters (a hub and its members) so the whole-graph overview has something to lay out.
const trip2 = String(trips.create(c, { title: 'Field week', destination: 'Tampa', kind: 'leisure', start_date: '2099-03-02', end_date: '2099-03-08' }, 'seed').id);
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
const dues = [due('Library card renewal', 'document', '2099-02-10'), due('Gym membership', 'membership', '2099-03-01'), due('Renter insurance', 'insurance', '2099-04-15'),
    due('Lab safety certificate', 'license', '2099-05-20'), due('Bike registration', 'document', '2099-06-01'), due('Pharmacy refill', 'task', '2099-02-28')];
const hubs = c.prepare("SELECT id FROM entities WHERE name IN ('Tidal Mapping','Orchard Co-op','Night Sky Club','Bike Repair Collective','Language Exchange','Harbor Choir') ORDER BY id").all().map((r) => String(r.id));
const leafOf = (k, i) => String(c.prepare('SELECT to_id FROM links WHERE from_domain = ? AND from_id = ? AND to_domain = ? ORDER BY id LIMIT 1 OFFSET ?').get('entities', hubs[k], 'entities', i).to_id);
hubs.forEach((hub, k) => {
    const place2 = { domain: 'places', id: spots[k] };
    const due2 = { domain: 'deadlines', id: dues[k] };
    links.add(c, { from: ent(hub), to: place2, rel: 'about' }, 'seed');
    links.add(c, { from: ent(leafOf(k, 2)), to: place2, rel: 'related' }, 'seed');
    links.add(c, { from: ent(hub), to: due2, rel: 'about' }, 'seed');
    links.add(c, { from: ent(leafOf(k, 5)), to: due2, rel: 'related' }, 'seed');
    if (k < 5) links.add(c, { from: ent(hub), to: ent(hubs[k + 1]), rel: 'related' }, 'seed');
});
console.log('graph seeded');
db.close();
