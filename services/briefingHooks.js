// The first briefing hooks (see services/briefing.js). Each returns { attention, upcoming } and may throw: the
// collector skips a hook that does. Text carries no booking reference, address or name: flights say airline
// code + number, airport codes and dates; places and digests say only counts and dates.
const { today, dayDiff } = require('./briefing');

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
    const todayLocal = today(now);
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

module.exports = { flights, places, digests };
