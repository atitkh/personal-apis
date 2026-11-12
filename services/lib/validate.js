// Cleaners shared by the domain services. The ones that can fail take the domain's own error maker
// `bad(code, message, status, extra)` first, so each domain keeps its own error class, codes and messages.

// A positive integer id from a number or digits-only text, else null.
function toId(v) {
    const id = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Optional text: null for missing or blank, NFKC-normalised and trimmed, at most `max` characters.
//   upper    -> upper-case it
//   collapse -> runs of whitespace become one space
//   field    -> the errors carry { field: name } as their `extra`
function text(bad, v, name, max, { upper = false, collapse = false, field = false } = {}) {
    const extra = field ? { field: name } : undefined;
    if (v == null) return null;
    if (typeof v !== 'string' && typeof v !== 'number') throw bad('bad_request', `${name} must be text.`, 400, extra);
    let s = String(v).normalize('NFKC');
    if (collapse) s = s.replace(/\s+/g, ' ');
    s = s.trim();
    if (!s) return null;
    if (s.length > max) throw bad('bad_request', `${name} is longer than ${max} characters.`, 400, extra);
    return upper ? s.toUpperCase() : s;
}

// `v` must be one of `list`; the error code is bad_<name>.
function oneOf(bad, v, name, list) {
    if (!list.includes(v)) throw bad(`bad_${name}`, `${name} must be one of: ${list.join(', ')}.`);
    return v;
}

module.exports = { toId, text, oneOf };
