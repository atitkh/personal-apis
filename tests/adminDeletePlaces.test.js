// Permanent delete for places and queue spots (admin only). Every address and label in this file is invented.
const KEY = 'f'.repeat(40);
process.env.ADMIN_KEY = KEY;
process.env.HUB_DB_FILE = ':memory:';

const request = require('supertest');
const db = require('../db');
const audit = require('../services/audit');
const places = require('../services/places');
const app = require('../app');

const H = { 'X-Requested-With': 'hub-admin' };
const STREET = 'Quillfeather Lane';
let agent;
beforeAll(async () => {
    agent = request.agent(app);
    await agent.post('/admin/api/login').set(H).send({ key: KEY }).expect(200);
});
afterAll(() => db.close());

const conn = () => db.get();
const n = (sql, ...a) => conn().prepare(sql).get(...a).n;
const del = (path, body) => agent.delete(`/admin/api/${path}`).set(H).send(body);
const lastAudit = (action) => audit.recent(conn(), 5, { actions: [action] })[0];
const file = (geocode) => places.resolve(conn(), { geocode, suggest: true }).suggestion;

describe('delete places', () => {
    test('rules (an exclude rule too) and revisions go; the suggestion that led to it stays unlinked; audit has counts only', async () => {
        const made = places.create(conn(), { label: 'Pottery studio', rules: [{ type: 'street', value: STREET }, { type: 'street', value: 'Elm Row', exclude: true }] }, 'admin');
        places.update(conn(), made.id, { notes: 'Back door.' }, 'admin');
        const sug = file('9 Wrenfold Mews');
        places.acceptSuggestion(conn(), sug.id, { place_id: made.id }, 'admin');
        const pre = (await agent.get(`/admin/api/places/${made.id}/delete-preview`).expect(200)).body;
        expect(pre).toMatchObject({ label: 'Pottery studio', counts: { rules: 3, suggestions: 1 } });
        expect(pre.counts.revisions).toBeGreaterThanOrEqual(3);

        await del(`places/${made.id}`, {}).expect(400);
        expect((await del(`places/${made.id}`, { confirm: true }).expect(200)).body).toMatchObject({ status: 'deleted', label: 'Pottery studio' });
        expect(n('SELECT COUNT(*) AS n FROM places WHERE id = ?', made.id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM place_rules WHERE place_id = ?', made.id)).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM place_revisions WHERE place_id = ?', made.id)).toBe(0);
        const kept = conn().prepare('SELECT status, resolved_place_id FROM place_suggestions WHERE id = ?').get(sug.id);
        expect(kept).toEqual({ status: 'accepted', resolved_place_id: null });
        const row = lastAudit('place_deleted');
        expect(row.detail).toMatchObject({ id: made.id, label: 'Pottery studio', rules: 3, suggestions: 1 });
        expect(JSON.stringify(row)).not.toContain(STREET);
        expect(JSON.stringify(row)).not.toContain('Elm Row');
    });

    test('session, header and an existing place are required', async () => {
        const made = places.create(conn(), { label: 'Temp spot' }, 'admin');
        await request(app).delete(`/admin/api/places/${made.id}`).set(H).send({ confirm: true }).expect(401);
        await agent.delete(`/admin/api/places/${made.id}`).send({ confirm: true }).expect(403);
        await del('places/99999', { confirm: true }).expect(404);
        expect(n('SELECT COUNT(*) AS n FROM places WHERE id = ?', made.id)).toBe(1);
    });
});

describe('delete queue spots', () => {
    test('one spot of any status, audited by id and status (never the street)', async () => {
        const a = file('12 Brambleworth Close');
        await del(`places/suggestions/${a.id}`, {}).expect(400);
        await del(`places/suggestions/${a.id}`, { confirm: true }).expect(200);
        await del(`places/suggestions/${a.id}`, { confirm: true }).expect(404);
        const row = lastAudit('place_suggestion_deleted');
        expect(row.detail).toEqual({ suggestion_id: a.id, status: 'pending' });
        expect(JSON.stringify(row)).not.toContain('Brambleworth');
    });

    test('delete all dismissed keeps pending and accepted ones and counts', async () => {
        const p = file('1 Alpha Road');
        const d1 = file('2 Beta Road');
        const d2 = file('3 Gamma Road');
        places.dismissSuggestion(conn(), d1.id, 'admin');
        places.dismissSuggestion(conn(), d2.id, 'admin');
        const dismissed = places.suggestionCounts(conn()).dismissed;
        await del('places/suggestions/dismissed', {}).expect(400);
        expect((await del('places/suggestions/dismissed', { confirm: true }).expect(200)).body.count).toBe(dismissed);
        expect(places.suggestionCounts(conn()).dismissed).toBe(0);
        expect(n('SELECT COUNT(*) AS n FROM place_suggestions WHERE id = ?', p.id)).toBe(1);
        expect(lastAudit('place_suggestion_deleted').detail).toEqual({ count: dismissed, status: 'dismissed' });
    });

    test('the activity filter and feed know the new action', async () => {
        const out = (await agent.get('/admin/api/activity?type=places').expect(200)).body.events.map((e) => e.action);
        expect(out).toContain('place_suggestion_deleted');
    });
});
