// Test setup file
process.env.NODE_ENV = 'test';
// Every test run gets a throwaway in-memory hub database.
process.env.HUB_DB_FILE = ':memory:';

// Increase timeout for async operations
jest.setTimeout(30000);

afterAll(() => {
    require('../db').close();
});
