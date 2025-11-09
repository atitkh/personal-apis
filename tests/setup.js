// Test setup file
const mongoose = require('mongoose');

// Mock environment variables for testing
process.env.NODE_ENV = 'test';
process.env.TOKEN_SECRET = 'test-secret';
process.env.DB_CONNECTION = 'mongodb://localhost:27017/test-personal-apis';

// Increase timeout for async operations
jest.setTimeout(30000);

// Setup and teardown for database
beforeAll(async () => {
    // You can add test database setup here if needed
});

afterAll(async () => {
    // Close database connections
    if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
    }
});