const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const app = require('../app');
const { readJson } = require('../routes/portfolio/freshJson');

describe('freshJson', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-json-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('picks up edits without a restart', () => {
        const file = path.join(dir, 'a.json');
        fs.writeFileSync(file, JSON.stringify({ v: 1 }));
        expect(readJson(file)).toEqual({ v: 1 });

        fs.writeFileSync(file, JSON.stringify({ v: 2 }));
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // make the change visible to mtime
        expect(readJson(file)).toEqual({ v: 2 });
    });

    test('keeps the last good copy when an edit leaves invalid JSON', () => {
        const file = path.join(dir, 'c.json');
        fs.writeFileSync(file, JSON.stringify({ v: 1 }));
        expect(readJson(file)).toEqual({ v: 1 });

        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        fs.writeFileSync(file, '{ "v": ');
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        expect(readJson(file)).toEqual({ v: 1 });
        spy.mockRestore();
    });

    test('throws on invalid JSON when there is no good copy yet', () => {
        const file = path.join(dir, 'd.json');
        fs.writeFileSync(file, '{ "v": ');
        expect(() => readJson(file)).toThrow();
    });

    test('serves the cached object while the file is unchanged', () => {
        const file = path.join(dir, 'b.json');
        fs.writeFileSync(file, JSON.stringify({ v: 1 }));
        expect(readJson(file)).toBe(readJson(file));
    });
});

describe('portfolio file routes', () => {
    test('the portfolio data is served', async () => {
        const res = await request(app).get('/portfolio/atit').expect(200);
        expect(Array.isArray(res.body.portfolio)).toBe(true);
    });

    test('an existing detail page is served', async () => {
        await request(app).get('/portfolio/atit/md?id=0').expect(200);
    });

    test.each([
        ['/portfolio/atit/md?id=../../../README'],
        ['/portfolio/atit/md?id=../../../../node_modules/express/Readme'],
        ['/portfolio/atit/pdf?id=../../../x'],
        ['/portfolio/atit/img?id=../../../x'],
    ])('%s cannot escape its folder', async (url) => {
        const res = await request(app).get(url);
        expect(res.status).toBe(400);
    });
});
