/**
 * Jest configuration.
 *
 * Test layout:
 *   - tests/unit/**       — fast, no I/O. Mongoose models and external services mocked.
 *   - tests/integration/  — hits a test Mongo + Redis. Run with INTEGRATION=1.
 *   - src/__tests__/      — legacy/smoke tests.
 *
 * Most modules in this repo connect to MongoDB/Redis at import time. Tests
 * MUST mock those modules instead of importing them transitively. See
 * tests/setup.js for the global env setup.
 */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.js'],
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.test.js',
    '**/?(*.)+(spec|test).js'
  ],
  collectCoverageFrom: [
    'src/services/ai/**/*.js',
    'src/services/cacheService.js',
    'src/services/aiService.js',
    'src/controllers/analyticsController.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html'],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 10000
};
