// Webhooks: change detection (new / escalated / resolved, nothing for an unchanged item), the first-check baseline, the outbox
// with retries, secrets that never leave the hub, and the admin API. Everything here is invented.
const KEY = 'w'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const deadlines = require('../services/deadlines');
const webhooks = require('../services/webhooks');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const NOW = new Date('2026-11-11T16:00:00Z'); // 10:00 in Chicago
const at = (min) => new Date(NOW.getTime() + min * 60000);
const SECRET = 'sekret-token-0123456789';
const URL_ = 'http://10.0.0.5:8440/v1/hook/ph-test?x=1';

const addDeadline = (conn, extra = {}) => deadlines.create(conn, { title: 'Passport renewal', kind: 'document', due_date: '2026-11-20', ...extra }, 'tester').id;

// A fake receiver: records calls, answers with the next queued status (default 202).
function receiver(statuses = []) {
    const calls = [];
    const fn = async (url, opts) => {
        const status = statuses.length ? statuses.shift() : 202;
        calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body), raw: opts.body });
        return { status, headers: { get: (h) => (h.toLowerCase() === 'retry-after' && status === 429 ? '90' : null) } };
    };
    fn.calls = calls;
    return fn;
}

afterAll(() => db.close());

describe('webhooks service: configuration', () => {
    let conn;
    beforeEach(() => { conn = db.open(':memory:'); });
    afterEach(() => conn.close());

    test('create validates, and the row shows the host, never the address path or the secret', () => {
        const w = webhooks.create(conn, { name: 'Axis', url: URL_, auth_mode: 'bearer', secret: SECRET });
        expect(w).toMatchObject({ name: 'Axis', host: 'http://10.0.0.5:8440', has_secret: true, min_severity: 'attention', enabled: true, send_resolved: false, domains: null });
        expect(JSON.stringify(w)).not.toContain(SECRET);
        expect(JSON.stringify(w)).not.toContain('ph-test');
        expect(JSON.stringify(webhooks.list(conn))).not.toContain(SECRET);
    });

    test.each([
        [{ name: '', url: URL_ }, 'name'],
        [{ name: 'x', url: 'ftp://example.com/a' }, 'url'],
        [{ name: 'x', url: 'not a url' }, 'url'],
        [{ name: 'x', url: 'https://user:pw@example.com/a' }, 'url'],
        [{ name: 'x', url: URL_, min_severity: 'loud' }, 'min_severity'],
        [{ name: 'x', url: URL_, auth_mode: 'magic' }, 'auth_mode'],
        [{ name: 'x', url: URL_, domains: ['Bad Name'] }, 'domains'],
        [{ name: 'x', url: URL_, start: 'later' }, 'start'],
        [{ name: 'x', url: URL_, secret: 'two\nlines' }, 'secret'],
    ])('rejects %j', (body, field) => {
        expect(() => webhooks.create(conn, body)).toThrow(expect.objectContaining({ field }));
    });

    test('update is partial and keeps the secret unless one is sent; delete cascades', () => {
        const w = webhooks.create(conn, { name: 'Axis', url: URL_, secret: SECRET });
        const u = webhooks.update(conn, w.id, { min_severity: 'urgent', domains: ['deadlines'] });
        expect(u).toMatchObject({ min_severity: 'urgent', domains: ['deadlines'], has_secret: true });
        expect(webhooks.update(conn, w.id, { secret: null }).has_secret).toBe(false);
        expect(() => webhooks.update(conn, w.id, {})).toThrow(/Nothing to change/);
        expect(() => webhooks.update(conn, 999, { name: 'x' })).toThrow(expect.objectContaining({ status: 404 }));
        conn.prepare("INSERT INTO webhook_state (webhook_id, item_id, domain, severity, text, status, n, updated_at) VALUES (?, 'a', 'deadlines', 'info', 't', 'active', 1, 'x')").run(w.id);
        webhooks.remove(conn, w.id);
        expect(conn.prepare('SELECT COUNT(*) AS n FROM webhook_state').get().n).toBe(0);
    });
});

describe('webhooks service: change detection', () => {
    let conn;
    beforeEach(() => { conn = db.open(':memory:'); });
    afterEach(() => conn.close());

    const hook = (extra = {}) => webhooks.create(conn, { name: 'Axis', url: URL_, secret: SECRET, ...extra });
    const outbox = () => conn.prepare('SELECT * FROM webhook_outbox ORDER BY id').all().map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

    test('start "now": the first check records what exists and sends nothing; a later new item sends once', () => {
        addDeadline(conn); // due in 9 days: inside its 14-day lead window, so an attention item
        hook();
        expect(webhooks.check(conn, { now: NOW })).toMatchObject({ checked: 1, baseline: 1, new: 0 });
        expect(outbox()).toHaveLength(0);
        addDeadline(conn, { title: 'Insurance', due_date: '2026-11-25' });
        expect(webhooks.check(conn, { now: at(5) })).toMatchObject({ new: 1 });
        expect(webhooks.check(conn, { now: at(10) })).toMatchObject({ new: 0, escalated: 0 }); // unchanged: nothing
        expect(outbox()).toHaveLength(1);
        expect(outbox()[0].payload).toMatchObject({ title: 'Deadlines', priority: 'normal', state: 'new', severity: 'attention', domain: 'deadlines', source: 'personal-hub' });
        expect(outbox()[0].payload.body).toMatch(/^Insurance due in 14 days/);
    });

    test('start "send": everything that exists is new on the first check', () => {
        addDeadline(conn);
        hook({ start: 'send' });
        expect(webhooks.check(conn, { now: NOW })).toMatchObject({ baseline: 0, new: 1 });
    });

    test('a text change alone (days counting down) sends nothing; becoming urgent sends one escalated event', () => {
        addDeadline(conn, { due_date: '2026-11-20' });
        hook({ start: 'send' });
        webhooks.check(conn, { now: NOW });
        webhooks.check(conn, { now: new Date('2026-11-12T16:00:00Z') }); // "in 8 days" now: same severity
        expect(outbox()).toHaveLength(1);
        // urgent_days defaults to 3: three days out it is urgent
        const r = webhooks.check(conn, { now: new Date('2026-11-17T16:00:00Z') });
        expect(r).toMatchObject({ escalated: 1, new: 0 });
        const last = outbox().pop();
        expect(last).toMatchObject({ state: 'escalated' });
        expect(last.payload).toMatchObject({ priority: 'urgent', severity: 'urgent' });
        expect(last.payload.body).toMatch(/^Now urgent: Passport renewal due in 3 days/);
        expect(webhooks.check(conn, { now: new Date('2026-11-17T17:00:00Z') })).toMatchObject({ new: 0, escalated: 0 });
    });

    test('resolved is sent only when asked for; an item that comes back is new again with a fresh event id', () => {
        const id = addDeadline(conn);
        hook({ start: 'send', send_resolved: true });
        webhooks.check(conn, { now: NOW });
        deadlines.done(conn, id, 'tester', { now: NOW });
        expect(webhooks.check(conn, { now: at(5) })).toMatchObject({ resolved: 1 });
        expect(outbox().pop()).toMatchObject({ state: 'resolved' });
        expect(outbox().pop().payload).toMatchObject({ priority: 'low' });
        expect(outbox().pop().payload.body).toMatch(/^Resolved: Passport renewal/);
        deadlines.update(conn, id, { status: 'active' }, 'tester');
        expect(webhooks.check(conn, { now: at(10) })).toMatchObject({ new: 1 });
        const ids = outbox().map((o) => o.event_id);
        expect(new Set(ids).size).toBe(3);
    });

    test('without send_resolved a resolved item stays quiet but is remembered as resolved', () => {
        const id = addDeadline(conn);
        hook({ start: 'send' });
        webhooks.check(conn, { now: NOW });
        deadlines.done(conn, id, 'tester', { now: NOW });
        expect(webhooks.check(conn, { now: at(5) })).toMatchObject({ resolved: 0 });
        expect(outbox()).toHaveLength(1);
        expect(conn.prepare('SELECT status FROM webhook_state').get().status).toBe('resolved');
    });

    test('min severity and the domain filter decide what is watched', () => {
        addDeadline(conn); // attention
        hook({ start: 'send', min_severity: 'urgent' });
        expect(webhooks.check(conn, { now: NOW })).toMatchObject({ new: 0 });
        conn.prepare('DELETE FROM webhooks').run();
        hook({ start: 'send', domains: ['flights'] });
        expect(webhooks.check(conn, { now: NOW })).toMatchObject({ new: 0 });
    });

    test('two webhooks keep their own state; a disabled one is not checked', () => {
        addDeadline(conn);
        const a = hook({ start: 'send' });
        hook({ start: 'send', enabled: false });
        expect(webhooks.check(conn, { now: NOW })).toMatchObject({ checked: 1, new: 1 });
        webhooks.update(conn, a.id, { enabled: false });
        expect(webhooks.check(conn, { now: at(5) }).checked).toBe(0);
    });

    test('items beyond the briefing cap are still watched (they do not look resolved)', () => {
        for (let i = 0; i < 25; i++) addDeadline(conn, { title: `Item ${i}`, due_date: '2026-11-20' });
        hook({ start: 'send', send_resolved: true });
        expect(webhooks.check(conn, { now: NOW })).toMatchObject({ new: 25 });
        expect(webhooks.check(conn, { now: at(5) })).toMatchObject({ new: 0, resolved: 0 });
    });
});

describe('webhooks service: delivery', () => {
    let conn;
    beforeEach(() => { conn = db.open(':memory:'); });
    afterEach(() => conn.close());

    const setup = (extra = {}) => {
        addDeadline(conn);
        const w = webhooks.create(conn, { name: 'Axis', url: URL_, secret: SECRET, start: 'send', ...extra });
        webhooks.check(conn, { now: NOW });
        return w;
    };

    test('bearer: sends JSON with the token, marks the row sent and the webhook ok', async () => {
        const w = setup();
        const rx = receiver();
        const r = await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        expect(r.sent).toBe(1);
        expect(rx.calls[0].url).toBe(URL_);
        expect(rx.calls[0].headers.Authorization).toBe(`Bearer ${SECRET}`);
        expect(rx.calls[0].body).toMatchObject({ title: 'Deadlines', priority: 'normal', tag: 'personal-hub:deadlines' });
        expect(rx.calls[0].body.dedupe).toBe(rx.calls[0].body.event_id);
        expect(webhooks.get(conn, w.id)).toMatchObject({ last_status: 'ok', pending: 0, failed: 0 });
        await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        expect(rx.calls).toHaveLength(1); // nothing sent twice
    });

    test('hmac: signs the exact body bytes', async () => {
        setup({ auth_mode: 'hmac' });
        const rx = receiver();
        await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        const want = `sha256=${crypto.createHmac('sha256', SECRET).update(rx.calls[0].raw).digest('hex')}`;
        expect(rx.calls[0].headers['X-Hub-Signature-256']).toBe(want);
        expect(rx.calls[0].headers.Authorization).toBeUndefined();
    });

    test('a server error retries with backoff and then goes through; the error names the host only', async () => {
        const w = setup();
        const rx = receiver([503]);
        let r = await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        expect(r).toMatchObject({ retried: 1, sent: 0 });
        const row = conn.prepare('SELECT * FROM webhook_outbox').get();
        expect(row).toMatchObject({ status: 'pending', attempts: 1 });
        expect(row.last_error).toBe('http://10.0.0.5:8440 answered HTTP 503');
        expect(row.last_error).not.toContain(SECRET);
        expect(webhooks.get(conn, w.id)).toMatchObject({ last_status: 'failing' });
        r = await webhooks.deliver(conn, { now: at(0.5), fetchImpl: rx, gapMs: 0 });
        expect(r.sent).toBe(0); // not due yet (1 minute)
        r = await webhooks.deliver(conn, { now: at(2), fetchImpl: rx, gapMs: 0 });
        expect(r.sent).toBe(1);
        expect(webhooks.get(conn, w.id)).toMatchObject({ last_status: 'ok', last_error: null });
    });

    test('a client error (wrong token) fails for good; Retry now puts it back', async () => {
        const w = setup();
        const rx = receiver([401]);
        const r = await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        expect(r.failed).toBe(1);
        expect(conn.prepare('SELECT status FROM webhook_outbox').get().status).toBe('failed');
        expect(webhooks.retryFailed(conn, w.id, at(1))).toBe(1);
        expect((await webhooks.deliver(conn, { now: at(1), fetchImpl: rx, gapMs: 0 })).sent).toBe(1);
    });

    test('429 honours Retry-After and pauses that receiver for the run', async () => {
        addDeadline(conn, { title: 'Second', due_date: '2026-11-21' });
        const w = webhooks.create(conn, { name: 'Axis', url: URL_, start: 'send' });
        webhooks.check(conn, { now: NOW });
        const rx = receiver([429]);
        const r = await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        expect(rx.calls).toHaveLength(1);
        expect(r.retried).toBe(1);
        const row = conn.prepare("SELECT next_attempt_at FROM webhook_outbox WHERE status = 'pending' AND attempts = 1").get();
        expect(Date.parse(row.next_attempt_at) - NOW.getTime()).toBeGreaterThanOrEqual(90 * 1000 - 1000);
        expect(w.id).toBeGreaterThan(0);
    });

    test('a network failure is retryable; after the last attempt the row fails', async () => {
        setup();
        const boom = async () => { throw new Error(`connect ECONNREFUSED ${URL_} ${SECRET}`); };
        let t = NOW;
        for (let i = 0; i < webhooks.MAX_ATTEMPTS; i++) {
            await webhooks.deliver(conn, { now: t, fetchImpl: boom, gapMs: 0 });
            t = new Date(t.getTime() + 13 * 3600 * 1000);
        }
        const row = conn.prepare('SELECT * FROM webhook_outbox').get();
        expect(row).toMatchObject({ status: 'failed', attempts: webhooks.MAX_ATTEMPTS });
        expect(row.last_error).toBe('http://10.0.0.5:8440 could not be reached');
    });

    test('a disabled webhook delivers nothing; old history is pruned', async () => {
        const w = setup();
        webhooks.update(conn, w.id, { enabled: false });
        const rx = receiver();
        await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        expect(rx.calls).toHaveLength(0);
        webhooks.update(conn, w.id, { enabled: true });
        await webhooks.deliver(conn, { now: NOW, fetchImpl: rx, gapMs: 0 });
        webhooks.prune(conn, new Date(NOW.getTime() + 15 * 86400000));
        expect(conn.prepare('SELECT COUNT(*) AS n FROM webhook_outbox').get().n).toBe(0);
    });

    test('send test goes straight out as a low message with its own dedupe', async () => {
        const w = setup();
        const rx = receiver();
        const r = await webhooks.sendTest(conn, w.id, { fetchImpl: rx, now: NOW });
        expect(r).toEqual({ ok: true, status: 202 });
        expect(rx.calls[0].body).toMatchObject({ priority: 'low', state: 'test' });
        expect(conn.prepare('SELECT COUNT(*) AS n FROM webhook_outbox').get().n).toBe(1); // only the real event, not the test
    });
});

describe('webhooks admin API', () => {
    let agent;
    beforeAll(async () => {
        agent = request.agent(app);
        await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
    });
    beforeEach(() => { db.get().exec('DELETE FROM webhooks'); });

    const ENDPOINTS = [
        ['get', '/admin/api/webhooks'],
        ['post', '/admin/api/webhooks'],
        ['put', '/admin/api/webhooks/1'],
        ['delete', '/admin/api/webhooks/1'],
        ['post', '/admin/api/webhooks/1/test'],
        ['post', '/admin/api/webhooks/1/run'],
        ['get', '/admin/api/webhooks/1/events'],
    ];

    test('every endpoint needs an admin session and the header; a hub API key is no admin', async () => {
        const hubKey = apiKeys.create(db.get(), { name: 'ha', scopes: '*' }).key;
        for (const [m, url] of ENDPOINTS) {
            await request(app)[m](url).send({}).expect(m === 'get' ? 401 : 403);
            await request(app)[m](url).set(H).send({}).expect(401);
            await request(app)[m](url).set('Authorization', `Bearer ${hubKey}`).set('X-API-Key', hubKey).set(H).send({}).expect(401);
            if (m !== 'get') await agent[m](url).send({}).expect(403);
        }
    });

    test('create, list, edit, delete; the secret and path never come back; audit rows carry names only', async () => {
        const made = (await agent.post('/admin/api/webhooks').set(H).send({ name: 'Axis', url: URL_, secret: SECRET, auth_mode: 'hmac' }).expect(201)).body;
        expect(made).toMatchObject({ name: 'Axis', host: 'http://10.0.0.5:8440', has_secret: true, auth_mode: 'hmac' });
        const listed = (await agent.get('/admin/api/webhooks').expect(200)).body.webhooks;
        expect(listed).toHaveLength(1);
        expect(JSON.stringify(listed)).not.toContain(SECRET);
        await agent.put(`/admin/api/webhooks/${made.id}`).set(H).send({ min_severity: 'urgent' }).expect(200);
        await agent.put(`/admin/api/webhooks/${made.id}`).set(H).send({ min_severity: 'loud' }).expect(400);
        await agent.delete(`/admin/api/webhooks/${made.id}`).set(H).send({}).expect(400); // needs confirm
        await agent.delete(`/admin/api/webhooks/${made.id}`).set(H).send({ confirm: true }).expect(200);
        await agent.delete(`/admin/api/webhooks/${made.id}`).set(H).send({ confirm: true }).expect(404);
        const rows = db.get().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'webhook_%' ORDER BY id").all();
        expect(rows.map((r) => r.action)).toEqual(['webhook_created', 'webhook_updated', 'webhook_deleted']);
        const all = rows.map((r) => r.detail || '').join(' ');
        expect(all).not.toContain(SECRET);
        expect(all).not.toContain('ph-test');
    });

    test('bad input is a 400 with the field; unknown ids are 404', async () => {
        const r = await agent.post('/admin/api/webhooks').set(H).send({ name: 'x', url: 'ftp://nope' }).expect(400);
        expect(r.body.field).toBe('url');
        await agent.put('/admin/api/webhooks/77').set(H).send({ name: 'x' }).expect(404);
        await agent.post('/admin/api/webhooks/77/run').set(H).send({}).expect(404);
        await agent.get('/admin/api/webhooks/abc/events').expect(404);
    });

    test('run checks and delivers; events lists the outbox', async () => {
        addDeadline(db.get());
        const made = (await agent.post('/admin/api/webhooks').set(H).send({ name: 'Axis', url: URL_, start: 'send' }).expect(201)).body;
        const real = globalThis.fetch;
        const rx = receiver();
        globalThis.fetch = rx;
        try {
            const r = (await agent.post(`/admin/api/webhooks/${made.id}/run`).set(H).send({}).expect(200)).body;
            expect(r.checked.new).toBe(1);
            expect(r.delivered.sent).toBe(1);
            const ev = (await agent.get(`/admin/api/webhooks/${made.id}/events`).expect(200)).body.events;
            expect(ev).toHaveLength(1);
            expect(ev[0]).toMatchObject({ state: 'new', status: 'sent', priority: 'normal' });
            expect(ev[0].text).toMatch(/Passport renewal/);
        } finally {
            globalThis.fetch = real;
        }
    });
});

describe('webhooks stay out of /hub and MCP', () => {
    test('no /hub route, MCP tool or key scope mentions webhooks', () => {
        const routes = require('./__snapshots__/routes.json');
        const list = Array.isArray(routes) ? routes : Object.values(routes).flat();
        const hits = list.filter((r) => /webhook/i.test(r) && !r.split(' ')[1].startsWith('/admin/api/'));
        expect(hits).toEqual([]);
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
        for (const f of walk(path.join(__dirname, '..', 'services', 'mcp'))) {
            expect(`${f}: ${/webhook/i.test(fs.readFileSync(f, 'utf8'))}`).toMatch(/: false$/);
        }
    });
});
