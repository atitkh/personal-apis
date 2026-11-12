// Seeds a SCRATCH hub for the delete browser checks (run-delete.mjs): one entry per domain to delete, plus extras
// for the guards. Everything is invented. Never use on real data.
const { rel } = require('/e2e/dates.js');
const db = require('/app/db');
const flights = require('/app/services/flights');
const places = require('/app/services/places');
const deadlines = require('/app/services/deadlines');
const preferences = require('/app/services/preferences');
const digests = require('/app/services/digests');
const { today } = require('/app/services/briefing');
const c = db.get();
const t = today(new Date());

// flights: a plain one with revisions + observations, one from an accepted Gmail candidate, a trip with 2 flights
flights.putSettings(c, { home_airport: 'LIT' }, 'seed');
const f1 = flights.create(c, { airline_iata: 'AA', airline_name: 'American', flight_number: '500', origin_iata: 'DFW', dest_iata: 'LIT', sched_dep: `${rel('2027-02-10')}T18:00`, sched_arr: `${rel('2027-02-10')}T19:25`, status: 'scheduled', booking_ref: 'SECRETREF1' }, 'seed');
flights.update(c, f1.id, { seat: '14A' }, 'seed');
c.prepare("INSERT INTO flight_observations (flight_id, source, fetched_at, ok, fields, actor) VALUES (?, 'aerodatabox', `${rel('2027-02-09')}T00:00:00Z`, 1, '{}', 'seed')").run(f1.id);
const cg = flights.suggest(c, { airline_iata: 'UA', airline_name: 'United', flight_number: '2210', origin_iata: 'ORD', dest_iata: 'LIT', sched_dep: `${rel('2027-03-15')}T09:00`, sched_arr: `${rel('2027-03-15')}T11:05`, source: 'gmail', source_key: 'g:del1', confidence: 0.9 }, 'job').candidate;
flights.acceptCandidate(c, cg.id, null, 'admin');
const trip = flights.createTrip(c, { title: 'Spring break' }, 'seed');
flights.create(c, { airline_iata: 'DL', airline_name: 'Delta', flight_number: '10', origin_iata: 'ATL', dest_iata: 'LHR', sched_dep: `${rel('2027-04-01')}T20:00`, sched_arr: `${rel('2027-04-02')}T10:00`, status: 'scheduled', trip_id: trip.id }, 'seed');
flights.create(c, { airline_iata: 'DL', airline_name: 'Delta', flight_number: '11', origin_iata: 'LHR', dest_iata: 'ATL', sched_dep: `${rel('2027-04-08')}T12:00`, sched_arr: `${rel('2027-04-08')}T16:00`, status: 'scheduled', trip_id: trip.id }, 'seed');
// found flights: 1 pending, 3 dismissed
const cand = (n, o = {}) => flights.suggest(c, { airline_iata: 'WN', airline_name: 'Southwest', flight_number: String(n), origin_iata: 'DAL', dest_iata: 'LIT', sched_dep: `2027-05-${10 + n}T09:00`, sched_arr: `2027-05-${10 + n}T10:10`, source: 'gmail', source_key: `g:w${n}`, confidence: 0.8, ...o }, 'job').candidate;
cand(1);
for (const n of [2, 3, 4]) flights.dismissCandidate(c, cand(n).id, 'admin');

// places: one with rules, queue spots (1 pending, 2 dismissed)
places.create(c, { label: 'Pottery studio', kind: 'other', rules: [{ type: 'street', value: 'Quillfeather Lane' }, { type: 'street', value: 'Elm Row', exclude: true }] }, 'admin');
const sp = (street) => places.resolve(c, { geocode: street, suggest: true }).suggestion;
sp('1 Alpha Road');
for (const s of ['2 Beta Road', '3 Gamma Road']) places.dismissSuggestion(c, sp(s).id, 'admin');

// deadlines: one active, one done
const d1 = deadlines.create(c, { title: 'Library card', kind: 'document', due_date: deadlines.addDays(t, 30), reference: 'LC-INVENTED' }, 'seed');
const d2 = deadlines.create(c, { title: 'Washer warranty claim', kind: 'task', due_date: deadlines.addDays(t, -30), lead_days: 7, urgent_days: 2 }, 'seed');
deadlines.done(c, d2.id, 'seed');
deadlines.create(c, { title: 'Keep me', kind: 'task', due_date: deadlines.addDays(t, 20) }, 'seed');

// preferences: one live, one removed
preferences.create(c, { area: 'travel', key: 'airline seat', value: 'aisle' }, 'seed');
const gone = preferences.create(c, { area: 'food', key: 'spice level', value: 'mild' }, 'seed');
preferences.unset(c, gone.id, 'seed');
preferences.create(c, { area: 'work', key: 'standup time', value: '9:30' }, 'seed');

// digests: a past day
digests.put(c, 'daily', '2026-03-01', { body: 'A quiet day.\n\nNothing else happened.', source: 'generated', actor: 'seed' });
digests.put(c, 'daily', '2026-03-02', { body: 'Another quiet day.', source: 'generated', actor: 'seed' });
console.log('seeded delete scratch');
db.close();
