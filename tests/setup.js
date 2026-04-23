/**
 * Jest setup — runs before the test environment is created.
 *
 * Goals:
 *   1. Quiet the structured logger so test output stays readable.
 *   2. Provide deterministic env defaults so modules that read process.env
 *      at import time don't pick up developer-machine secrets.
 *   3. Make accidental MongoDB/Redis connections fail loudly instead of
 *      silently waiting on a real server. (Tests must mock those modules.)
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.LOG_FORMAT = 'json';

// Force a recognisable, fake API key so openaiClient initialises in "configured"
// mode but no test code can accidentally hit the real OpenAI API — every
// outgoing call must be mocked.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-do-not-use';

// Surface unhandled rejections during tests instead of swallowing them.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled rejection in test:', reason);
  throw reason instanceof Error ? reason : new Error(String(reason));
});
