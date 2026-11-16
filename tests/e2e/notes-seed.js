// Seeds a SCRATCH hub with invented entities, a trip and three notes for the Notes browser flow. Never use on real data.
const db = require('/app/db');
const entities = require('/app/services/entities');
const trips = require('/app/services/trips');
const notes = require('/app/services/notes');
const c = db.get();
entities.create(c, { kind: 'person', name: 'Mira Delgado', aliases: ['MD', 'Mira'], notes: 'Lab partner from the invented university.' }, 'seed');
entities.create(c, { kind: 'project', name: 'Hub redesign', aliases: ['personal hub'] }, 'seed');
trips.create(c, { title: 'Spring break', destination: 'Orlando', kind: 'leisure', start_date: '2099-01-20', end_date: '2099-01-27' }, 'seed');
notes.create(c, { title: 'Seed bank', body: 'Beans, peas and kale for the greenhouse.', tags: ['garden'] }, 'admin');
notes.create(c, {
    title: 'Greenhouse plan', kind: 'note', pinned: true, tags: ['garden', 'plans'],
    body: '# Greenhouse\n\nUses [[Seed bank]] and [[Mira Delgado|Mira]].\n\n- [ ] buy glass\n- [x] measure the roof\n\nStill to write: [[Ghost page]].',
}, 'admin');
notes.create(c, { title: 'Standup notes', kind: 'meeting', tags: ['work'], body: 'Talked about the **Hub redesign** project.' }, 'agent-x');
console.log('notes seeded');
db.close();
