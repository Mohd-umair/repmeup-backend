# Testing — Backend

Jest-based unit tests for the backend. All tests run **without any external
services** (no MongoDB, no Redis, no OpenAI); external dependencies are mocked
per-test.

## Running

```bash
# Fast feedback loop
npm test

# Watch mode
npm run test:watch

# Run a single file
npx jest tests/unit/services/ai/sentimentService.test.js

# Run a single test by name
npx jest -t "cache HIT short-circuits"
```

Coverage reports go to `coverage/` (HTML) and print to the terminal.

## Layout

```
tests/
├── setup.js                          — global jest setup (env vars, log level)
└── unit/
    ├── services/
    │   ├── cacheService.test.js      — analytics key derivation
    │   ├── aiService.facade.test.js  — facade contract (34 methods, 6 props)
    │   └── ai/
    │       ├── sentimentService.test.js
    │       ├── intentClassificationService.test.js
    │       └── autoReplyService.test.js
    └── controllers/
        └── analyticsController.cache.test.js
```

The legacy `src/__tests__/smoke.test.js` is the pre-existing placeholder;
new tests should go under `tests/unit/**`.

## What is tested

| Area                             | Suite                                         | Tests | Coverage (stmt) |
|----------------------------------|-----------------------------------------------|-------|-----------------|
| `services/ai/sentimentService`   | sentimentService.test.js                      | 15    | **100%**        |
| `services/ai/intentClassification` | intentClassificationService.test.js         | 26    | **100%**        |
| `services/ai/autoReplyService`   | autoReplyService.test.js                      | 32    | **93%**         |
| `services/aiService` (facade)    | aiService.facade.test.js                      | 56    | **75%**         |
| `services/cacheService`          | cacheService.test.js                          | 11    | key helpers only |
| `controllers/analyticsController` (caching) | analyticsController.cache.test.js  | 13    | **49%** (cache paths covered) |

Everything passes in under a second.

## Writing new tests

### 1) Mock at the module boundary, not the function level

```js
// ✅ Good — mock the whole module once, drive behaviour per test.
jest.mock('../../../src/services/ai/openaiClient', () => ({
  chatCompletion: jest.fn(),
  hasApiKey: () => true,
  // ... other props ...
}));

const openaiClient = require('../../../src/services/ai/openaiClient');
openaiClient.chatCompletion.mockResolvedValue({ data: { ... } });
```

### 2) `jest.mock()` is HOISTED above `require()` — prefix shared mocks with `mock*`

Jest's Babel transform hoists `jest.mock(...)` above every other statement
in the file, including `const` declarations. You'll get

> The module factory of `jest.mock()` is not allowed to reference any
> out-of-scope variables.

unless the variable name starts with `mock` (case-insensitive) or you
declare the helper **inside** the factory.

### 3) Never hit a real DB/Redis/OpenAI — contract tests, not integration tests

Tests in `tests/unit/**` must run offline. Stub Mongoose models,
`cacheService`, the OpenAI client, and any other I/O boundary. If you need
real I/O, put the test in `tests/integration/**` (not yet wired up; add
when the first integration test lands).

### 4) Test behaviour, not implementation

For AI services, test return **shapes**, fallback paths, and eligibility
decisions. Don't assert on exact prompt strings — those change frequently
and don't affect callers.

### 5) Respect the logger

Test setup sets `LOG_LEVEL=error`. Don't add test-only `console.log`s —
use `logger.info` if you really need trace output.

## Coverage gaps to close next

Priority order (highest-value first):

1. **`replyGenerationService`** — biggest module, heavy prompt-assembly logic.
   Test the KB integration, bucket context, self-assessment mode, and error
   propagation.
2. **`postGenerationService`** — `generatePost`, `generatePostVariants`,
   `generateEventPost` — same pattern as the reply service tests.
3. **`knowledgeBaseSearchService`** — 3-stage search cascade. Mock
   `KnowledgeBase.find()` chain and verify the stage ordering / filters.
4. **`imageGenerationService`** — transient error retry logic, prompt
   assembly with brand context. Uses `axios` directly — mock that boundary.
5. **`openaiClient`** — the HTTP layer. Mock axios, test the usage logging
   side-effect and error path handling.
6. **`videoGenerationService`** — submit-poll-download flow. Three distinct
   states to exercise: pending, success, failed.
7. **`brandContextService`** — needs `BrandConfig` / `BrandReferenceImage`
   model stubs + Vision API call mocking.

## Integration tests (future)

A `tests/integration/` folder exists but is empty. The plan:
- Spin up an in-memory Mongo (`mongodb-memory-server`) and a local Redis.
- Cover the full auto-reply pipeline (webhook → queue → worker → reply).
- Cover the analytics caching end-to-end, including Redis invalidation.

Guard these with `INTEGRATION=1` so they don't run in the default CI loop.
