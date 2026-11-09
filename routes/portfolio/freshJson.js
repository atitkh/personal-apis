// Reads a JSON file and re-reads it whenever the file changes on disk. `require()` caches a JSON file for
// the life of the process, which is why portfolio edits needed `docker restart nodejs`.
const fs = require('fs');

const cache = new Map(); // path -> { mtimeMs, data }

function readJson(file) {
    const { mtimeMs } = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data;
    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        // A half-saved edit must not take the site down: keep serving the last good copy.
        if (hit) {
            console.error(`Ignoring unreadable ${file}: ${err.message}`);
            hit.mtimeMs = mtimeMs; // do not retry (and log) until the file changes again
            return hit.data;
        }
        throw err;
    }
    cache.set(file, { mtimeMs, data });
    return data;
}

module.exports = { readJson };
