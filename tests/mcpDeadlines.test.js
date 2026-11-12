process.env.HUB_DB_FILE = ':memory:';

// The deadlines agent tool. Every deadline, reference and note in this file is invented.
const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const domains = require('../services/domains');
const deadlines = require('../services/deadlines');
const { DATA_NOTE } = require('../services/mcp/util');
const app = require('../app');

const keys = {};
const make = (name, scopes) => { keys[name] = apiKeys.create(db.get(), { name, scopes }).key; };
const REF = 'PPT-7731-ZKQ';
const CANARY_NOTE = 'canary-note-heronsgate';
let passport;
let netflix;

beforeAll(() => {
    make('reader', 'deadlines:read');
    make('editor', 'deadlines:read, deadlines:agent-write');
    make('edit-only', 'deadlines:agent-write');
    make('rest-writer', 'deadlines:read, deadlines:api-write');
    make('other', 'flights:read');
    make('all', 'deadlines:*');
    const conn = db.get();
    passport = deadlines.create(conn, { title: 'Passport', kind: 'document', due_date: '2099-03-01', reference: REF, notes: CANARY_NOTE, lead_days: 90, urgent_days: 14 }, 'seed').id;
    netflix = deadlines.create(conn, { title: 'Netflix', kind: 'subscription', due_date: '2000-01-15', repeat_kind: 'monthly', amount_cents: 1599, currency: 'USD', cycle: 'monthly' }, 'seed').id;
});
afterAll(() => db.close());
afterEach(() => {
    domains.setEnabled(db.get(), 'deadlines', true, 'test');
    domains.setMcpMode(db.get(), 'deadlines', 'read', 'test');
});

const rpc = (key, method, params = {}, id = 1) => request(app).post('/hub/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${keys[key]}`)
    .send({ jsonrpc: '2.0', id, method, params });
const listTools = async (key) => (await rpc(key, 'tools/list').expect(200)).body.result.tools;
const tool = async (key) => (await listTools(key)).find((t) => t.name === 'deadlines');
const actionsOf = async (key) => {
    const t = await tool(key);
    return t ? [...t.inputSchema.properties.action.enum].sort() : null;
};
const call = async (key, args) => (await rpc(key, 'tools/call', { name: 'deadlines', arguments: args }).expect(200)).body.result;
const textOf = (r) => r.content[0].text;
const jsonOf = (r) => JSON.parse(textOf(r).replace(`${DATA_NOTE}\n`, ''));
const errorOf = (r) => {
    if (!r.isError) return 'no error';
    try { return JSON.parse(textOf(r)).error; } catch (err) { return /^MCP error/.test(textOf(r)) ? 'refused' : textOf(r); }
};

describe('visibility per key and mode', () => {
    test('read mode: read actions for a read key; nothing for others', async () => {
        expect(await actionsOf('reader')).toEqual(['get', 'list', 'upcoming']);
        expect(await actionsOf('editor')).toEqual(['get', 'list', 'upcoming']);
        expect(await actionsOf('all')).toEqual(['get', 'list', 'upcoming']);
        expect(await actionsOf('edit-only')).toBeNull();      // no read scope: the tool is not offered
        expect(await actionsOf('rest-writer')).toEqual(['get', 'list', 'upcoming']);
        expect(await actionsOf('other')).toBeNull();
    });

    test('write mode adds add, edit, done and end only with deadlines:agent-write', async () => {
        domains.setMcpMode(db.get(), 'deadlines', 'write', 'test');
        expect(await actionsOf('reader')).toEqual(['get', 'list', 'upcoming']);
        expect(await actionsOf('editor')).toEqual(['add', 'done', 'edit', 'end', 'get', 'list', 'upcoming']);
        expect(await actionsOf('all')).toEqual(['add', 'done', 'edit', 'end', 'get', 'list', 'upcoming']);
        expect(await actionsOf('rest-writer')).toEqual(['get', 'list', 'upcoming']); // deadlines:api-write is REST only
        expect(await actionsOf('edit-only')).toBeNull();
    });

    test('mode off or domain off hides the tool', async () => {
        domains.setMcpMode(db.get(), 'deadlines', 'off', 'test');
        expect(await actionsOf('reader')).toBeNull();
        domains.setMcpMode(db.get(), 'deadlines', 'read', 'test');
        domains.setEnabled(db.get(), 'deadlines', false, 'test');
        expect(await actionsOf('reader')).toBeNull();
    });

    test('include_reference is only offered to keys that can read, and the tool starts with the data note', async () => {
        const t = await tool('reader');
        expect(t.inputSchema.properties).toHaveProperty('include_reference');
        expect(t.inputSchema.properties).not.toHaveProperty('title'); // add/edit fields come with write mode
        const r = await call('reader', { action: 'list' });
        expect(textOf(r).startsWith(DATA_NOTE)).toBe(true);
    });

    test('a call to an action the key cannot use is refused', async () => {
        expect(errorOf(await call('reader', { action: 'add', title: 'x', due_date: '2099-01-01' }))).toMatch(/refused|not_allowed|Invalid/);
        domains.setMcpMode(db.get(), 'deadlines', 'write', 'test');
        expect(errorOf(await call('reader', { action: 'done', id: passport }))).toMatch(/refused|not_allowed|Invalid/);
        expect(deadlines.get(db.get(), passport).status).toBe('active');
    });
});

describe('reading: the reference stays out by default', () => {
    test('list, upcoming and get say has_reference and never show the number', async () => {
        const list = jsonOf(await call('reader', { action: 'list' }));
        expect(list.total).toBe(2);
        expect(list.deadlines.map((d) => d.title)).toEqual(['Netflix', 'Passport']);
        expect(list.deadlines[1]).toMatchObject({ has_reference: true, window: 'later', kind: 'document' });
        expect(list.deadlines[0]).toMatchObject({ overdue: true, window: 'urgent', amount_cents: 1599 });
        expect(list.deadlines[0]).not.toHaveProperty('has_reference');
        const up = jsonOf(await call('reader', { action: 'upcoming', days: 30 }));
        expect(up.deadlines.map((d) => d.title)).toEqual(['Netflix']);
        const got = jsonOf(await call('reader', { action: 'get', id: passport }));
        expect(got).toMatchObject({ title: 'Passport', has_reference: true, notes: CANARY_NOTE });
        expect(got).not.toHaveProperty('reference');
        for (const r of [await call('reader', { action: 'list' }), await call('reader', { action: 'upcoming' }), await call('reader', { action: 'get', id: passport })]) {
            expect(textOf(r)).not.toContain(REF);
        }
    });

    test('get with include_reference=true returns it', async () => {
        const got = jsonOf(await call('reader', { action: 'get', id: passport, include_reference: true }));
        expect(got.reference).toBe(REF);
        expect(got).not.toHaveProperty('has_reference');
        expect(errorOf(await call('reader', { action: 'get', id: 9999 }))).toBe('not_found');
        expect(errorOf(await call('reader', { action: 'get' }))).toBe('bad_request');
    });

    test('list filters', async () => {
        const titles = async (extra) => jsonOf(await call('reader', { action: 'list', ...extra })).deadlines.map((d) => d.title);
        expect(await titles({ kind: 'subscription' })).toEqual(['Netflix']);
        expect(await titles({ overdue: true })).toEqual(['Netflix']);
        expect(await titles({ q: 'pass' })).toEqual(['Passport']);
        expect(await titles({ due_after: '2099-01-01' })).toEqual(['Passport']);
        expect(await titles({ status: 'ended' })).toEqual([]);
        expect(errorOf(await call('reader', { action: 'list', kind: 'pet' }))).toBe('bad_kind');
    });
});

describe('writing', () => {
    beforeEach(() => domains.setMcpMode(db.get(), 'deadlines', 'write', 'test'));

    test('add, edit, done and end for a key with deadlines:agent-write; results never carry the reference', async () => {
        const added = jsonOf(await call('editor', { action: 'add', title: 'Renters insurance', kind: 'insurance', due_date: '2099-09-01', reference: 'POL-99-ZZ', lead_days: 30, urgent_days: 7, repeat_kind: 'yearly' }));
        expect(added).toMatchObject({ status: 'created', title: 'Renters insurance', rev: 1 });
        expect(JSON.stringify(added)).not.toContain('POL-99-ZZ');
        const id = added.id;
        expect(deadlines.get(db.get(), id).reference).toBe('POL-99-ZZ');
        const edited = jsonOf(await call('editor', { action: 'edit', id, due_date: '2099-09-15', note: 'new policy date' }));
        expect(edited).toMatchObject({ status: 'updated', rev: 2, fields: ['due_date'] });
        expect(errorOf(await call('editor', { action: 'edit', id }))).toBe('bad_request');
        expect(errorOf(await call('editor', { action: 'edit', id, status: 'done' }))).toBe('bad_request');
        const rolled = jsonOf(await call('editor', { action: 'done', id }));
        expect(rolled).toMatchObject({ status: 'rolled', next_due: '2100-09-15' });
        const ended = jsonOf(await call('editor', { action: 'end', id }));
        expect(ended.status).toBe('ended');
        expect(jsonOf(await call('editor', { action: 'edit', id, status: 'active' })).status).toBe('updated');
        expect(errorOf(await call('editor', { action: 'done' }))).toBe('bad_request');
        expect(errorOf(await call('editor', { action: 'add', title: 'No date' }))).toBe('bad_date');
        expect(errorOf(await call('editor', { action: 'add', title: 'Money on a task', kind: 'task', due_date: '2099-01-01', amount_cents: 5, currency: 'USD' }))).toBe('money_not_allowed');
        expect(deadlines.history(db.get(), id)[0].actor).toBe('editor');
    });

    test('a read-mode domain refuses writes even for an edit key', async () => {
        domains.setMcpMode(db.get(), 'deadlines', 'read', 'test');
        expect(errorOf(await call('editor', { action: 'add', title: 'x', due_date: '2099-01-01' }))).toMatch(/refused|not_allowed|Invalid/);
        expect(jsonOf(await call('reader', { action: 'list' })).total).toBeGreaterThan(0);
    });
});
