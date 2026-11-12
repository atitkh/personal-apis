// Adds three future flights with data-source observations to the SCRATCH database (run after reset.sh, hub running).
// Invented data only. Writes the ids to /e2e/sources-ids.json for run-sources.mjs.
const fs = require('fs');
const db = require('/app/db');
const flights = require('/app/services/flights');
const enrich = require('/app/services/enrich');

const c = db.get();
const mk = (n, o, d, dep, arr) => flights.create(c, { airline_iata: 'AA', airline_name: 'American', flight_number: String(n), origin_iata: o, dest_iata: d, sched_dep: dep, sched_arr: arr, status: 'scheduled', source: 'manual' }, 'seed').id;
const live = mk(8801, 'LIT', 'DFW', '2026-12-24T08:10', '2026-12-24T09:35');
const cancelled = mk(8802, 'DFW', 'LIT', '2026-12-26T18:00', '2026-12-26T19:25');
const plain = mk(8803, 'LIT', 'ORD', '2026-12-28T09:00', '2026-12-28T10:55');
enrich.observe(c, live, 'aerodatabox', {
    est_dep: '2026-12-24T14:35:00Z', est_arr: '2026-12-24T16:00:00Z', dep_terminal: 'B', dep_gate: 'B12', arr_terminal: 'C', arr_gate: 'C27',
    baggage_belt: '4', delay_min: 25, aircraft_type: 'B738', aircraft_reg: 'N123AA',
}, { source_status: 'Expected', actor: 'seed' });
enrich.observe(c, cancelled, 'gmail', {}, { source_status: 'cancelled', actor: 'seed' });
for (const id of [live, cancelled]) console.log(id, JSON.stringify(enrich.applyObservations(c, id, 'seed')).slice(0, 200));
fs.writeFileSync('/e2e/sources-ids.json', JSON.stringify({ live, cancelled, plain }));
const g = flights.get(c, live);
console.log('live', g.delay_min, g.dep_gate, g.locked_fields.join(','), 'cancelled chip', flights.get(c, cancelled).source_says_cancelled);
db.close();
