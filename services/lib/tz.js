// The hub's time zone, in one place. hubTz(conn) is the zone the admin picked in Settings (else DIGEST_TZ, else
// America/Chicago); todayIn(tz, now) is that zone's calendar date as YYYY-MM-DD.
const settings = require('../settings');

const hubTz = (conn) => (conn ? settings.get(conn, 'timezone') : (process.env.DIGEST_TZ || settings.FALLBACK_TZ));

const todayIn = (tz, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);

// Hour of day (0-23) in tz.
const hourIn = (tz, now = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));

// "YYYY-MM-DD HH:mm" as the clock reads in tz (names a backup file by the hub's local time).
function stampIn(tz, now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}${p.minute}` };
}

module.exports = { hubTz, todayIn, hourIn, stampIn };
