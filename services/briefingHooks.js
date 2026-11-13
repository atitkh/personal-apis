// The first briefing hooks (see services/briefing.js). Each returns { attention, upcoming } and may throw: the
// collector skips a hook that does. Text carries no booking reference, address or name: flights say airline
// code + number, airport codes and dates; places and digests say only counts and dates.
const { today, dayDiff } = require('./briefing');
const { hubTz } = require('./lib/tz');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

function inDays(n) {
    if (n <= 0) return 'today';
    if (n === 1) return 'tomorrow';
    return `in ${n} days`;
}

function flights(db, { now, days }) {
    const svc = require('./flights');
    const attention = [];
    const upcoming = [];
    const found = svc.candidateCounts(db).pending;
    if (found > 0) {
        attention.push({
            id: 'flights:candidates:pending',
            severity: 'attention',
            text: `${plural(found, 'found flight')} ${found === 1 ? 'waits' : 'wait'} for review`,
        });
    }
    const todayLocal = today(now, hubTz(db));
    const nowMs = now.getTime();
    // Airport-local dates drive the wording; the horizon counts calendar days from today in the briefing's zone.
    for (const f of svc.upcoming(db, { now, limit: 50 })) {
        const label = `${f.airline_iata} ${f.flight_number} ${f.origin_iata} to ${f.dest_iata}`;
        const ref = { domain: 'flights', id: f.id };
        if (f.source_says_cancelled) {
            attention.push({
                id: `flights:${f.id}:source-cancelled-${f.dep_local_date}`,
                severity: 'urgent',
                text: `${label} on ${f.dep_local_date}: a source says it is cancelled`,
                date: f.dep_local_date,
                ref,
            });
            continue;
        }
        if (Date.parse(f.sched_dep) < nowMs) continue; // already departed (in the air)
        const away = dayDiff(todayLocal, f.dep_local_date);
        if (away > days) continue;
        upcoming.push({
            id: `flights:${f.id}:departs-${f.dep_local_date}`,
            severity: 'info',
            text: `${label} departs ${inDays(away)} (${f.dep_local_date})`,
            date: f.dep_local_date,
            ref,
        });
    }
    return { attention, upcoming };
}

function places(db) {
    const waiting = require('./places').suggestionCounts(db).pending;
    if (!waiting) return { attention: [], upcoming: [] };
    return {
        attention: [{
            id: 'places:suggestions:pending',
            severity: 'attention',
            text: `${plural(waiting, 'spot')} ${waiting === 1 ? 'needs' : 'need'} a name`,
        }],
        upcoming: [],
    };
}

function digests(db, { now }) {
    const w = require('./adminStats').digestWatch(db, now);
    if (!w.missing) return { attention: [], upcoming: [] };
    return {
        attention: [{
            id: `digests:missing:${w.expectedDaily}`,
            severity: 'attention',
            text: `The daily digest for ${w.expectedDaily} has not arrived`,
            date: w.expectedDaily,
        }],
        upcoming: [],
    };
}

// Active deadlines. Each item has its own windows (lead_days, urgent_days): overdue or inside the urgent window is
// urgent, inside the lead window is attention (both go to `attention`), and an item due inside the briefing
// horizon but outside its lead window is info under `upcoming`. Text has the title (written by Atit) and dates
// only: never the reference, amount or notes.
function deadlines(db, { now, days }) {
    const svc = require('./deadlines');
    const attention = [];
    const upcoming = [];
    // 730 is the largest lead_days, so this reaches every item that could be in a window.
    for (const d of svc.upcoming(db, { days: 730, limit: svc.LIST_MAX, now })) {
        const ref = { domain: 'deadlines', id: d.id };
        const base = `deadlines:${d.id}:due-${d.due_date}`;
        if (d.overdue) {
            attention.push({ id: `${base}:overdue`, severity: 'urgent', text: `Overdue: ${d.title} (was due ${d.due_date})`, date: d.due_date, ref });
            continue;
        }
        const left = d.days_left;
        const text = `${d.title} due ${left === 0 ? 'today' : `in ${plural(left, 'day')}`} (${d.due_date})`;
        if (d.window === 'urgent') attention.push({ id: base, severity: 'urgent', text, date: d.due_date, ref });
        else if (d.window === 'attention') attention.push({ id: base, severity: 'attention', text, date: d.due_date, ref });
        else if (left <= days) upcoming.push({ id: base, severity: 'info', text, date: d.due_date, ref });
    }
    return { attention, upcoming };
}

// Trips (plan decision 7). Ongoing trips and trips starting inside the horizon are info under `upcoming`; a trip that
// starts within 14 days with a linked active deadline that is overdue or due on or before its start is attention
// (urgent when the deadline is overdue or due within 3 days). Ids carry the start date (and the deadline id), so a
// changed title keeps the id and moved dates make a new one. Text: the trip's destination (else title), the
// deadline title and dates only: never references, notes, places, booking codes or money. Cancelled and past
// trips and undated trips give nothing.
const TRIP_DEADLINE_DAYS = 14;
const TRIP_URGENT_DAYS = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

function trips(db, { now, days }) {
    const svc = require('./trips');
    const attention = [];
    const upcoming = [];
    const todayLocal = today(now, hubTz(db));
    const rows = db.prepare(`SELECT * FROM trips WHERE COALESCE(start_date, end_date) IS NOT NULL
        AND (status_override IS NULL OR status_override != 'cancelled') ORDER BY COALESCE(start_date, end_date), id`).all();
    const pending = db.prepare(`SELECT id, title, due_date FROM deadlines WHERE trip_id = ? AND status = 'active' ORDER BY due_date, id`);
    for (const r of rows) {
        const t = svc.timing(r, todayLocal);
        const start = r.start_date || r.end_date;
        const end = r.end_date || r.start_date;
        const name = r.destination || r.title;
        const ref = { domain: 'trips', id: r.id };
        if (t.phase === 'ongoing') {
            const total = dayDiff(start, end) + 1;
            const day = dayDiff(start, todayLocal) + 1;
            const text = total === 1 ? `${name}: today, a one-day trip` : `${name}: day ${day} of ${total}, back ${shortDate(end)}`;
            upcoming.push({ id: `trips:${r.id}:ongoing-${start}`, severity: 'info', text, date: start, ref });
            continue;
        }
        if (t.phase !== 'upcoming') continue;
        const away = t.days_to_start;
        if (away <= days) {
            upcoming.push({ id: `trips:${r.id}:starts-${start}`, severity: 'info', text: `${name} starts ${inDays(away)} (${shortDate(start)})`, date: start, ref });
        }
        if (away > TRIP_DEADLINE_DAYS) continue;
        for (const d of pending.all(r.id)) {
            if (d.due_date > start) continue;
            const left = dayDiff(todayLocal, d.due_date);
            attention.push({
                id: `trips:${r.id}:deadline-${d.id}`,
                severity: left < 0 || left <= TRIP_URGENT_DAYS ? 'urgent' : 'attention',
                text: `${d.title} is due before the ${name} trip (starts ${inDays(away)})`,
                date: d.due_date,
                ref,
            });
        }
    }
    return { attention, upcoming };
}

module.exports = { flights, places, digests, deadlines, trips };
