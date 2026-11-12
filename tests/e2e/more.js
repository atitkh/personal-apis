// Adds three more candidates to the SCRATCH database mid-run (for Accept all): two clean ones and one whose twin
// is created as a flight afterwards, so accepting it answers "already in your flights". Invented data only.
const { rel } = require('/e2e/dates.js');
const db = require('/app/db');
const flights = require('/app/services/flights');

const c = db.get();
const f = (n, o, d, dep, arr) => ({ airline_iata: 'AA', airline_name: 'American', flight_number: String(n), origin_iata: o, dest_iata: d, sched_dep: dep, sched_arr: arr, source: 'gmail', source_key: `g:more${n}`, confidence: 0.9 });
flights.suggest(c, f(3001, 'LIT', 'DFW', `${rel('2027-02-01')}T08:00`, `${rel('2027-02-01')}T09:25`), 'seed-job');
flights.suggest(c, f(3002, 'DFW', 'LIT', `${rel('2027-02-03')}T18:00`, `${rel('2027-02-03')}T19:25`), 'seed-job');
flights.suggest(c, f(3003, 'LIT', 'ORD', `${rel('2027-02-05')}T09:00`, `${rel('2027-02-05')}T10:55`), 'seed-job');
flights.create(c, { airline_iata: 'AA', flight_number: '3003', origin_iata: 'LIT', dest_iata: 'ORD', sched_dep: `${rel('2027-02-05')}T09:00`, sched_arr: `${rel('2027-02-05')}T10:55`, status: 'scheduled' }, 'seed');
console.log('candidates now', c.prepare("SELECT COUNT(*) n FROM flight_candidates WHERE status='pending'").get().n);
db.close();
