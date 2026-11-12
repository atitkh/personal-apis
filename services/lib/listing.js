// Limit and offset handling for list reads.

// `limit` as given, 1..max; 0, junk or missing means `def` (itself clamped to 1..max).
function clampLimit(v, def, max) {
    return Math.min(Math.max(parseInt(v, 10) || def, 1), max);
}

// Like clampLimit, but a number that parses is clamped and only junk or missing means `def` (as is, not clamped).
function limitOrDefault(v, def, max) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : def;
}

// `offset` as given, 0 or more; junk or missing means 0.
function clampOffset(v) {
    return Math.max(parseInt(v, 10) || 0, 0);
}

module.exports = { clampLimit, limitOrDefault, clampOffset };
