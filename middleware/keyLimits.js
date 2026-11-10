// Limits that belong to API keys, on top of the per-IP limiters in app.js and routes/hub:
//   - failed keys: an address that sends too many wrong keys is refused for the rest of the window,
//     even with a valid key (same idea as the admin sign-in limit);
//   - per key: one key gets a fixed number of calls per window, so a leaked key cannot use the whole
//     per-IP allowance.
// In memory and per process (one hub process), so a restart clears them. Fixed windows, small maps.
const WINDOW_MS = 15 * 60 * 1000;

const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const limits = () => ({
    failedMax: num(process.env.HUB_FAILED_KEY_MAX, 20),
    perKeyMax: num(process.env.HUB_KEY_RATE_MAX, 600),
});

const failed = new Map(); // ip -> { count, resetAt }
const perKey = new Map(); // key id -> { count, resetAt }

function bucket(map, id, now) {
    let b = map.get(id);
    if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + WINDOW_MS };
        map.set(id, b);
    }
    return b;
}

// Drops expired buckets now and then so the maps stay small.
function sweep(map, now) {
    if (map.size < 500) return;
    for (const [id, b] of map) if (b.resetAt <= now) map.delete(id);
}

const retryAfter = (b, now) => Math.max(1, Math.ceil((b.resetAt - now) / 1000));

// Seconds to wait if this address is over its failed-key allowance, else 0.
function blockedFor(ip, now = Date.now()) {
    const b = failed.get(ip);
    if (!b || b.resetAt <= now) return 0;
    return b.count >= limits().failedMax ? retryAfter(b, now) : 0;
}

function recordFailure(ip, now = Date.now()) {
    sweep(failed, now);
    bucket(failed, ip, now).count += 1;
}

// Counts one call for a key. Returns 0 if allowed, else the seconds to wait.
function takeKeyCall(keyId, now = Date.now()) {
    sweep(perKey, now);
    const b = bucket(perKey, String(keyId), now);
    if (b.count >= limits().perKeyMax) return retryAfter(b, now);
    b.count += 1;
    return 0;
}

function reset() {
    failed.clear();
    perKey.clear();
}

module.exports = { blockedFor, recordFailure, takeKeyCall, reset, WINDOW_MS };
