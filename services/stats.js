// The dashboard's Stats page: read-only aggregates over the hub's tables, one function per section. Admin only:
// nothing here is served on /hub or over MCP. Money (deadline amounts) appears in exactly one place, the deadlines
// section's `cost` block; every other section carries counts, dates and labels only.
const domains = require('./domains');
const apiKeys = require('./apiKeys');
const audit = require('./audit');
const { hubTz, todayIn } = require('./lib/tz');

const RANGES = { 30: 30, 90: 90, 365: 365, all: null };
const ALL_CAP_DAYS = 3660; // "all" still stops at about ten years back
const TOP_KINDS = 6;
const TOP_KEYS = 6;

// '30' | '90' | '365' | 'all' (default 90). Null for anything else.
function cleanRange(v) {
    if (v === undefined || v === null || v === '') return '90';
    const s = String(v).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(RANGES, s) ? s : null;
}

/* ---------- dates (YYYY-MM-DD strings, calendar math in UTC) ---------- */

const DAY = 86400000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => new Date(toMs(d) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const weekOf = (d) => addDays(d, -((new Date(toMs(d)).getUTCDay() + 6) % 7)); // the Monday
const monthOf = (d) => d.slice(0, 7);
function addMonthsTo(d, n) {
    const [y, m, day] = d.split('-').map(Number);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

// The window a request covers: its first and last local date and the bucket size the charts use
// (days up to 90 days, weeks for a year, months for everything).
function windowFor(range, today, earliest) {
    const days = RANGES[range];
    let from;
    if (days) from = addDays(today, -(days - 1));
    else {
        const floor = addDays(today, -(ALL_CAP_DAYS - 1));
        from = earliest && earliest > floor ? earliest : (earliest ? floor : addDays(today, -89));
        if (from > today) from = today;
    }
    const bucket = days && days <= 90 ? 'day' : (days === 365 ? 'week' : 'month');
    return { range, from, to: today, bucket, days: dayDiff(from, today) + 1 };
}

const bucketOf = (bucket, d) => (bucket === 'day' ? d : bucket === 'week' ? weekOf(d) : monthOf(d));

// Every bucket label from `from` to `to`, so a series has its empty days too.
function bucketList(bucket, from, to) {
    const out = [];
    if (bucket === 'month') {
        for (let d = `${monthOf(from)}-01`; monthOf(d) <= monthOf(to); d = addMonthsTo(d, 1)) out.push(monthOf(d));
    } else {
        const step = bucket === 'week' ? 7 : 1;
        for (let d = bucketOf(bucket, from); d <= to; d = addDays(d, step)) out.push(d);
    }
    return out;
}

// Keeps the `n` largest keys of a count map and folds the rest into "other".
function topKeys(counts, n) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const keep = sorted.slice(0, n).map(([k]) => k);
    return { keep, folded: sorted.length > n };
}

// [{ bucket, count }] rows grouped by series name into { labels, series: [{ name, values }] } with zeros filled in.
function stack(rows, labels, n) {
    const totals = new Map();
    for (const r of rows) totals.set(r.name, (totals.get(r.name) || 0) + r.n);
    const { keep, folded } = topKeys(totals, n);
    const names = folded ? [...keep, 'other'] : keep;
    const index = new Map(labels.map((l, i) => [l, i]));
    const series = names.map((name) => ({ name, values: labels.map(() => 0) }));
    const byName = new Map(series.map((s) => [s.name, s]));
    for (const r of rows) {
        const i = index.get(r.bucket);
        if (i === undefined) continue;
        const s = byName.get(keep.includes(r.name) ? r.name : 'other');
        s.values[i] += r.n;
    }
    return { labels, series };
}

/* ---------- sections ---------- */

function totals(conn) {
    return {
        domains: domains.list(conn).map((d) => ({ name: d.name, title: d.title, enabled: d.enabled, records: d.records, label: d.recordLabel })),
    };
}

function lifelog(conn, w, tz) {
    const eps = conn.prepare(`SELECT e.local_date, e.kind, e.start_at, e.end_at, COALESCE(p.label, e.place) AS place
        FROM lifelog_episodes e LEFT JOIN places p ON p.id = e.place_id
        WHERE e.status = 'active' AND e.local_date >= ? AND e.local_date <= ?`).all(w.from, w.to);
    const labels = bucketList(w.bucket, w.from, w.to);
    const minutes = (r) => {
        if (!r.end_at) return 0;
        const m = (Date.parse(r.end_at) - Date.parse(r.start_at)) / 60000;
        return Number.isFinite(m) && m > 0 ? Math.min(m, 24 * 60) : 0;
    };

    const perBucket = new Map();
    const kinds = new Map();
    const places = new Map();
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    for (const r of eps) {
        const key = `${bucketOf(w.bucket, r.local_date)}\u0000${r.kind}`;
        perBucket.set(key, (perBucket.get(key) || 0) + 1);
        const k = kinds.get(r.kind) || { kind: r.kind, episodes: 0, minutes: 0 };
        k.episodes += 1;
        k.minutes += minutes(r);
        kinds.set(r.kind, k);
        if (r.place) {
            const p = places.get(r.place) || { place: r.place, episodes: 0, minutes: 0 };
            p.episodes += 1;
            p.minutes += minutes(r);
            places.set(r.place, p);
        }
        const t = new Date(r.start_at);
        if (!Number.isNaN(t.getTime())) {
            const got = Object.fromEntries(parts.formatToParts(t).map((x) => [x.type, x.value]));
            const wd = WD[got.weekday];
            const hr = Number(got.hour) % 24;
            if (wd !== undefined && Number.isInteger(hr)) heat[wd][hr] += 1;
        }
    }
    const rows = [...perBucket.entries()].map(([key, n]) => { const [bucket, name] = key.split('\u0000'); return { bucket, name, n }; });

    const obs = conn.prepare(`SELECT local_date, source, COUNT(*) AS n FROM lifelog_observations
        WHERE local_date >= ? AND local_date <= ? GROUP BY local_date, source`).all(w.from, w.to)
        .map((r) => ({ bucket: bucketOf(w.bucket, r.local_date), name: r.source, n: r.n }));
    const round = (x) => ({ ...x, minutes: Math.round(x.minutes) });
    return {
        episodes: eps.length,
        observations: obs.reduce((s, r) => s + r.n, 0),
        episodes_by_kind: stack(rows, labels, TOP_KINDS),
        kinds: [...kinds.values()].map(round).sort((a, b) => b.episodes - a.episodes),
        top_places: [...places.values()].map(round).sort((a, b) => b.minutes - a.minutes || b.episodes - a.episodes).slice(0, 8),
        observations_by_source: stack(obs, labels, TOP_KINDS),
        heatmap: { rows: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], cols: 24, values: heat },
    };
}

// All-time, from flights.stats (the Passport numbers), so the page and the Passport agree.
function flights(conn) {
    const s = require('./flights').stats(conn);
    return {
        scope: 'all',
        flights: s.flights,
        distance_km: s.distance_km,
        hours: s.hours,
        airports: s.airports,
        countries: s.countries,
        airlines: s.airlines,
        upcoming: s.upcoming,
        completed: s.flights,
        cancelled: s.delays ? s.delays.cancelled : 0,
        per_year: s.per_year,
        top_airports: s.top_airports.slice(0, 8).map((a) => ({ iata: a.iata, city: a.city, visits: a.visits })),
        top_airlines: s.top_airlines.slice(0, 8).map((a) => ({ iata: a.iata, name: a.name, flights: a.flights })),
    };
}

// All-time per year (by start date); cancelled trips are left out.
function trips(conn) {
    const rows = conn.prepare(`SELECT kind, start_date, end_date FROM trips
        WHERE start_date IS NOT NULL AND (status_override IS NULL OR status_override != 'cancelled')`).all();
    const years = new Map();
    const kinds = new Map();
    for (const r of rows) {
        const y = r.start_date.slice(0, 4);
        const p = years.get(y) || { year: y, trips: 0, nights: 0 };
        p.trips += 1;
        if (r.end_date && r.end_date > r.start_date) p.nights += dayDiff(r.start_date, r.end_date);
        years.set(y, p);
        kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);
    }
    const cancelled = conn.prepare("SELECT COUNT(*) AS n FROM trips WHERE status_override = 'cancelled'").get().n;
    return {
        scope: 'all',
        trips: rows.length,
        cancelled,
        per_year: [...years.values()].sort((a, b) => (a.year < b.year ? -1 : 1)),
        by_kind: [...kinds.entries()].map(([kind, n]) => ({ kind, trips: n })).sort((a, b) => b.trips - a.trips),
    };
}

// The charges an item makes between `start` and `end` (exclusive): its due date stepped by its cycle (or its repeat
// when no cycle is set); a one-off counts once.
function chargeDates(row, start, end) {
    const cycleMonths = { monthly: 1, quarterly: 3, yearly: 12 }[row.cycle];
    const repeatMonths = { monthly: 1, yearly: 12, every_n_months: row.repeat_n || 0 }[row.repeat_kind] || 0;
    const repeats = row.cycle === 'weekly' || Boolean(cycleMonths || repeatMonths);
    const out = [];
    let d = row.due_date;
    if (!repeats) return d >= start && d < end ? [d] : [];
    let k = 0;
    // Step from the original due date (not from the previous result) so month-end days do not drift.
    const at = (i) => (row.cycle === 'weekly' ? addDays(row.due_date, 7 * i) : addMonthsTo(row.due_date, i * (cycleMonths || repeatMonths)));
    while (d < start && k < 100000) { k += 1; d = at(k); }
    while (d < end && out.length < 600) { out.push(d); k += 1; d = at(k); }
    return out;
}

function deadlines(conn, w, tz) {
    const svc = require('./deadlines');
    const rows = conn.prepare('SELECT * FROM deadlines').all();
    const byKind = new Map();
    const windows = { urgent: 0, attention: 0, later: 0, done: 0, ended: 0 };
    const now = new Date();
    for (const r of rows) {
        byKind.set(r.kind, (byKind.get(r.kind) || 0) + (r.status === 'active' ? 1 : 0));
        if (r.status === 'active') windows[svc.windowOf(r, svc.daysLeft(r.due_date, now, tz))] += 1;
        else windows[r.status] += 1;
    }
    // The next 12 calendar months, this one included.
    const start = `${monthOf(w.to)}-01`;
    const end = addMonthsTo(start, 12);
    const months = bucketList('month', start, addDays(end, -1));
    const perMonth = new Map(months.map((m) => [m, {}]));
    const total = {};
    let items = 0;
    for (const r of rows) {
        if (r.status !== 'active' || r.amount_cents == null || !r.currency) continue;
        const dates = chargeDates(r, start, end);
        if (dates.length) items += 1;
        for (const d of dates) {
            const m = perMonth.get(monthOf(d));
            if (!m) continue;
            m[r.currency] = (m[r.currency] || 0) + r.amount_cents;
            total[r.currency] = (total[r.currency] || 0) + r.amount_cents;
        }
    }
    return {
        active: rows.filter((r) => r.status === 'active').length,
        by_kind: [...byKind.entries()].filter(([, n]) => n > 0).map(([kind, n]) => ({ kind, active: n })).sort((a, b) => b.active - a.active),
        by_window: windows,
        cost: {
            from: months[0],
            currencies: Object.keys(total).sort(),
            months: months.map((m) => ({ month: m, cents: perMonth.get(m) })),
            total_cents: total,
            items,
        },
    };
}

function digests(conn, w) {
    const rows = conn.prepare(`SELECT d.period, length(r.body) AS chars FROM digests d
        JOIN digest_revisions r ON r.digest_id = d.id AND r.rev = d.current_rev
        WHERE d.kind = 'daily' AND d.period >= ? AND d.period <= ?`).all(w.from, w.to);
    const have = new Map(rows.map((r) => [r.period, r.chars || 0]));
    const days = [];
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) days.push({ day: d, chars: have.has(d) ? have.get(d) : null });
    const weeks = new Map();
    for (const r of rows) {
        const wk = weekOf(r.period);
        const p = weeks.get(wk) || { week: wk, digests: 0, chars: 0 };
        p.digests += 1;
        p.chars += r.chars || 0;
        weeks.set(wk, p);
    }
    const weekly = conn.prepare("SELECT COUNT(*) AS n FROM digests WHERE kind = 'weekly' AND period >= ?").get(`${w.from.slice(0, 4)}-W00`).n;
    return {
        days,
        present: rows.length,
        total: days.length,
        avg_chars: rows.length ? Math.round(rows.reduce((s, r) => s + (r.chars || 0), 0) / rows.length) : 0,
        per_week: bucketList('week', w.from, w.to).map((wk) => {
            const p = weeks.get(wk);
            return { week: wk, digests: p ? p.digests : 0, avg_chars: p ? Math.round(p.chars / p.digests) : 0 };
        }),
        weekly_digests: weekly,
    };
}

function graph(conn, w) {
    const on = (name) => domains.isEnabled(conn, name);
    const out = {};
    const growthBucket = w.bucket === 'month' ? 'month' : 'week';
    const labels = bucketList(growthBucket, w.from, w.to);
    const growth = (sql, name) => {
        const rows = conn.prepare(sql).all(`${w.from}T00:00:00`);
        const before = conn.prepare(sql.replace('SELECT created_at FROM', 'SELECT COUNT(*) AS n FROM').replace('>= ?', '< ?')).get(`${w.from}T00:00:00`).n;
        const values = labels.map(() => 0);
        const index = new Map(labels.map((l, i) => [l, i]));
        for (const r of rows) {
            const i = index.get(bucketOf(growthBucket, String(r.created_at).slice(0, 10)));
            if (i !== undefined) values[i] += 1;
        }
        let run = before;
        return { name, values, cumulative: values.map((v) => (run += v)) };
    };
    const series = [];
    if (on('entities')) {
        out.entities_by_kind = conn.prepare('SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind ORDER BY n DESC').all()
            .map((r) => ({ kind: r.kind, entities: r.n }));
    }
    if (on('notes')) series.push(growth('SELECT created_at FROM notes WHERE removed_at IS NULL AND created_at >= ?', 'notes'));
    if (on('links')) {
        out.links_by_rel = conn.prepare('SELECT rel, COUNT(*) AS n FROM links GROUP BY rel ORDER BY n DESC, rel LIMIT 15').all()
            .map((r) => ({ rel: r.rel, links: r.n }));
        series.push(growth('SELECT created_at FROM links WHERE created_at >= ?', 'links'));
        // The links 'hubs' logic, without records of domains that are off.
        out.top_connected = require('./graph').hubs(conn, { limit: 20 }).filter((n) => on(n.domain)).slice(0, 10)
            .map((n) => ({ domain: n.domain, id: n.id, title: n.title, kind: n.kind, date: n.date, degree: n.degree }));
    }
    out.growth = { bucket: growthBucket, labels, series };
    return out;
}

function search(conn) {
    const s = require('./embeddings').status(conn);
    return {
        enabled: s.enabled,
        model: s.model,
        indexed: s.indexed,
        total: s.total,
        domains: s.domains.map((d) => ({ domain: d.domain, title: d.title, indexed: d.indexed, total: d.total })),
        last_run: s.last_run || null,
        last_error: s.last_error || null,
    };
}

// MCP calls per bucket per key, from the 'mcp_call' audit rows (REST /hub calls are not logged per call, so they are not here).
function agents(conn, w, tz) {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    const since = new Date(toMs(w.from) - DAY).toISOString();
    const rows = conn.prepare("SELECT at, actor, detail FROM audit_log WHERE action = 'mcp_call' AND at >= ?").all(since);
    const names = new Map(apiKeys.list(conn).map((k) => [k.id, k.name]));
    const counts = new Map();
    let failed = 0;
    let calls = 0;
    for (const r of rows) {
        const day = fmt.format(new Date(r.at));
        if (day < w.from || day > w.to) continue;
        let detail = null;
        try { detail = JSON.parse(r.detail || 'null'); } catch (e) { /* keep the count */ }
        const id = audit.keyIdOf(detail);
        const name = (id !== null && names.get(id)) || r.actor || 'unknown';
        const key = `${bucketOf(w.bucket, day)}\u0000${name}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        calls += 1;
        if (detail && detail.ok === false) failed += 1;
    }
    const list = [...counts.entries()].map(([k, n]) => { const [bucket, name] = k.split('\u0000'); return { bucket, name, n }; });
    return { source: 'mcp', calls, failed, by_key: stack(list, bucketList(w.bucket, w.from, w.to), TOP_KEYS) };
}

/* ---------- the page ---------- */

// Each section: its function and the domains it needs (skipped, not failed, when they are all off).
const SECTIONS = {
    totals: { needs: [], run: (c) => totals(c) },
    lifelog: { needs: ['lifelog'], run: (c, w, tz) => lifelog(c, w, tz) },
    flights: { needs: ['flights'], run: (c) => flights(c) },
    trips: { needs: ['trips'], run: (c) => trips(c) },
    deadlines: { needs: ['deadlines'], run: (c, w, tz) => deadlines(c, w, tz) },
    digests: { needs: ['digests'], run: (c, w) => digests(c, w) },
    graph: { needs: ['entities', 'links', 'notes'], run: (c, w) => graph(c, w) },
    search: { needs: [], run: (c) => search(c) },
    agents: { needs: [], run: (c, w, tz) => agents(c, w, tz) },
};

// The earliest date any range-based section has data for, so "all" starts there.
function earliest(conn) {
    const q = (sql) => { try { return conn.prepare(sql).get().d || null; } catch (e) { return null; } };
    const list = [
        q('SELECT MIN(local_date) AS d FROM lifelog_episodes'),
        q('SELECT MIN(local_date) AS d FROM lifelog_observations'),
        q("SELECT MIN(period) AS d FROM digests WHERE kind = 'daily'"),
        q('SELECT substr(MIN(created_at), 1, 10) AS d FROM notes'),
        q('SELECT substr(MIN(created_at), 1, 10) AS d FROM links'),
        q("SELECT substr(MIN(at), 1, 10) AS d FROM audit_log WHERE action = 'mcp_call'"),
    ].filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d));
    return list.sort()[0] || null;
}

// `only` limits the sections (tests). Throws nothing: a failing section answers { error }.
function collect(conn, { range = '90', now = new Date(), only } = {}) {
    const r = cleanRange(range);
    if (!r) throw Object.assign(new Error('range must be one of 30, 90, 365, all.'), { status: 400 });
    const tz = hubTz(conn);
    const today = todayIn(tz, now);
    const w = windowFor(r, today, r === 'all' ? earliest(conn) : null);
    const sections = {};
    for (const [name, def] of Object.entries(SECTIONS)) {
        if (only && !only.includes(name)) continue;
        if (def.needs.length && !def.needs.some((d) => domains.isEnabled(conn, d))) {
            sections[name] = { skipped: 'disabled', domains: def.needs };
            continue;
        }
        try { sections[name] = def.run(conn, w, tz); } catch (err) { sections[name] = { error: err.message }; }
    }
    return { range: r, from: w.from, to: w.to, bucket: w.bucket, tz, generated_at: now.toISOString(), sections };
}

module.exports = { collect, cleanRange, chargeDates, windowFor, bucketList, SECTIONS };
