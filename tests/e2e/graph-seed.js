// Seeds a SCRATCH hub with invented entities, a trip and links for the Graph browser flow. Never use on real data.
const db = require('/app/db');
const entities = require('/app/services/entities');
const trips = require('/app/services/trips');
const links = require('/app/services/links');
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
for (let k = 0; k < 6; k += 1) {
    const hub = e('topic', `Cluster ${'ABCDEF'[k]}`);
    const leaves = [];
    for (let i = 0; i < 14; i += 1) {
        const leaf = e(i % 3 ? 'person' : 'project', `Member ${'ABCDEF'[k]}${i + 1}`);
        leaves.push(leaf);
        links.add(c, { from: ent(hub), to: ent(leaf), rel: 'related' }, 'seed');
        if (i > 0 && i % 4 === 0) links.add(c, { from: ent(leaves[i - 1]), to: ent(leaf), rel: 'related' }, 'seed');
    }
    if (k % 3 === 0) links.add(c, { from: ent(hub), to: { domain: 'trips', id: k ? trip2 : trip }, rel: 'about' }, 'seed');
}
console.log('graph seeded');
db.close();
