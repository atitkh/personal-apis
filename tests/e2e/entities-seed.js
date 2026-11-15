// Seeds a SCRATCH hub with invented entities and one trip for the Entities browser flow. Never use on real data.
const db = require('/app/db');
const entities = require('/app/services/entities');
const trips = require('/app/services/trips');
const c = db.get();
entities.create(c, { kind: 'person', name: 'Mira Delgado', aliases: ['MD', 'Mira'], notes: 'Lab partner from the invented university.' }, 'seed');
entities.create(c, { kind: 'project', name: 'Hub redesign', aliases: ['personal hub'] }, 'seed');
entities.create(c, { kind: 'organization', name: 'Example Foundation', notes: 'Funds the invented research visit.' }, 'seed');
trips.create(c, { title: 'Spring break', destination: 'Orlando', kind: 'leisure', start_date: '2099-01-20', end_date: '2099-01-27' }, 'seed');
console.log('entities seeded');
db.close();
