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

module.exports = { flights, places, digests, deadlines };
