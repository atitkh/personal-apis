// The briefing: what needs the user now (attention) and what is coming up (upcoming), collected from every
// domain that registers a `briefing(db, { now, days })` hook in services/domains.js. Deterministic and
// stateless: the same data and the same `now` give the same answer.
//
// Item: { id, domain, severity: 'info'|'attention'|'urgent', text, date?, ref?: { domain, id } }
//   id    stable, built from the thing and its state (flights:42:departs-2026-12-17), so a later webhook can fire once
//   text  one plain line, never a booking reference, address, document number or passenger name
//   ref   the record, never its content
// A hook returns { attention: [...], upcoming: [...] } (or one flat list: every item then goes to `upcoming`).
const domains = require('./domains');

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const CAP = 20;
const SEVERITIES = ['urgent', 'attention', 'info'];
const TZ = () => process.env.DIGEST_TZ || 'America/Chicago';

function clampDays(v) {
    if (v == null || v === '' || !Number.isFinite(Number(v))) return DEFAULT_DAYS;
    return Math.min(Math.max(Math.trunc(Number(v)), 1), MAX_DAYS);
}

// Today's date (YYYY-MM-DD) in the briefing's time zone.
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ() }).format(now);

// Whole days from one YYYY-MM-DD date to another.
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const rank = (s) => { const i = SEVERITIES.indexOf(s); return i < 0 ? SEVERITIES.length : i; };
const order = (a, b) => rank(a.severity) - rank(b.severity)
    || (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function clean(item, domain) {
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') return null;
    const out = {
        id: item.id,
        domain,
        severity: SEVERITIES.includes(item.severity) ? item.severity : 'info',
        text: item.text,
    };
    if (typeof item.date === 'string' && item.date) out.date = item.date;
    if (item.ref && item.ref.domain && item.ref.id != null) out.ref = { domain: String(item.ref.domain), id: item.ref.id };
    return out;
}

// Runs one domain's hook; never throws. A bad hook is logged and skipped.
function run(db, name, o) {
    const hook = domains.REGISTRY[name] && domains.REGISTRY[name].briefing;
    if (typeof hook !== 'function') return { attention: [], upcoming: [] };
    try {
        const res = hook(db, o);
        const flat = Array.isArray(res);
        const list = (v) => (Array.isArray(v) ? v : []).map((i) => clean(i, name)).filter(Boolean);
        return flat ? { attention: [], upcoming: list(res) } : { attention: list(res && res.attention), upcoming: list(res && res.upcoming) };
    } catch (err) {
        console.error(`briefing hook for ${name} failed:`, err.message);
        return { attention: [], upcoming: [] };
    }
}

// `visibleDomains`: the domains the caller may read (null = all). `domains`: optional narrowing list.
function collect(db, { now = new Date(), days, domains: only, visibleDomains = null } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const horizon = clampDays(days);
    const asked = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
    const seen = new Set();
    const attention = [];
    const upcoming = [];
    for (const name of domains.names()) {
        if (visibleDomains && !visibleDomains.includes(name)) continue;
        if (asked && !asked.has(name)) continue;
        if (!domains.isEnabled(db, name)) continue;
        const res = run(db, name, { now: at, days: horizon });
        for (const [dest, items] of [[attention, res.attention], [upcoming, res.upcoming]]) {
            for (const item of items) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                dest.push(item);
            }
        }
    }
    attention.sort(order);
    upcoming.sort(order);
    // The cap keeps the most severe: attention first, then upcoming.
    const room = Math.max(CAP - attention.length, 0);
    const keptAttention = attention.slice(0, CAP);
    const keptUpcoming = upcoming.slice(0, room);
    return {
        generated_at: at.toISOString(),
        days: horizon,
        attention: keptAttention,
        upcoming: keptUpcoming,
        more: attention.length + upcoming.length - keptAttention.length - keptUpcoming.length,
    };
}

// The domains a key may read through MCP, worked out by the registry's own visibility rule.
function visibleDomainsFor(conn, key) {
    return require('./mcp/registry').visibleTools(conn, key).map((t) => t.def.domain);
}

module.exports = { collect, clampDays, today, dayDiff, visibleDomainsFor, DEFAULT_DAYS, MAX_DAYS, CAP };
