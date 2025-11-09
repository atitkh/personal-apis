module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverage: true,
    collectCoverageFrom: [
        'app.js',
        'routes/**/*.js',
        'middleware/**/*.js',
        '!routes/**/modules/**',
        '!routes/**/loadout/**',
        '!**/node_modules/**'
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js']
};