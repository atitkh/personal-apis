// Reference data shipped with the code: the airports in db/seed/airports.json (built by
// scripts/airports-build.js from OurAirports). Loaded at start-up, no network. Idempotent: the seed's
// build date and size are recorded in schema_migrations, so an unchanged seed is skipped and a newer one
// replaces the rows by IATA code (airports no longer in the seed stay, a flight may still point at them).
const fs = require('fs');
const path = require('path');

const AIRPORTS_FILE = path.join(__dirname, 'seed', 'airports.json');

let cached = null;
function airportsSeed() {
    if (!cached) cached = JSON.parse(fs.readFileSync(AIRPORTS_FILE, 'utf8'));
    return cached;
}

function seedAirports(db) {
    const seed = airportsSeed();
    const marker = `seed:airports@${seed.built}:${seed.rows.length}`;
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(marker)) return 0;
    const at = seed.fields.reduce((m, f, i) => ({ ...m, [f]: i }), {});
    const upsert = db.prepare(`INSERT INTO airports (iata, icao, name, city, country, lat, lon, tz) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (iata) DO UPDATE SET icao = excluded.icao, name = excluded.name, city = excluded.city,
            country = excluded.country, lat = excluded.lat, lon = excluded.lon, tz = excluded.tz`);
    db.transaction(() => {
        for (const r of seed.rows) upsert.run(r[at.iata], r[at.icao], r[at.name], r[at.city], r[at.country], r[at.lat], r[at.lon], r[at.tz]);
        db.prepare("DELETE FROM schema_migrations WHERE name LIKE 'seed:airports@%'").run();
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(marker, new Date().toISOString());
    })();
    return seed.rows.length;
}

function run(db) {
    seedAirports(db);
}

module.exports = { run, seedAirports, AIRPORTS_FILE };
