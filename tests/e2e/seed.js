// Seeds a SCRATCH hub database with invented flights and candidates for the dashboard browser checks.
// Run inside a throwaway node:20 container with the repo mounted at /app and HUB_DATA_DIR pointing at scratch:
//   run through run-all.mjs (it starts a scratch hub and executes this file inside a node:20 container, repo copy at /app).
// Everything here is made up. Never point it at production data.
const { rel } = require('/e2e/dates.js');
const fs = require('fs');
const db = require('/app/db');
const flights = require('/app/services/flights');

const c = db.get();
const add = (o) => flights.create(c, { status: 'completed', source: 'manual', ...o }, 'seed');
const past = [
    { airline_iata: 'AA', airline_name: 'American', flight_number: '1203', origin_iata: 'LIT', dest_iata: 'DFW', sched_dep: '2024-12-20T08:10', sched_arr: '2024-12-20T09:35', aircraft_type: 'B738', booking_ref: 'ZK9QWE', hours: 85 / 60 },
    { airline_iata: 'AA', airline_name: 'American', flight_number: '100', origin_iata: 'DFW', dest_iata: 'LHR', sched_dep: '2024-12-20T17:30', sched_arr: '2024-12-21T08:30', aircraft_type: 'B77W', hours: 9 },
    { airline_iata: 'UA', airline_name: 'United', flight_number: '77', origin_iata: 'JFK', dest_iata: 'KTM', sched_dep: '2025-06-02T22:00', sched_arr: '2025-06-04T05:00', aircraft_type: 'B789', hours: 21.25 },
    { airline_iata: 'UA', airline_name: 'United', flight_number: '78', origin_iata: 'KTM', dest_iata: 'ORD', sched_dep: '2025-08-14T02:00', sched_arr: '2025-08-14T16:00', aircraft_type: 'B789', hours: 24.75 },
    { airline_iata: 'AA', airline_name: 'American', flight_number: '1412', origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: '2025-09-01T10:00', sched_arr: '2025-09-01T11:25', hours: 85 / 60 },
    { airline_iata: 'AA', airline_name: 'American', flight_number: '1700', origin_iata: 'LIT', dest_iata: 'JFK', sched_dep: '2026-02-10T06:30', sched_arr: '2026-02-10T10:10', hours: 160 / 60 },
    { airline_iata: 'BA', airline_name: 'British Airways', flight_number: '112', origin_iata: 'JFK', dest_iata: 'LHR', sched_dep: '2026-02-14T19:00', sched_arr: '2026-02-15T07:00', aircraft_type: 'A35K', hours: 7 },
];
const flown = past.map(({ hours, ...f }) => { add(f); return hours; });
add({ airline_iata: 'AA', airline_name: 'American', flight_number: '52', origin_iata: 'DFW', dest_iata: 'ORD', sched_dep: '2025-11-03T07:00', sched_arr: '2025-11-03T09:20', status: 'cancelled' });
add({ airline_iata: 'AA', airline_name: 'American', flight_number: '1203', origin_iata: 'LIT', dest_iata: 'DFW', sched_dep: `${rel('2026-12-20')}T08:10`, sched_arr: `${rel('2026-12-20')}T09:35`, status: 'scheduled', booking_ref: 'PL4NE7' });
add({ airline_iata: 'AA', airline_name: 'American', flight_number: '1412', origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: `${rel('2026-12-22')}T18:00`, sched_arr: `${rel('2026-12-22')}T19:25`, status: 'scheduled' });
flights.putSettings(c, { home_airport: 'LIT' }, 'seed');

flights.suggest(c, { airline_iata: 'UA', airline_name: 'United', flight_number: '2210', origin_iata: 'ORD', dest_iata: 'LIT', sched_dep: `${rel('2027-01-15')}T09:00`, sched_arr: `${rel('2027-01-15')}T11:05`, source: 'gmail', source_key: 'g:seed1', confidence: 0.92, booking_ref: 'QW7ZXC' }, 'seed-job');
flights.suggest(c, { airline_iata: 'AA', airline_name: 'American', flight_number: '500', origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: `${rel('2027-01-20')}T18:00`, sched_arr: `${rel('2027-01-20')}T19:25`, source: 'calendar', source_key: 'c:seed2', confidence: 0.55 }, 'seed-job');

fs.writeFileSync(require('path').join(process.env.E2E_OUT || '/out', 'expected.json'), JSON.stringify({ flights: 7, hours: Math.round(flown.reduce((a, b) => a + b, 0) * 10) / 10, airports: 6, countries: 3, airlines: 3, aircraft_types: 4 }));
console.log('seeded', c.prepare('SELECT COUNT(*) n FROM flights').get().n, 'flights,', c.prepare('SELECT COUNT(*) n FROM flight_candidates').get().n, 'candidates');
db.close();
