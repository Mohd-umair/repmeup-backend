# Background Jobs — Queue Topology & Operations

Last audited: 2026-04-22

## TL;DR

- Library: **`bull@4.16.5`** (the original `bull` package — _not_ BullMQ).
- Latest npm version: **4.16.5** — we are current.
- Single point of definition: [`src/config/queue.js`](../src/config/queue.js).
- Single point of consumption: [`src/worker.js`](../src/worker.js) (run separately from the API).
- Dashboard: [`/admin/queues`](http://localhost:3000/admin/queues), powered by `@bull-board/express`.

The earlier code-review note about a "Bull v3 vs BullMQ" mismatch was incorrect. There is no version drift and no library mixing.

---

## Why Bull (and not BullMQ)?

| | `bull` (4.x) | `bullmq` (5.x) |
|---|---|---|
| Status | Maintenance mode (security/bugfixes) | Actively developed by the same author |
| Last release | Dec 2024 | Continuous |
| Redis support | Redis 2.8+ | Redis 5+ recommended |
| API | Callback-friendly, JS-first | Promise-/TS-first |
| Deprecated? | **No** | — |

**Decision:** stay on `bull` 4.x for now. It is not deprecated, it is feature-complete for our needs (job retries, repeatable jobs, rate limiting, Bull Board), and a migration to BullMQ is a non-trivial code change (different APIs for `add` / `process` / events). Revisit if we hit one of:

1. We need [Redis Streams](https://docs.bullmq.io/guide/architecture#streams)-backed queues for very high throughput.
2. We need [job dependencies / flows](https://docs.bullmq.io/guide/flows) for multi-step pipelines.
3. We hit a production bug that is fixed only in BullMQ.

---

## Queue Topology

There are **7 queues declared**, **5 of which are active** (have both producers and a worker consumer).

### Active queues

| Queue (Bull name)     | Concurrency  | Producers                                                                                                    | Consumer (`worker.js`)         | Job shape                                                  |
|-----------------------|--------------|--------------------------------------------------------------------------------------------------------------|--------------------------------|------------------------------------------------------------|
| `webhook-processing`  | `10` (env `WEBHOOK_CONCURRENCY`) | `controllers/webhookController.js` (×4 platforms)                                                           | `jobs/processWebhook.js`       | `{ platform, payload, connectionId }`                      |
| `ai-processing`       | `10` (env `AI_CONCURRENCY`)      | `jobs/processWebhook.js`, `controllers/webhookController.js`, `services/platformSyncService.js`              | `jobs/processAI.js`            | `{ interactionId, organizationId }`                         |
| `auto-reply`          | `5`  (env `AUTOREPLY_CONCURRENCY`) | `services/autoReplyScheduler.js` (one-shot **and** repeatable cron-style jobs per org)                      | `jobs/processAutoReply.js`     | `{ organizationId }` (+ repeat opts for scheduled mode)    |
| `scheduled-publish`   | `1` (singleton)                  | `worker.js` itself, on boot, registers a single repeatable job (`every: 60_000`)                              | `jobs/processScheduledPublish.js` | empty payload — the job is a tick                       |
| `brand-analysis`      | `2` (env `BRAND_ANALYSIS_CONCURRENCY`) | `controllers/platformPostsController.js`                                                                   | `jobs/processBrandAnalysis.js` | `{ organizationId }` (deduped via `jobId: brand-analysis-${org}`) |

### Dormant queues (declared, never used)

| Queue              | Status      | Notes                                                                                                                   |
|--------------------|-------------|-------------------------------------------------------------------------------------------------------------------------|
| `platform-sync`    | **Dormant** | Imported by `bullBoard.js`; no producer or consumer. Was likely planned for periodic platform-data refresh.            |
| `notifications`    | **Dormant** | Imported by `bullBoard.js`; no producer or consumer. Notifications are currently sent inline from `notificationController.js`. |

> **TODO**: either wire these up or remove them in a follow-up. They each cost ~2 idle Redis connections (`client` + `subscriber`); they do **not** create a `bclient` connection because nothing calls `.process()` on them.

---

## Redis Connections

Each Bull queue opens **up to 3 Redis connections** under the hood:

| Connection role | When it's created                                  |
|-----------------|----------------------------------------------------|
| `client`        | Always, at queue construction                      |
| `subscriber`    | Always, at queue construction                      |
| `bclient`       | Only when `.process()` is called on that queue     |

So in our setup:

- **API server process** (`src/server.js`): 7 queues × 2 connections = **14 idle Redis connections** (no `.process()` calls).
- **Worker process** (`src/worker.js`): 5 active queues × 3 connections + 2 dormant × 2 connections = **19 connections**.
- **Total at steady state: ~33 Redis connections** across both processes.

If we ever need to reduce this, Bull supports a [`createClient`](https://github.com/OptimalBits/bull/blob/develop/REFERENCE.md#queue) option that lets us share `client` and `subscriber` connections across queues. We are not doing this today because we are nowhere near Redis connection limits.

---

## Repeatable Jobs

Two repeatable jobs run continuously:

| jobId                         | Queue              | Schedule         | Registered by                                          | Purpose                                       |
|-------------------------------|--------------------|------------------|--------------------------------------------------------|-----------------------------------------------|
| `scheduled-publish-repeat`    | `scheduled-publish`| every 60 s       | `src/worker.js` (boot, idempotent guard)               | Publish posts whose `scheduledFor <= now()`   |
| `auto-reply-repeat-${orgId}`  | `auto-reply`       | per-org cron     | `services/autoReplyScheduler.js`                       | Generate scheduled-mode auto-replies          |

Both producers check `getRepeatableJobs()` first and skip registration if a matching key exists, so worker restarts don't create duplicates. (This is the fix that landed earlier in the "duplicate queue processor" cleanup.)

If a repeatable job ever needs to be removed, do **not** just `del` it from Redis — use `queue.removeRepeatableByKey(...)` so Bull cleans up the associated meta key.

---

## Where the API server is _not_ a worker

`src/server.js` does **not** call `.process()`. It only enqueues jobs. The boot log line you should see at API startup is:

```
[info]: Queue processors not started in server process — run worker.js separately.
```

To actually run jobs, run the worker as a second process:

```bash
node src/worker.js
# or, in production, supervise via PM2/systemd/Docker
```

This separation is intentional — it lets us scale workers independently of the request-serving fleet.

---

## Operations Runbook

### Inspecting queues

The Bull Board UI lives at **`/admin/queues`** in the API server. It shows waiting / active / completed / failed / delayed counts for every queue, lets you retry failed jobs, and lets you inspect job payloads.

```
http://localhost:3000/admin/queues
```

> ⚠️ This route is currently **not authenticated** (`src/app.js:121`). Before going to public production, mount it behind admin auth.

### CLI inspection

```bash
node check-queues.js     # one-shot snapshot of queue counts (root of backend/)
node clear-queues.js     # nukes everything in all queues — DEV ONLY
```

### Tunables (env vars)

| Env var                          | Default | Effect                                                                |
|----------------------------------|---------|-----------------------------------------------------------------------|
| `REDIS_URL`                      | `redis://localhost:6379` | All queues connect here.                                |
| `WEBHOOK_CONCURRENCY`            | `10`    | Parallel webhook jobs per worker process.                             |
| `AI_CONCURRENCY`                 | `10`    | Parallel AI jobs per worker process.                                  |
| `AUTOREPLY_CONCURRENCY`          | `5`     | Parallel auto-reply jobs per worker process.                          |
| `BRAND_ANALYSIS_CONCURRENCY`     | `2`     | Parallel brand-analysis jobs per worker process.                      |

### Default job settings (`queueConfig`)

Applied by callers when adding jobs:

```js
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 50,
  removeOnFail: 100
}
```

### Default queue settings

```js
{
  maxStalledCount: 3,
  stalledInterval: 60000,
  lockDuration: 120000,
  lockRenewTime: 60000,
  limiter: { max: 100, duration: 1000 }
}
```

`lockDuration: 120000` means a worker can hold a job for up to 120 s without renewing the lock. If a job legitimately takes longer (e.g. a slow OpenAI call), make sure `lockRenewTime` (60 s) is fast enough to renew before that fires.

### Logging

All queue events go through the structured Winston logger in `src/config/logger.js`:

| Event       | Log level | Why                                                                  |
|-------------|-----------|----------------------------------------------------------------------|
| `error`     | `error`   | Connection-level / library failures — always investigate.            |
| `failed`    | `error`   | A job exhausted its retry budget. Includes `attemptsMade`.           |
| `completed` | `debug`   | Per-job success — at scale this is high-volume noise. Default level (`info`) hides it. |

To see per-job completion locally, run with `LOG_LEVEL=debug`.

---

## Producer Index

| File                                                  | Queue used               | Notes                                                                                |
|-------------------------------------------------------|--------------------------|--------------------------------------------------------------------------------------|
| `src/controllers/webhookController.js`                | `webhookQueue`, `aiQueue`| 4 webhook entry points (Google/YouTube/Facebook/IG/IG-Login/LinkedIn/WhatsApp).      |
| `src/controllers/platformPostsController.js`          | `brandAnalysisQueue`     | One-shot per org, deduped via `jobId`.                                               |
| `src/services/autoReplyScheduler.js`                  | `autoReplyQueue`         | Both immediate and repeatable jobs.                                                  |
| `src/services/platformSyncService.js`                 | `aiQueue`                | Re-analyzes interactions imported during a manual sync.                              |
| `src/jobs/processWebhook.js`                          | `aiQueue`                | A webhook job can chain into an AI job (when a new interaction needs classification). |
| `src/worker.js`                                       | `scheduledPublishQueue`  | Self-registers the 60 s repeatable on boot.                                          |

---

## Future Work (not done yet)

1. **Wire or remove** `syncQueue` / `notificationQueue`.
2. **Auth in front of `/admin/queues`** before any non-dev environment.
3. **Consider `createClient`** to share Redis connections if the connection count ever becomes a constraint.
4. **Per-queue dead-letter visibility**: surface `failed` counts per platform in our analytics, not just in Bull Board.
5. **Decide on BullMQ** at the next major version bump (only if a concrete trigger above hits).
