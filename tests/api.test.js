const request = require('supertest');
const app = require('../app');

describe('API Health and Info', () => {
    test('GET /health should return health status', async () => {
        const response = await request(app)
            .get('/health');

        // In test environment, database might not be connected, so we allow both 200 and 503
        expect([200, 503]).toContain(response.status);
        expect(response.body).toHaveProperty('timestamp');
        expect(response.body).toHaveProperty('uptime');
        
        if (response.status === 200) {
            expect(response.body).toHaveProperty('status', 'OK');
            expect(response.body).toHaveProperty('database');
        } else {
            expect(response.body).toHaveProperty('status', 'WARNING');
        }
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
    });

    test('GET /nonexistent should return 404', async () => {
        const response = await request(app)
            .get('/nonexistent')
            .expect(404);

        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toHaveProperty('message', 'Route not found');
    });
});