process.env.HUB_DB_FILE = ':memory:';
process.env.HUB_FAILED_KEY_MAX = '3';
process.env.HUB_KEY_RATE_MAX = '5';

const request = require('supertest');
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const keyLimits = require('../middleware/keyLimits');
const app = require('../app');

let good;
let second;

beforeAll(() => {
    const conn = db.get();
    good = apiKeys.create(conn, { name: 'agent', scopes: 'digests:read' }).key;
    second = apiKeys.create(conn, { name: 'agent-2', scopes: 'digests:read' }).key;
});
beforeEach(() => keyLimits.reset());
afterAll(() => db.close());

const auth = (key) => ({ Authorization: `Bearer ${key}` });

describe('per-key limit', () => {
    test('a key gets its allowance, then 429 with Retry-After', async () => {
        for (let i = 0; i < 5; i += 1) await request(app).get('/hub/digests').set(auth(good)).expect(200);
        const res = await request(app).get('/hub/digests').set(auth(good)).expect(429);
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        expect(res.body.message).toMatch(/this API key/i);
    });

    test('another key is not affected', async () => {
        for (let i = 0; i < 6; i += 1) await request(app).get('/hub/digests').set(auth(good));
        await request(app).get('/hub/digests').set(auth(second)).expect(200);
    });

    test('the window resets', () => {
        const t = 1_000_000;
        for (let i = 0; i < 5; i += 1) expect(keyLimits.takeKeyCall(42, t)).toBe(0);
        expect(keyLimits.takeKeyCall(42, t + 1000)).toBeGreaterThan(0);
        expect(keyLimits.takeKeyCall(42, t + keyLimits.WINDOW_MS + 1)).toBe(0);
    });

    test('MCP calls count against the same key', async () => {
        for (let i = 0; i < 5; i += 1) await request(app).get('/hub/digests').set(auth(good)).expect(200);
        await request(app).post('/hub/mcp').set(auth(good)).send({}).expect(429);
    });
});

describe('failed keys', () => {
    test('wrong keys are refused after the allowance, even a valid one from that address', async () => {
        for (let i = 0; i < 3; i += 1) await request(app).get('/hub/digests').set(auth('pak_wrong')).expect(401);
        const res = await request(app).get('/hub/digests').set(auth(good)).expect(429);
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        expect(res.body.message).toMatch(/invalid API keys/i);
    });

    test('a missing key is not counted as a failure', async () => {
        for (let i = 0; i < 6; i += 1) await request(app).get('/hub/digests').expect(401);
        await request(app).get('/hub/digests').set(auth(good)).expect(200);
    });

    test('the block ends with the window', () => {
        const t = 5_000_000;
        for (let i = 0; i < 3; i += 1) keyLimits.recordFailure('1.2.3.4', t);
        expect(keyLimits.blockedFor('1.2.3.4', t + 10)).toBeGreaterThan(0);
        expect(keyLimits.blockedFor('1.2.3.4', t + keyLimits.WINDOW_MS + 1)).toBe(0);
        expect(keyLimits.blockedFor('9.9.9.9', t)).toBe(0);
    });
});
