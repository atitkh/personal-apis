// Seeds a SCRATCH hub with invented flights that carry ACTUAL times (for the Punctuality checks) and writes the
// expected numbers, computed here by plain arithmetic, to $E2E_OUT/expected-passport.json. Never run against real data.
const fs = require('fs');
const db = require('/app/db');
const flights = require('/app/services/flights');

const c = db.get();
const min = (s) => Date.parse(`${s}:00Z`) / 60000; // local strings compared in the same zone: plain difference
// [airline, name, number, from, to, sched_dep, sched_arr, actual_arr (or null), delay minutes expected]
const rows = [
    ['AA', 'American', '1203', 'LIT', 'DFW', '2024-12-20T08:10', '2024-12-20T09:35', '2024-12-20T09:50'],
    ['AA', 'American', '100', 'DFW', 'LHR', '2024-12-20T17:30', '2024-12-21T08:30', '2024-12-21T09:10'],
    ['UA', 'United', '77', 'JFK', 'KTM', '2025-06-02T22:00', '2025-06-04T05:00', '2025-06-04T04:40'],
    ['UA', 'United', '78', 'KTM', 'ORD', '2025-08-14T02:00', '2025-08-14T16:00', null],
    ['AA', 'American', '1412', 'DFW', 'LIT', '2025-09-01T10:00', '2025-09-01T11:25', '2025-09-01T11:39'],
    ['AA', 'American', '1700', 'LIT', 'JFK', '2026-02-10T06:30', '2026-02-10T10:10', '2026-02-10T11:40'],
    ['BA', 'British Airways', '112', 'JFK', 'LHR', '2026-02-14T19:00', '2026-02-15T07:00', '2026-02-15T07:00'],
];
const delays = [];
const ids = {};
for (const [al, name, no, o, d, dep, arr, act] of rows) {
    const f = flights.create(c, {
        airline_iata: al, airline_name: name, flight_number: no, origin_iata: o, dest_iata: d, sched_dep: dep, sched_arr: arr,
        actual_dep: act ? dep : null, actual_arr: act, status: 'completed', source: 'manual',
    }, 'seed');
    ids[no] = f.id;
    if (act) delays.push({ al, no, o, d, date: dep.slice(0, 10), delay: min(act) - min(arr) });
}
flights.create(c, { airline_iata: 'AA', airline_name: 'American', flight_number: '52', origin_iata: 'DFW', dest_iata: 'ORD', sched_dep: '2025-11-03T07:00', sched_arr: '2025-11-03T09:20', status: 'cancelled', source: 'manual' }, 'seed');
flights.create(c, { airline_iata: 'AA', airline_name: 'American', flight_number: '1203', origin_iata: 'LIT', dest_iata: 'DFW', sched_dep: '2026-12-20T08:10', sched_arr: '2026-12-20T09:35', status: 'scheduled', source: 'manual' }, 'seed');
flights.putSettings(c, { home_airport: 'LIT' }, 'seed');

const sum = (a) => a.reduce((x, y) => x + y, 0);
const summarise = (list) => ({
    measured: list.length,
    onTime: Math.round((list.filter((x) => x.delay <= 15).length / list.length) * 100),
    avg: Math.round(sum(list.map((x) => x.delay)) / list.length),
    lost: sum(list.map((x) => Math.max(0, x.delay))),
});
const worst = delays.reduce((a, b) => (b.delay > a.delay ? b : a));
const aa = delays.filter((x) => x.al === 'AA');
const y25 = delays.filter((x) => x.date.startsWith('2025'));
fs.writeFileSync(require('path').join(process.env.E2E_OUT || '/out', 'expected-passport.json'), JSON.stringify({
    all: { ...summarise(delays), of: 7, worst: { ...worst, id: ids[worst.no] }, aa: summarise(aa), cancelled: 1 },
    y2025: { ...summarise(y25), of: 3 },
    ids,
}));
console.log('seeded', c.prepare('SELECT COUNT(*) n FROM flights').get().n, 'flights; delays', delays.map((x) => x.delay).join(','));
db.close();
