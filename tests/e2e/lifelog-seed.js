// Seeds a SCRATCH hub with invented lifelog observations and episodes for the Lifelog browser flow (today and
// yesterday in the hub zone, plus three old lines from another source for the Forget flow). Never use on real data.
const db = require('/app/db');
const lifelog = require('/app/services/lifelog');
const { hubTz, todayIn } = require('/app/services/lib/tz');

const c = db.get();
const tz = hubTz(c);
const today = todayIn(tz, new Date());
const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
const offsetAt = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
};
const at = (date, hm) => {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = hm.split(':').map(Number);
    const g = Date.UTC(y, m - 1, d, hh, mm);
    let t = g - offsetAt(g);
    t = g - offsetAt(t);
    return new Date(t).toISOString();
};

const lines = [
    ['glasses', today, '07:45', 'eat', 'plate with eggs and toast on the kitchen table', 'kitchen'],
    ['glasses', today, '08:10', 'eat', 'coffee mug beside a laptop', 'kitchen'],
    ['camera-node', today, '12:40', 'eat', 'a bowl of biryani <script>window.__xss = 1</script> and <b>bold</b> rice', 'kitchen'],
    ['camera-node', today, '13:05', 'eat', 'empty bowl on the counter', 'kitchen'],
    ['mmwave', today, '15:00', 'sit', 'seated at desk for 20 minutes', null],
    ['mmwave', today, '15:20', 'sit', 'seated at desk for 40 minutes', null],
    ['voice', today, '18:30', 'walk', 'walked around the block with the dog', null],
    ['glasses', yesterday, '09:00', 'work', 'reading a paper at the desk', null],
    ['camera-node', yesterday, '21:00', 'see', 'watching a film on the sofa', 'living room'],
    ['oldcam', '2026-10-01', '09:00', 'see', 'old line one', null],
    ['oldcam', '2026-10-01', '10:00', 'see', 'old line two', null],
    ['oldcam', '2026-10-01', '11:00', 'see', 'old line three', null],
];
const out = lifelog.push(c, null, lines.map(([source, d, hm, kind, text, place]) => ({ source, at: at(d, hm), kind, text, ...(place ? { place } : {}) })), { anySource: true });
if (out.rejected.length) throw new Error(`seed rejected: ${JSON.stringify(out.rejected)}`);

const ep = (o) => lifelog.createEpisode(c, { source: 'manual', ...o }, 'seed');
ep({ kind: 'eat', title: 'Ate breakfast', start_at: at(today, '07:45'), end_at: at(today, '08:20'), place: 'kitchen' });
ep({ kind: 'eat', title: 'Ate lunch', start_at: at(today, '12:40'), end_at: at(today, '13:05'), place: 'kitchen', detail: 'biryani with rice' });
ep({ kind: 'sleep', title: 'Cancelled nap', start_at: at(today, '14:00'), end_at: at(today, '14:30'), status: 'cancelled' });
ep({ kind: 'work', title: 'Desk work', start_at: at(today, '14:30'), end_at: at(today, '16:30'), confidence: 0.6 });
ep({ kind: 'walk', title: 'Evening walk', start_at: at(today, '18:30'), end_at: at(today, '19:00'), confidence: 0.8 });
console.log('lifelog seeded');
db.close();
