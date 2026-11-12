// Seeds a SCRATCH hub with invented data for the Today card: flights relative to now, a source-cancelled flight,
// found flights, a place suggestion and an old daily digest (so yesterday's is missing). Never use on real data.
const { rel } = require('/e2e/dates.js');
const db = require('/app/db');
const flights = require('/app/services/flights');
const digests = require('/app/services/digests');
const enrich = require('/app/services/enrich');
const c = db.get();
const at = (days, hour = 15) => new Date(Date.now() + days * 86400000 + (hour - 12) * 3600000).toISOString().slice(0, 19);
const add = (o) => flights.create(c, { status: 'scheduled', source: 'manual', ...o }, 'seed');
add({ airline_iata: 'CX', airline_name: 'Cathay Pacific', flight_number: '891', origin_iata: 'DFW', dest_iata: 'HKG', sched_dep: `${at(3)}Z`, sched_arr: `${at(3.6)}Z`, booking_ref: 'QZ7RK2' });
add({ airline_iata: 'AA', airline_name: 'American', flight_number: '1203', origin_iata: 'LIT', dest_iata: 'DFW', sched_dep: `${at(20)}Z`, sched_arr: `${at(20.1)}Z` });
add({ airline_iata: 'UA', airline_name: 'United', flight_number: '77', origin_iata: 'JFK', dest_iata: 'KTM', sched_dep: `${at(45)}Z`, sched_arr: `${at(45.5)}Z` });
const gone = add({ airline_iata: 'AA', airline_name: 'American', flight_number: '52', origin_iata: 'DFW', dest_iata: 'ORD', sched_dep: `${at(8)}Z`, sched_arr: `${at(8.1)}Z` });
enrich.observe(c, gone.id, 'aerodatabox', {}, { source_status: 'cancelled', actor: 'seed' });
flights.suggest(c, { airline_iata: 'UA', flight_number: '2210', origin_iata: 'ORD', dest_iata: 'LIT', sched_dep: `${rel('2027-01-15')}T09:00`, sched_arr: `${rel('2027-01-15')}T11:05`, source: 'gmail', source_key: 'g:1' }, 'seed');
flights.suggest(c, { airline_iata: 'AA', flight_number: '500', origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: `${rel('2027-01-20')}T18:00`, sched_arr: `${rel('2027-01-20')}T19:25`, source: 'gmail', source_key: 'g:2' }, 'seed');
const now = new Date().toISOString();
c.prepare("INSERT INTO place_suggestions (street, count, first_seen, last_seen, status) VALUES ('Maple Ridge Dr', 2, ?, ?, 'pending')").run(now, now);
digests.put(c, 'daily', '2020-01-01', { body: 'Old.', source: 'generated', actor: 'seed' });
console.log('briefing seeded');
db.close();
