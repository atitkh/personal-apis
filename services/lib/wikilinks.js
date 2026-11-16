// Finds [[wikilinks]] in a note's text. Pure: no database. Forms (what is inside the brackets):
//   [[Target]]  [[Target|label]]          a title or alias of a note or entity
//   [[domain:id]]  [[domain:id|label]]    a record of a linkable domain (ids as in services/links.js, digests are kind/period)
// Text inside fenced code blocks (``` or ~~~) and inline code spans is not scanned. At most MAX_TARGETS distinct targets.
const MAX_TARGETS = 100;
const MAX_TARGET_LEN = 200;
const REF_RE = /^([a-z][a-z0-9_]*):(\S.*)$/i;

// The text with code fences and inline code blanked out (same length is not needed, only that no link survives in code).
function stripCode(body) {
    const out = [];
    let fence = null;
    for (const line of String(body == null ? '' : body).split('\n')) {
        const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^\s*$/.test(line.slice(m[0].length))) fence = null;
            out.push('');
            continue;
        }
        if (m) { fence = { ch: m[1][0], len: m[1].length }; out.push(''); continue; }
        out.push(line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, ' '));
    }
    return out.join('\n');
}

// -> [{ raw, key, target, label, ref: { domain, id } | null }] in order of first appearance, one per distinct target.
// `isDomain(name)` says whether `name` can be the domain part of a [[domain:id]] reference.
function parse(body, isDomain = () => false) {
    const text = stripCode(body);
    const seen = new Set();
    const out = [];
    const re = /\[\[([^\[\]\r\n]{1,400})\]\]/g;
    let m;
    while ((m = re.exec(text)) && out.length < MAX_TARGETS) {
        const bar = m[1].indexOf('|');
        const target = (bar < 0 ? m[1] : m[1].slice(0, bar)).normalize('NFKC').replace(/\s+/g, ' ').trim();
        const label = bar < 0 ? null : m[1].slice(bar + 1).replace(/\s+/g, ' ').trim() || null;
        if (!target || target.length > MAX_TARGET_LEN) continue;
        const key = target.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const r = REF_RE.exec(target);
        const ref = r && isDomain(r[1].toLowerCase()) ? { domain: r[1].toLowerCase(), id: r[2].trim() } : null;
        out.push({ raw: m[0], key, target, label, ref });
    }
    return out;
}

module.exports = { parse, stripCode, MAX_TARGETS, MAX_TARGET_LEN };
