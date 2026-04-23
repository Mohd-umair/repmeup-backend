# Migrations Runbook

Operational guide for the one-time migration scripts that still need to run
in production.

> **Read this whole file before touching prod.** Each migration has a
> pre-flight, execute, verify, and rollback step. Skipping pre-flight is how
> data incidents happen.

## Pending migrations

| Order | Script | Severity | Blocking? |
|-------|--------|----------|-----------|
| **1** | `scripts/migrate-interaction-platformid-compound-unique.js` | **Critical** — data-integrity risk | Yes. Run before any multi-tenant traffic goes through the fixed code path. |
| **2** | `scripts/reconcile-entitlements.js` | Medium — drift between sources of truth | No. Safe to run anytime; re-runnable. |

The **code** in `main` already assumes both migrations have run. Until they
do, you have a latent bug (see "Why this matters" below each migration).

---

## 1. `platformId` → compound unique `(organization, platformId)`

**What it does:** converts the legacy global-unique index on
`interactions.platformId` into a per-organization compound unique index, so
two different tenants can receive messages that happen to share an external
thread id without colliding.

**Why this matters:** prior to the fix, a webhook carrying a `platformId`
that already existed in *another* org's inbox would fail to insert with a
`E11000 duplicate key` error — the message was silently dropped. The code in
`controllers/webhookController.js`, `services/instagramWebhookService.js`,
`services/whatsappWebhookService.js`, and `services/linkedinService.js` has
been fixed to query by `{organization, platformId}`, but **the legacy index
in Mongo still enforces global uniqueness.** Until you run this migration,
two tenants receiving the same `platformId` still collide.

### Pre-flight

Run the script in report-only mode on a **staging** database first (restore
a recent prod backup into a staging cluster, don't run against live prod):

```bash
cd backend
node scripts/migrate-interaction-platformid-compound-unique.js --report-only
```

Inspect the output. Two things to look for:

1. **Cross-org duplicates** — reported as warnings. The legacy index *should*
   have prevented these; if any exist, investigate how they got in.
   The new compound index accepts them (each `(org, platformId)` pair is
   still unique), so they are **not** a blocker.

2. **Intra-org duplicates** — reported as errors. The script **exits with
   code 2** if it finds any. These must be resolved by hand (delete or
   merge the duplicate `_id`s) before the compound index will build.
   Example query to inspect:
   ```js
   db.interactions.aggregate([
     { $group: {
         _id: { organization: '$organization', platformId: '$platformId' },
         count: { $sum: 1 },
         ids: { $push: '$_id' }
     } },
     { $match: { count: { $gt: 1 } } }
   ])
   ```

Only proceed to execute once `--report-only` reports **no intra-org
duplicates**.

### Execute

```bash
cd backend
node scripts/migrate-interaction-platformid-compound-unique.js
```

The script will:
1. Re-verify no intra-org duplicates (fails fast if any exist).
2. Drop the legacy index `platformId_1`.
3. Build the new compound index `organization_1_platformId_1` with
   `{unique: true}`.
4. Print the final index list.

Typical runtime: a few seconds to ~2 minutes for collections under 10M
documents. The index build is **foreground** by default in Mongo >= 4.2 and
takes a collection-level lock while building — schedule during a quiet
window if you have heavy webhook traffic.

### Verify

In the Mongo shell:

```js
db.interactions.getIndexes()
  .filter(i => i.key.platformId !== undefined)
```

Expected result — **exactly one** index with
`key: { organization: 1, platformId: 1 }` and `unique: true`.
The old `platformId_1` entry should be gone.

Also, run a spot-check insertion from two different orgs with the same
`platformId` to confirm both succeed:

```js
// In a staging shell. Clean up after.
db.interactions.insertOne({ organization: ObjectId('aaaa...aaaa'), platformId: 'TEST-123', platform: 'instagram', type: 'comment' })
db.interactions.insertOne({ organization: ObjectId('bbbb...bbbb'), platformId: 'TEST-123', platform: 'instagram', type: 'comment' })
// both should succeed
db.interactions.deleteMany({ platformId: 'TEST-123' })
```

### Rollback

If the new index causes issues (unlikely — it's strictly more permissive
than the old one):

```js
// In Mongo shell.
db.interactions.dropIndex('organization_1_platformId_1')
db.interactions.createIndex({ platformId: 1 }, { unique: true, name: 'platformId_1' })
```

**WARNING:** rolling back reintroduces the multi-tenancy bug. Only do this
as an emergency measure, and revert the code changes in
`webhookController.js` / `*WebhookService.js` / `linkedinService.js` that
assume the compound query.

### Idempotency

The script is safe to re-run. It is a no-op once the new index exists and
the legacy index is gone.

---

## 2. Reconcile entitlements (Subscription/Plan/Organization drift)

**What it does:** reports (and optionally fixes) drift between the three
places that used to hold plan limits:

| Source | Role |
|--------|------|
| `Plan.limits` | catalog — authoritative for definitions |
| `Subscription.limits` | snapshot copied at upgrade time — drifts |
| `Organization.limits` | legacy embedded copy — drifts + field-name mismatch |

**Why this matters:** `entitlementsService.js` now reads limits from
`Plan.limits` via the active `Subscription`. But any subscription whose
`limits` field has drifted from the referenced plan will still APPEAR to
have the old values in admin UIs and in anything that still (wrongly) reads
`Subscription.limits` directly. Running this migration aligns the snapshots.

### Pre-flight

The script is dry-run **by default**.

```bash
cd backend
node scripts/reconcile-entitlements.js
```

It emits four sections:

| Section | What it means |
|---------|---------------|
| `A. Orgs with NO Subscription document` | Falling back to legacy limits. Create a Subscription for each, or accept the fallback. |
| `B. Subscriptions whose planId doesn't exist in Plan` | The plan they reference was deleted. Fix by reassigning to an existing plan. |
| `C. Subscription.limits drift vs Plan.limits` | **What `--fix` will correct.** |
| `D. Organization.limits drift vs Plan.limits` | Legacy field; `--fix` does **not** touch this. Clean up separately or ignore (deprecated). |

Review sections A and B manually. Nothing in `--fix` addresses them.

### Execute

```bash
cd backend
node scripts/reconcile-entitlements.js --fix
```

The `--fix` pass:
1. For each drifted `Subscription`, copies the matching `Plan.limits` into
   `Subscription.limits`.
2. Calls `entitlementsService.invalidateEntitlements(orgId)` for every org
   touched, so the Redis cache doesn't serve stale data.

### Verify

Re-run the script without `--fix`:

```bash
node scripts/reconcile-entitlements.js
```

Section C (Subscription drift) should be empty. Sections A, B, D may still
have entries — those are not addressed by `--fix` and require manual
action.

Spot-check a specific org from the admin panel: open an account on the plan
you just reconciled and confirm the displayed limits match `Plan.limits`.

### Rollback

There is no technical rollback — once `Subscription.limits` is rewritten,
the previous values are lost. However:

- No data is deleted. The worst case is cosmetic drift.
- The app reads from `Plan.limits` (via `entitlementsService`) for
  enforcement, so overriding `Subscription.limits` does not affect behaviour.

If you absolutely need to restore pre-migration snapshots, restore from the
latest MongoDB backup.

### Idempotency

The script is safe to re-run. A second `--fix` pass is a no-op when the
`Subscription.limits` already match `Plan.limits`.

---

## General checklist (apply to every migration)

Before running anything against prod:

- [ ] Backup is less than 24h old and you know how to restore it.
- [ ] Script has been dry-run (`--report-only` / default dry-run) on a
      staging restore of prod data.
- [ ] Intra-org duplicates and other blockers from the dry-run are
      resolved.
- [ ] CI is green on the branch containing the migration script.
- [ ] Someone else can take over in case you lose connectivity mid-run.
- [ ] You have a rollback command ready to paste.

During the run:

- [ ] Run inside a `tmux` / `screen` session so a dropped SSH session
      doesn't kill the process.
- [ ] Pipe output to a timestamped log: `2>&1 | tee "migrate-$(date +%s).log"`.

After the run:

- [ ] Verification query confirms the expected post-state.
- [ ] App smoke test: one webhook arrives end-to-end without errors; one
      invoice/plan read shows expected limits.
- [ ] Log file archived.

## Adding a new migration

Follow the conventions the existing scripts establish:

1. **File location:** `backend/scripts/<verb>-<object>.js`.
2. **`require('dotenv').config()`** with an explicit `.env` path.
3. **Dry-run by default.** Make the destructive path opt-in via a flag
   (`--fix` or positional, not env var).
4. **Idempotent.** Re-running must be a no-op once the migration is done.
5. **Exit codes:** `0` on success/no-op, `1` on unexpected error, `2` for
   "data is not ready for this migration — manual action required."
6. **Documentation:** add an entry to this file **before** merging the
   script.
