// Adds three future flights with data-source observations to the SCRATCH database (run after reset.sh, hub running).
// Invented data only. Writes the ids to $E2E_OUT/sources-ids.json for run-sources.mjs.
const fs = require('fs');
const db = require('/app/db');
const flights = require('/app/services/flights');
const enrich = require('/app/services/enrich');

const c = db.get();
// Dates are relative to today so the flights stay in the future (the Live details block only shows for upcoming flights).
// Wall-clock times are America/Chicago (the airports LIT, DFW, ORD all sit in it); the estimate is stored as UTC.
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const chicagoUtc = (date, hhmm) => {
    const want = Date.parse(`${date}T${hhmm}:00Z`);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const parts = (t) => Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]));
    const shown = (t) => { const q = parts(t); return Date.parse(`${q.year}-${q.month}-${q.day}T${q.hour}:${q.minute}:00Z`); };
    const utc = want - (shown(want) - want);
    return new Date(utc).toISOString().replace('.000Z', 'Z');
};
const mk = (n, o, d, dep, arr) => flights.create(c, { airline_iata: 'AA', airline_name: 'American', flight_number: String(n), origin_iata: o, dest_iata: d, sched_dep: dep, sched_arr: arr, status: 'scheduled', source: 'manual' }, 'seed').id;
const d1 = day(30); const d2 = day(32); const d3 = day(34);
const live = mk(8801, 'LIT', 'DFW', `${d1}T08:10`, `${d1}T09:35`);
const cancelled = mk(8802, 'DFW', 'LIT', `${d2}T18:00`, `${d2}T19:25`);
const plain = mk(8803, 'LIT', 'ORD', `${d3}T09:00`, `${d3}T10:55`);
enrich.observe(c, live, 'aerodatabox', {
    est_dep: chicagoUtc(d1, '08:35'), est_arr: chicagoUtc(d1, '10:00'), dep_terminal: 'B', dep_gate: 'B12', arr_terminal: 'C', arr_gate: 'C27',
    baggage_belt: '4', delay_min: 25, aircraft_type: 'B738', aircraft_reg: 'N123AA',
}, { source_status: 'Expected', actor: 'seed' });
enrich.observe(c, cancelled, 'gmail', {}, { source_status: 'cancelled', actor: 'seed' });
for (const id of [live, cancelled]) console.log(id, JSON.stringify(enrich.applyObservations(c, id, 'seed')).slice(0, 200));
fs.writeFileSync(require('path').join(process.env.E2E_OUT || '/out', 'sources-ids.json'), JSON.stringify({ live, cancelled, plain, est_dep_input: `${d1}T08:35` }));
const g = flights.get(c, live);
console.log('live', g.delay_min, g.dep_gate, g.locked_fields.join(','), 'cancelled chip', flights.get(c, cancelled).source_says_cancelled);
db.close();
