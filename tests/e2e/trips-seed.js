// Seeds a SCRATCH hub with invented trips and flights for the Trips browser flow (dates relative to today). Never use on real data.
const { rel } = require('/e2e/dates.js');
const db = require('/app/db');
const flights = require('/app/services/flights');
const trips = require('/app/services/trips');
const items = require('/app/services/tripItems');

const c = db.get();
const fl = (o) => flights.create(c, { airline_iata: 'AA', airline_name: 'American', status: 'scheduled', source: 'manual', ...o }, 'seed');
const at = (d, hm) => `${rel(d)}T${hm}`;
flights.putSettings(c, { home_airport: 'LIT' }, 'seed');

// Spring break: upcoming, one flight on it, one item with a reference.
const spring = trips.create(c, { title: 'Spring break', destination: 'Orlando', kind: 'leisure', start_date: rel('2027-01-20'), end_date: rel('2027-01-27') }, 'seed');
const f500 = fl({ flight_number: '500', origin_iata: 'LIT', dest_iata: 'MCO', sched_dep: at('2027-01-20', '08:00'), sched_arr: at('2027-01-20', '11:00') });
trips.linkFlight(c, spring.id, f500.id, 'seed');
items.add(c, spring.id, { kind: 'stay', title: 'Beach hotel', place: 'Orlando', start_date: rel('2027-01-20'), end_date: rel('2027-01-27'), reference: 'HTL-INVENTED-77' }, 'seed');

// Ongoing: started yesterday, ends in 3 days.
const now = new Date();
const shift = (n) => new Date(now.getTime() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
trips.create(c, { title: 'Conference week', destination: 'Austin', kind: 'conference', start_date: shift(-1), end_date: shift(3) }, 'seed');

// Past and cancelled.
trips.create(c, { title: 'Old research visit', kind: 'research', start_date: '2025-02-03', end_date: '2025-02-09' }, 'seed');
trips.create(c, { title: 'Called off trip', kind: 'family', start_date: rel('2027-02-20'), end_date: rel('2027-02-22'), status_override: 'cancelled' }, 'seed');

// A flight on no trip (for the picker), and a home chain of two flights (becomes a suggestion).
fl({ flight_number: '900', origin_iata: 'LIT', dest_iata: 'SEA', sched_dep: at('2027-06-01', '09:00'), sched_arr: at('2027-06-01', '12:00') });
fl({ flight_number: '700', origin_iata: 'LIT', dest_iata: 'ORD', sched_dep: at('2027-03-10', '07:00'), sched_arr: at('2027-03-10', '08:45') });
fl({ flight_number: '701', origin_iata: 'ORD', dest_iata: 'LIT', sched_dep: at('2027-03-14', '17:00'), sched_arr: at('2027-03-14', '18:50') });
console.log('trips seeded');
db.close();
