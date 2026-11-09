const request = require('supertest');
const app = require('../app');

describe('API Health and Info', () => {
    test('GET /health reports a healthy database without leaking connection details', async () => {
        const response = await request(app).get('/health').expect(200);

        expect(response.body).toHaveProperty('status', 'OK');
        expect(response.body).toHaveProperty('timestamp');
        expect(response.body).toHaveProperty('uptime');
        expect(response.body.database).toMatchObject({ status: 'healthy' });
        expect(JSON.stringify(response.body)).not.toMatch(/host|mongodb|\.db/i);
    });

    test('GET /api should return API information', async () => {
        const response = await request(app)
            .get('/api')
            .expect(200);

        expect(response.body).toHaveProperty('name', 'Personal APIs');
        expect(response.body).toHaveProperty('version');
        expect(response.body).toHaveProperty('endpoints');
        expect(response.body.endpoints).toHaveProperty('v1');
        expect(response.body.endpoints).toHaveProperty('legacy');
        expect(response.body.endpoints).not.toHaveProperty('auth');
    });

    test('GET /nonexistent should return 404', async () => {
        const response = await request(app)
            .get('/nonexistent')
            .expect(404);

        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toHaveProperty('message', 'Route not found');
    });
});

describe('Protected routes', () => {
    test('attendance routes demand an API key', async () => {
        await request(app).get('/kerkarcreations/attendance/get').expect(401);
        await request(app).post('/kerkarcreations/attendance/add?name=x').expect(401);
    });

    test('the old login routes are gone', async () => {
        await request(app).post('/auth/login').expect(404);
        await request(app).post('/auth/register').expect(404);
    });

    test('the public welcome route still answers', async () => {
        await request(app).get('/kerkarcreations/attendance').expect(200);
    });
});
