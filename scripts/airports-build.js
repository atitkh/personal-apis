#!/usr/bin/env node
// Builds db/seed/airports.json, the airports the flights domain knows, from OurAirports (public domain).
// Run by hand when the seed should be refreshed; the hub itself never touches the network (db/seed.js loads
// the JSON at start-up).
//
//   1. curl -sSfL -o /tmp/airports/airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
//   2. in a throwaway copy (not the NFS mount): npm i --no-save tz-lookup
//   3. node scripts/airports-build.js /tmp/airports/airports.csv > db/seed/airports.json
//
// Kept: rows with an IATA code that have scheduled service, plus every large_airport and medium_airport with an
// IATA code. The CSV has no time zones, so tz is derived from lat/lon with tz-lookup (offline, built from the
// timezone-boundary-builder shapes). Coordinates are rounded to 4 decimals (about 11 m).
// tz-lookup is only needed here, so it is not a dependency of the hub.
const fs = require('fs');

// RFC 4180: quoted fields may hold commas, quotes ("") and line breaks.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

const round = (n) => Math.round(Number(n) * 1e4) / 1e4;

function build(csvText, tzOf) {
    const [header, ...rows] = parseCsv(csvText);
    const col = Object.fromEntries(header.map((name, i) => [name, i]));
    const byIata = new Map();
    for (const r of rows) {
        if (r.length < header.length) continue;
        const iata = (r[col.iata_code] || '').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(iata)) continue;
        const type = r[col.type];
        if (r[col.scheduled_service] !== 'yes' && type !== 'large_airport' && type !== 'medium_airport') continue;
        const lat = round(r[col.latitude_deg]);
        const lon = round(r[col.longitude_deg]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const entry = {
            rank: { large_airport: 3, medium_airport: 2 }[type] || (r[col.scheduled_service] === 'yes' ? 1 : 0),
            row: [iata, (r[col.icao_code] || r[col.gps_code] || '').trim() || null, r[col.name].trim(),
                (r[col.municipality] || '').trim() || null, r[col.iso_country].trim(), lat, lon, tzOf(lat, lon)],
        };
        // A few IATA codes appear twice (a closed field and the open one): keep the bigger airport.
        const had = byIata.get(iata);
        if (!had || entry.rank > had.rank) byIata.set(iata, entry);
    }
    const list = [...byIata.values()].map((e) => e.row).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return {
        source: 'OurAirports airports.csv (public domain), https://ourairports.com/data/',
        built: new Date().toISOString().slice(0, 10),
        fields: ['iata', 'icao', 'name', 'city', 'country', 'lat', 'lon', 'tz'],
        rows: list,
    };
}

if (require.main === module) {
    const file = process.argv[2];
    if (!file) { console.error('usage: node scripts/airports-build.js airports.csv > db/seed/airports.json'); process.exit(2); }
    const tzlookup = require('tz-lookup');
    const tzOf = (lat, lon) => { try { return tzlookup(lat, lon); } catch (e) { return null; } };
    const out = build(fs.readFileSync(file, 'utf8'), tzOf);
    process.stdout.write(`{"source":${JSON.stringify(out.source)},"built":"${out.built}","fields":${JSON.stringify(out.fields)},"rows":[\n`
        + out.rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]}\n');
    console.error(`${out.rows.length} airports`);
}

module.exports = { parseCsv, build };
