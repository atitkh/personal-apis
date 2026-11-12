// Seeds a SCRATCH hub with invented preferences. Never use on real data.
const db = require('/app/db');
const prefs = require('/app/services/preferences');
const c = db.get();
const add = (o) => prefs.create(c, o, 'seed');
add({ area: 'travel', key: 'airline_seat', value: 'aisle', notes: 'Near the front when possible.' });
add({ area: 'travel', key: 'preferred_airline', value: 'American' });
add({ area: 'communication', key: 'call_hours', value: 'No calls before 10 am' });
add({ area: 'communication', key: 'contact_email', value: 'friend.example@example.com' });
add({ area: 'food', key: 'allergy', value: 'peanuts', notes: 'Carry the pen.' });
add({ area: 'work', key: 'meeting_length', value: '25 minutes by default' });
const old = add({ area: 'devices', key: 'phone_brand', value: 'Pixel' });
prefs.unset(c, old.id, 'seed');
console.log('preferences seeded');
db.close();
