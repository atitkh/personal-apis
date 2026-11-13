// Webhooks: push briefing changes to another system (first receiver: the VorteX Axis inbox, POST /v1/hook/<source>).
//
// What counts as a change is worked out here, against what this webhook last sent (webhook_state): an item that
// appears is `new`, one that gets more severe is `escalated`, one that disappears is `resolved` (sent only when the
// webhook asks for it). An item that is unchanged sends nothing, however often the check runs, and a text change alone
// ("due in 10 days" -> "in 9 days") is not a change. The first check after a webhook is created only records what
// exists ("start from now"), unless the webhook was made with start: 'send'.
//
// Events go into webhook_outbox in the same transaction as the state change, and a sender delivers them with retries
// and backoff, so a restart or a receiver outage loses nothing. The check runs every few minutes (items that change
// with no write: a deadline entering its window, midnight) and a few seconds after any audited activity.
//
// The URL and secret are credentials. Nothing here logs them; errors name the host only; the audit rows carry names.
const crypto = require('crypto');
const briefing = require('./briefing');

const TICK_MS = 5 * 60 * 1000;
const POKE_MS = 5 * 1000;
const FIRST_TICK_MS = 20 * 1000;
const SEND_TIMEOUT_MS = 10 * 1000;
const SEND_PER_TICK = 20;
const SEND_GAP_MS = 300;
const BACKOFF_MIN = [1, 5, 30, 120, 720]; // after attempt 1..5; the 6th failure is final
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const KEEP_SENT_DAYS = 14;
const KEEP_FAILED_DAYS = 30;
const HORIZON_DAYS = 14;
const SEVERITIES = ['info', 'attention', 'urgent'];
const AUTH_MODES = ['bearer', 'hmac', 'none'];
const PRIORITY = { info: 'low', attention: 'normal', urgent: 'urgent' };

class WebhookError extends Error {
    constructor(message, field, status = 400) {
        super(message);
        this.name = 'WebhookError';
        this.status = status;
        this.field = field || null;
    }
}

const rank = (s) => SEVERITIES.indexOf(s);
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

/* ---------- configuration ---------- */

function parseUrl(v) {
    if (typeof v !== 'string' || !v.trim() || v.length > 500) throw new WebhookError('Enter the webhook address (http or https).', 'url');
    let u;
    try { u = new URL(v.trim()); } catch (e) { throw new WebhookError('That is not a web address.', 'url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebhookError('The address must start with http:// or https://.', 'url');
    if (u.username || u.password) throw new WebhookError('Put the secret in the secret field, not in the address.', 'url');
    return u.toString();
}

// Where it goes, without the path or query (those can hold a token): scheme://host[:port]
function hostOf(url) {
    try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch (e) { return ''; }
}

function parseDomains(v) {
    if (v == null || (Array.isArray(v) && !v.length)) return null;
    if (!Array.isArray(v) || v.length > 30 || v.some((d) => typeof d !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(d))) {
        throw new WebhookError('Domains must be a list of domain names, or empty for all.', 'domains');
    }
    return [...new Set(v)];
}

const bool = (v, field) => {
    if (v === true || v === 1 || v === 'true') return 1;
    if (v === false || v === 0 || v === 'false') return 0;
    throw new WebhookError(`${field} must be true or false.`, field);
};

function parseBody(b, { partial }) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new WebhookError('Send an object.');
    const out = {};
    const has = (k) => b[k] !== undefined;
    if (has('name') || !partial) {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 60) throw new WebhookError('Give it a name (up to 60 characters).', 'name');
        out.name = b.name.trim();
    }
    if (has('url') || !partial) out.url = parseUrl(b.url);
    if (has('auth_mode') || !partial) {
        const m = b.auth_mode === undefined ? 'bearer' : b.auth_mode;
        if (!AUTH_MODES.includes(m)) throw new WebhookError('auth_mode: bearer, hmac or none.', 'auth_mode');
        out.auth_mode = m;
    }
    if (has('secret')) {
        if (b.secret !== null && (typeof b.secret !== 'string' || b.secret.length > 300 || /[\r\n\0]/.test(b.secret))) throw new WebhookError('The secret is not usable (one line, up to 300 characters).', 'secret');
        out.secret = b.secret === null || b.secret === '' ? null : b.secret;
    }
    if (has('min_severity') || !partial) {
        const s = b.min_severity === undefined ? 'attention' : b.min_severity;
        if (!SEVERITIES.includes(s)) throw new WebhookError('min_severity: info, attention or urgent.', 'min_severity');
        out.min_severity = s;
    }
    if (has('domains')) out.domains = parseDomains(b.domains);
    if (has('send_resolved')) out.send_resolved = bool(b.send_resolved, 'send_resolved');
    if (has('enabled')) out.enabled = bool(b.enabled, 'enabled');
    if (!partial) {
        const start = b.start === undefined ? 'now' : b.start;
        if (!['now', 'send'].includes(start)) throw new WebhookError("start: 'now' (record what exists, send only changes) or 'send' (send what exists once).", 'start');
        out.start = start;
    }
    return out;
}

const toRow = (r) => (r && {
    id: r.id,
    name: r.name,
    host: hostOf(r.url),
    auth_mode: r.auth_mode,
    has_secret: Boolean(r.secret),
    min_severity: r.min_severity,
    domains: r.domains ? JSON.parse(r.domains) : null,
    send_resolved: Boolean(r.send_resolved),
    enabled: Boolean(r.enabled),
    baseline_done: Boolean(r.baseline_done),
    last_status: r.last_status,
    last_at: r.last_at,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
});

function counts(conn, id) {
    const c = conn.prepare(`SELECT
        SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed,
        SUM(status = 'sent' AND sent_at >= ?) AS sent_24h
        FROM webhook_outbox WHERE webhook_id = ?`).get(new Date(Date.now() - 86400000).toISOString(), id);
    return { pending: c.pending || 0, failed: c.failed || 0, sent_24h: c.sent_24h || 0 };
}

const raw = (conn, id) => conn.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);

function list(conn) {
    return conn.prepare('SELECT * FROM webhooks ORDER BY id').all().map((r) => ({ ...toRow(r), ...counts(conn, r.id) }));
}

function get(conn, id) {
    const r = raw(conn, id);
    return r ? { ...toRow(r), ...counts(conn, id) } : null;
}

function create(conn, body, now = new Date()) {
    const c = parseBody(body, { partial: false });
    const at = now.toISOString();
    const r = conn.prepare(`INSERT INTO webhooks (name, url, auth_mode, secret, min_severity, domains, send_resolved, enabled, baseline_done, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.name, c.url, c.auth_mode, c.secret || null, c.min_severity, c.domains ? JSON.stringify(c.domains) : null,
            c.send_resolved || 0, c.enabled === undefined ? 1 : c.enabled, c.start === 'send' ? 1 : 0, at, at);
    return get(conn, Number(r.lastInsertRowid));
}

// Partial. Changing what is watched (domains, min_severity) keeps the state: items that fall out of the filter resolve,
// items that come into it are new, like any other change.
function update(conn, id, body, now = new Date()) {
    if (!raw(conn, id)) throw new WebhookError('No such webhook.', null, 404);
    const c = parseBody(body, { partial: true });
    const sets = [];
    const args = [];
    for (const [k, v] of Object.entries(c)) {
        sets.push(`${k} = ?`);
        args.push(k === 'domains' ? (v ? JSON.stringify(v) : null) : v);
    }
    if (!sets.length) throw new WebhookError('Nothing to change.');
    sets.push('updated_at = ?');
    args.push(now.toISOString(), id);
    conn.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return get(conn, id);
}

function remove(conn, id) {
    const r = raw(conn, id);
    if (!r) throw new WebhookError('No such webhook.', null, 404);
    conn.prepare('DELETE FROM webhooks WHERE id = ?').run(id); // state and outbox go with it (ON DELETE CASCADE)
    return { id, name: r.name };
}

function events(conn, id, limit = 20) {
    return conn.prepare(`SELECT id, event_id, state, item_id, status, attempts, next_attempt_at, last_error, created_at, sent_at,
        json_extract(payload, '$.body') AS text, json_extract(payload, '$.priority') AS priority
        FROM webhook_outbox WHERE webhook_id = ? ORDER BY id DESC LIMIT ?`).all(id, Math.min(Math.max(Number(limit) || 20, 1), 100));
}

/* ---------- the check ---------- */

const label = (domain) => domain.charAt(0).toUpperCase() + domain.slice(1);

function payloadFor(hook, { state, n, itemId, domain, severity, text, now }) {
    const eventId = `ph-${hook.id}-${sha(itemId).slice(0, 12)}-${n}-${state}`;
    const body = state === 'escalated' ? `Now ${severity}: ${text}` : state === 'resolved' ? `Resolved: ${text}` : text;
    return {
        eventId,
        payload: {
            title: label(domain),
            body: body.slice(0, 1000),
            priority: state === 'resolved' ? 'low' : PRIORITY[severity],
            tag: `personal-hub:${domain}`.slice(0, 64),
            dedupe: eventId,
            // For receivers that want more than the text; the Axis door ignores these.
            source: 'personal-hub',
            event_id: eventId,
            key: itemId,
            domain,
            state,
            severity,
            occurred_at: now.toISOString(),
        },
    };
}

// One webhook against the current items. Returns { baseline, new, escalated, resolved } counts.
function checkOne(conn, hook, items, now) {
    const at = now.toISOString();
    const wanted = new Map();
    const domains = hook.domains ? JSON.parse(hook.domains) : null;
    for (const it of items) {
        if (domains && !domains.includes(it.domain)) continue;
        if (rank(it.severity) < rank(hook.min_severity)) continue;
        wanted.set(it.id, it);
    }
    const known = new Map(conn.prepare('SELECT * FROM webhook_state WHERE webhook_id = ?').all(hook.id).map((r) => [r.item_id, r]));
    const upState = conn.prepare(`INSERT INTO webhook_state (webhook_id, item_id, domain, severity, text, status, n, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(webhook_id, item_id) DO UPDATE SET domain = excluded.domain, severity = excluded.severity, text = excluded.text,
            status = excluded.status, n = excluded.n, updated_at = excluded.updated_at`);
    const enqueue = conn.prepare(`INSERT INTO webhook_outbox (webhook_id, event_id, state, item_id, payload, next_attempt_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const out = { baseline: 0, new: 0, escalated: 0, resolved: 0 };

    conn.transaction(() => {
        const emit = (state, itemId, domain, severity, text, n) => {
            const { eventId, payload } = payloadFor(hook, { state, n, itemId, domain, severity, text, now });
            enqueue.run(hook.id, eventId, state, itemId, JSON.stringify(payload), at, at);
            out[state] += 1;
        };
        if (!hook.baseline_done) {
            for (const it of wanted.values()) { upState.run(hook.id, it.id, it.domain, it.severity, it.text, 'active', 0, at); out.baseline += 1; }
            conn.prepare('UPDATE webhooks SET baseline_done = 1 WHERE id = ?').run(hook.id);
            return;
        }
        for (const it of wanted.values()) {
            const was = known.get(it.id);
            if (!was || was.status === 'resolved') {
                const n = (was ? was.n : 0) + 1;
                upState.run(hook.id, it.id, it.domain, it.severity, it.text, 'active', n, at);
                emit('new', it.id, it.domain, it.severity, it.text, n);
            } else if (rank(it.severity) > rank(was.severity)) {
                const n = was.n + 1;
                upState.run(hook.id, it.id, it.domain, it.severity, it.text, 'active', n, at);
                emit('escalated', it.id, it.domain, it.severity, it.text, n);
            } else if (it.severity !== was.severity || it.text !== was.text) {
                // calmer or reworded: remember it, send nothing
                upState.run(hook.id, it.id, it.domain, it.severity, it.text, 'active', was.n, at);
            }
        }
        for (const was of known.values()) {
            if (was.status !== 'active' || wanted.has(was.item_id)) continue;
            upState.run(hook.id, was.item_id, was.domain, was.severity, was.text, 'resolved', was.n, at);
            if (hook.send_resolved) emit('resolved', was.item_id, was.domain, was.severity, was.text, was.n);
        }
    })();
    return out;
}

// Checks every enabled webhook (or one). Never throws for one webhook's sake.
function check(conn, { now = new Date(), id } = {}) {
    const hooks = (id ? [raw(conn, id)].filter(Boolean) : conn.prepare('SELECT * FROM webhooks WHERE enabled = 1').all());
    const total = { checked: 0, baseline: 0, new: 0, escalated: 0, resolved: 0 };
    if (!hooks.length) return total;
    const b = briefing.collect(conn, { now, days: HORIZON_DAYS, cap: Infinity });
    const items = [...b.attention, ...b.upcoming];
    for (const hook of hooks) {
        try {
            const r = checkOne(conn, hook, items, now);
            total.checked += 1;
            for (const k of ['baseline', 'new', 'escalated', 'resolved']) total[k] += r[k];
        } catch (err) {
            console.error(`webhook ${hook.id} check failed:`, err.message);
        }
    }
    return total;
}

/* ---------- delivery ---------- */

function headersFor(hook, bodyText) {
    const h = { 'Content-Type': 'application/json', 'User-Agent': 'personal-hub-webhook' };
    if (hook.auth_mode === 'bearer' && hook.secret) h.Authorization = `Bearer ${hook.secret}`;
    if (hook.auth_mode === 'hmac' && hook.secret) h['X-Hub-Signature-256'] = `sha256=${crypto.createHmac('sha256', hook.secret).update(bodyText).digest('hex')}`;
    return h;
}

// One POST. Resolves { ok, status, retryable, retryAfter?, error? }; the error names the host, never the address or secret.
async function post(hook, payload, fetchImpl = globalThis.fetch) {
    const text = JSON.stringify(payload);
    const where = hostOf(hook.url);
    try {
        const res = await fetchImpl(hook.url, {
            method: 'POST',
            headers: headersFor(hook, text),
            body: text,
            redirect: 'manual',
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
        const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
        return {
            ok: false,
            status: res.status,
            retryable,
            ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter: Math.min(retryAfter, 3600) } : {}),
            error: `${where} answered HTTP ${res.status}`,
        };
    } catch (err) {
        const why = err && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
        return { ok: false, status: 0, retryable: true, error: `${where} ${why}` };
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let delivering = false;

// Sends due outbox rows (oldest first, at most SEND_PER_TICK), then prunes old history. One run at a time.
async function deliver(conn, { now = new Date(), fetchImpl, gapMs = SEND_GAP_MS, id } = {}) {
    if (delivering) return { sent: 0, failed: 0, retried: 0, busy: true };
    delivering = true;
    const res = { sent: 0, failed: 0, retried: 0 };
    try {
        const due = conn.prepare(`SELECT o.*, w.url, w.auth_mode, w.secret, w.enabled FROM webhook_outbox o JOIN webhooks w ON w.id = o.webhook_id
            WHERE o.status = 'pending' AND o.next_attempt_at <= ? AND w.enabled = 1 ${id ? 'AND o.webhook_id = ?' : ''}
            ORDER BY o.id LIMIT ?`).all(...[now.toISOString(), ...(id ? [id] : []), SEND_PER_TICK]);
        const paused = new Set(); // a receiver that said "slow down" or is down is left alone for this run
        let first = true;
        for (const row of due) {
            if (paused.has(row.webhook_id)) continue;
            if (!first && gapMs) await sleep(gapMs);
            first = false;
            const r = await post(row, JSON.parse(row.payload), fetchImpl);
            const at = now; // one clock for the whole run (a run lasts seconds)
            if (r.ok) {
                conn.prepare("UPDATE webhook_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?").run(at.toISOString(), row.id);
                conn.prepare("UPDATE webhooks SET last_status = 'ok', last_at = ?, last_error = NULL WHERE id = ?").run(at.toISOString(), row.webhook_id);
                res.sent += 1;
                continue;
            }
            const attempts = row.attempts + 1;
            const final = !r.retryable || attempts >= MAX_ATTEMPTS;
            const wait = r.retryAfter ? r.retryAfter * 1000 : BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60000;
            conn.prepare('UPDATE webhook_outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
                .run(final ? 'failed' : 'pending', attempts, new Date(at.getTime() + wait).toISOString(), r.error, row.id);
            conn.prepare("UPDATE webhooks SET last_status = 'failing', last_at = ?, last_error = ? WHERE id = ?").run(at.toISOString(), r.error, row.webhook_id);
            if (final) res.failed += 1; else res.retried += 1;
            paused.add(row.webhook_id);
        }
        prune(conn, now);
    } finally {
        delivering = false;
    }
    return res;
}

function prune(conn, now = new Date()) {
    const ago = (days) => new Date(now.getTime() - days * 86400000).toISOString();
    conn.prepare("DELETE FROM webhook_outbox WHERE status = 'sent' AND sent_at < ?").run(ago(KEEP_SENT_DAYS));
    conn.prepare("DELETE FROM webhook_outbox WHERE status = 'failed' AND created_at < ?").run(ago(KEEP_FAILED_DAYS));
    conn.prepare("DELETE FROM webhook_state WHERE status = 'resolved' AND updated_at < ?").run(ago(KEEP_FAILED_DAYS));
}

// A failed row can be tried again from the dashboard.
function retryFailed(conn, id, now = new Date()) {
    return conn.prepare("UPDATE webhook_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE webhook_id = ? AND status = 'failed'")
        .run(now.toISOString(), id).changes;
}

// "Send test": one low-priority message straight to the receiver, outside the outbox. Resolves { ok, status, error? }.
async function sendTest(conn, id, { fetchImpl, now = new Date() } = {}) {
    const hook = raw(conn, id);
    if (!hook) throw new WebhookError('No such webhook.', null, 404);
    const eventId = `ph-${hook.id}-test-${now.getTime()}`;
    const r = await post(hook, {
        title: 'Personal Hub',
        body: `Test message for "${hook.name}": the webhook works.`,
        priority: 'low',
        tag: 'personal-hub:test',
        dedupe: eventId,
        source: 'personal-hub',
        event_id: eventId,
        state: 'test',
        occurred_at: now.toISOString(),
    }, fetchImpl);
    conn.prepare('UPDATE webhooks SET last_status = ?, last_at = ?, last_error = ? WHERE id = ?')
        .run(r.ok ? 'ok' : 'failing', now.toISOString(), r.ok ? null : r.error, id);
    return { ok: r.ok, status: r.status, ...(r.ok ? {} : { error: r.error }) };
}

/* ---------- scheduling ---------- */

let started = false;
let pokeTimer = null;

async function tick(conn) {
    check(conn);
    await deliver(conn);
}

// Boot: a first check shortly after start, then every five minutes. Tests never start it.
function start(getConn) {
    if (started) return;
    started = true;
    const run = () => tick(getConn()).catch((err) => console.error('Webhook tick failed:', err.message));
    setTimeout(run, FIRST_TICK_MS).unref();
    setInterval(run, TICK_MS).unref();
    start.getConn = getConn;
}

// Called after audited activity: a check a few seconds later, however many writes come in between (a batch import
// counts once). No-op until start() ran.
function poke() {
    if (!started || pokeTimer) return;
    pokeTimer = setTimeout(() => {
        pokeTimer = null;
        tick(start.getConn()).catch((err) => console.error('Webhook poke failed:', err.message));
    }, POKE_MS);
    pokeTimer.unref();
}

module.exports = {
    WebhookError, list, get, create, update, remove, events, check, deliver, retryFailed, sendTest, post, poke, start, prune,
    SEVERITIES, AUTH_MODES, MAX_ATTEMPTS, hostOf, tick,
};
