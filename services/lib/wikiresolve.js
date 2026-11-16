// Resolving [[wikilinks]] and keeping 'mentions' links in line with a body. Shared by notes and digests.
// `self` is the record whose text this is ({ domain, id }, id a string). A plain [[Target]] resolves by exact title or alias,
// any case: a note first (the most recently updated when several share the title, never the note itself), else an entity.
// A [[domain:id]] needs a readable domain and an existing record. `visible` is the domains the caller can read (null = all).
const wikilinks = require('./wikilinks');
const links = require('../links');

const canSee = (visible, domain) => !visible || visible.includes(domain);
const isDomain = (name) => !!links.DESCRIBE[name] && require('../domains').exists(name);
const noteSelf = (self) => (self && self.domain === 'notes' ? Number(self.id) || 0 : 0);

// How one parsed target resolves: { status: 'resolved' | 'missing' | 'self', domain, id, title, kind, candidates }.
function resolveOne(db, t, { self, visible }) {
    if (t.ref) {
        const { domain, id } = t.ref;
        if (!canSee(visible, domain) || !links.DESCRIBE[domain]) return { status: 'missing' };
        if (self && domain === self.domain && String(self.id) === id) return { status: 'self' };
        let d = null;
        try { d = links.DESCRIBE[domain](db, id); } catch (e) { d = null; }
        return d ? { status: 'resolved', domain, id, title: d.title, kind: d.kind, candidates: 1 } : { status: 'missing' };
    }
    const myNote = noteSelf(self);
    if (canSee(visible, 'notes')) {
        const rows = db.prepare(`SELECT id, title, kind FROM notes WHERE title = ? COLLATE NOCASE AND removed_at IS NULL AND id != ?
            ORDER BY updated_at DESC, id DESC LIMIT 20`).all(t.target, myNote);
        if (rows.length) return { status: 'resolved', domain: 'notes', id: String(rows[0].id), title: rows[0].title, kind: rows[0].kind, candidates: rows.length };
    }
    if (canSee(visible, 'entities')) {
        const rows = db.prepare(`SELECT id, name, kind FROM entities WHERE name = @n COLLATE NOCASE
            OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE value = @n COLLATE NOCASE) ORDER BY updated_at DESC, id DESC LIMIT 20`).all({ n: t.target });
        if (rows.length) return { status: 'resolved', domain: 'entities', id: String(rows[0].id), title: rows[0].name, kind: rows[0].kind, candidates: rows.length };
    }
    if (myNote && canSee(visible, 'notes')) {
        const me = db.prepare('SELECT 1 FROM notes WHERE id = ? AND title = ? COLLATE NOCASE').get(myNote, t.target);
        if (me) return { status: 'self' };
    }
    return { status: 'missing' };
}

// Every wikilink of a body, resolved: { resolved: [{ target, label, domain, id, title, kind, ambiguous? }], unresolved: [target],
// ambiguous: [{ target, candidates, chose }] }. Links to oneself are left out.
function resolveBody(db, body, { self = null, visible = null } = {}) {
    const out = { resolved: [], unresolved: [], ambiguous: [] };
    for (const t of wikilinks.parse(body, isDomain)) {
        const r = resolveOne(db, t, { self, visible });
        if (r.status === 'self') continue;
        if (r.status === 'missing') { out.unresolved.push(t.target); continue; }
        out.resolved.push({ target: t.target, label: t.label, domain: r.domain, id: r.id, title: r.title, kind: r.kind, ...(r.candidates > 1 ? { ambiguous: r.candidates } : {}) });
        if (r.candidates > 1) out.ambiguous.push({ target: t.target, candidates: r.candidates, chose: `${r.domain}:${r.id}` });
    }
    return out;
}

// For an editor: how do these typed targets resolve right now? -> same shape as resolveBody.
function resolveTargets(db, targets, opts = {}) {
    const list = (Array.isArray(targets) ? targets : []).slice(0, wikilinks.MAX_TARGETS).filter((t) => typeof t === 'string');
    return resolveBody(db, list.map((t) => `[[${t.replace(/[\[\]\r\n]/g, ' ')}]]`).join('\n'), opts);
}

// Brings the rel 'mentions' links from `self` in line with `body`. Other rels and links where `self` is the target are never
// touched, nor links to domains the caller cannot read. One transaction (the caller's).
// -> { res (resolveBody), added, removed, resolved (count of linked targets) }
function syncMentions(db, self, body, actor, { visible = null } = {}) {
    const res = resolveBody(db, body, { self, visible });
    const want = new Set();
    let added = 0;
    for (const r of res.resolved) {
        const k = `${r.domain}:${r.id}`;
        if (want.has(k)) continue;
        want.add(k);
        try {
            if (links.add(db, { from: self, to: { domain: r.domain, id: r.id }, rel: 'mentions' }, actor).status === 'created') added += 1;
        } catch (e) { want.delete(k); }     // a target links.js refuses (an odd id) stays plain text
    }
    let removed = 0;
    const own = db.prepare("SELECT id, to_domain, to_id FROM links WHERE from_domain = ? AND from_id = ? AND rel = 'mentions'").all(self.domain, String(self.id));
    for (const l of own) {
        if (want.has(`${l.to_domain}:${l.to_id}`) || !canSee(visible, l.to_domain)) continue;
        db.prepare('DELETE FROM links WHERE id = ?').run(l.id);
        removed += 1;
    }
    return { res, added, removed, resolved: want.size };
}

module.exports = { canSee, isDomain, resolveOne, resolveBody, resolveTargets, syncMentions };
