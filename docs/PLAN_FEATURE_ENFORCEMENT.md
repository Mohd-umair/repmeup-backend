# Plan feature enforcement guide

Step-by-step playbook for adding a new capability to RepMeUp and enforcing it by subscription plan.

**Golden rule:** Admin configures → **backend enforces** → frontend reflects and guides. Frontend gating improves UX; only backend `assert` / `consume` / `requireFeature` actually blocks abuse.

---

## Architecture

```
featureCatalog.js
       ↓
seedFeatures.js  →  MongoDB Feature collection
       ↓
Admin Plans UI  →  Plan.entitlements (per tier)
       ↓
entitlementsService  →  GET /api/entitlements
       ↓
Backend routes/services (enforce)  +  Frontend (hide / upgrade prompts)
```

| Layer | Responsibility |
|-------|----------------|
| `featureCatalog.js` | Source of truth: keys, kinds, labels, defaults |
| Admin → Plans | Per-tier `{ enabled }` or `{ limit }` values |
| `entitlementsService` | Resolve plan + check/consume quotas |
| Backend API | **Must** call `assert` / `consume` / `requireFeature` |
| Frontend | Route guards, upgrade prompts, usage meters (UX only) |

---

## Step 1 — Define the feature in the catalog

**File:** `backend/src/config/featureCatalog.js`

### 1a. Add a stable key in `FEATURE_KEYS`

Use dot notation: `domain.capability.unit` (same pattern as existing keys).

```javascript
// Boolean module (on/off)
SOCIAL_LISTENING_ENABLED: 'social.listening.enabled',

// Monthly quota
SOCIAL_MENTIONS_MONTHLY: 'social.mentions.monthly',
```

### 1b. Add a row in `CATALOG`

| Kind | Use when | Plan value | Enforcement |
|------|----------|------------|-------------|
| `boolean` | Whole module on/off | `{ enabled: true/false }` | `assert()` → **403** if disabled |
| `limit` | Count cap (accounts, products) | `{ limit: N }` (`-1` = unlimited) | `assert()` → **402** if over quota |
| `limit` + `resetPeriod: 'monthly'` | Monthly usage bucket | `{ limit: N }` | `assert()` then `consume()` |

**Boolean example:**

```javascript
{
  key: FEATURE_KEYS.SOCIAL_LISTENING_ENABLED,
  label: 'Social listening',
  description: 'Monitor brand mentions across platforms.',
  category: 'analytics',       // groups row in Admin Plans UI
  kind: 'boolean',
  defaultValue: false,
  sortOrder: 410
}
```

**Monthly limit example:**

```javascript
{
  key: FEATURE_KEYS.SOCIAL_MENTIONS_MONTHLY,
  label: 'Mentions tracked / month',
  category: 'analytics',
  kind: 'limit',
  defaultValue: 0,
  unit: 'mentions',
  resetPeriod: 'monthly',      // monthly reset via bucketService
  sortOrder: 420
}
```

---

## Step 2 — Seed the catalog to MongoDB

```bash
cd backend
node scripts/seedFeatures.js
```

Idempotent upsert by `key`. After seeding, **Admin → Plans → Limits & features** shows the new row automatically (grouped by `category`).

---

## Step 3 — Set default values per tier (recommended)

Keep these two files **in sync**:

| File | Purpose |
|------|---------|
| `backend/scripts/planTierEntitlements.js` | Used by `seedPlans.js` |
| `admin/src/app/features/plans/plan-tier-presets.ts` | Admin “Apply tier preset” button |

Example:

```javascript
// Free — off
'social.listening.enabled': { enabled: false },
'social.mentions.monthly': { limit: 0 },

// Pro — on + quota
'social.listening.enabled': { enabled: true },
'social.mentions.monthly': { limit: 5000 },
```

Re-seed plans if needed:

```bash
npm run seed:plans
```

Or configure each plan manually in **Admin → Plans**.

---

## Step 4 — Mark as enforced (admin visibility)

**File:** `backend/src/config/featureCatalog.js` → `ENFORCED_FEATURE_KEYS`

Add your key so Admin Plans shows an **“Enforced”** badge (code actually blocks when violated):

```javascript
const ENFORCED_FEATURE_KEYS = new Set([
  // ...
  FEATURE_KEYS.SOCIAL_LISTENING_ENABLED,
  FEATURE_KEYS.SOCIAL_MENTIONS_MONTHLY,
]);
```

Without this, admins can configure the key but nothing in code will block it yet.

---

## Step 5 — Backend enforcement (required)

### Pattern A — Boolean module (route or action)

**Whole route** (best for a new API area):

```javascript
// backend/src/routes/socialListening.js
const { requireFeature } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');

router.use(protect);
router.use(requireFeature(FEATURE_KEYS.SOCIAL_LISTENING_ENABLED));
```

**Single action** in a controller/service:

```javascript
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');

await entitlementsService.assert(orgId, FEATURE_KEYS.SOCIAL_LISTENING_ENABLED);
```

**Real example:** `backend/src/routes/campaigns.js` uses `requireFeature(FEATURE_KEYS.CAMPAIGNS_ENABLED)`.

### Pattern B — Limit / quota (check before, deduct after)

```javascript
// Before creating N items
await entitlementsService.assert(orgId, FEATURE_KEYS.SOCIAL_MENTIONS_MONTHLY, count);

// After success
await entitlementsService.consume(orgId, FEATURE_KEYS.SOCIAL_MENTIONS_MONTHLY, count);
```

**Real example:** `backend/src/services/campaignService.js` on campaign launch:

```javascript
await entitlementsService.assert(orgIdStr, FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY, total);
await entitlementsService.consume(orgIdStr, FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY, total);
```

### Pattern C — Read quota (UI / pre-checks, no block)

```javascript
const q = await entitlementsService.quota(orgId, FEATURE_KEYS.SOCIAL_MENTIONS_MONTHLY);
// q.limit, q.used, q.remaining, q.isUnlimited, q.isExhausted
```

### `requireFeature` middleware reference

**File:** `backend/src/middlewares/requireFeature.js`

```javascript
router.post('/launch', requireFeature(FEATURE_KEYS.WHATSAPP_BROADCAST_ENABLED), ctrl.launch);
router.post('/items', requireFeature(FEATURE_KEYS.SOCIAL_MENTIONS_MONTHLY, { amount: 5 }), ctrl.create);
```

| Error | HTTP | Code |
|-------|------|------|
| Boolean disabled | 403 | `FEATURE_DISABLED` |
| Quota exceeded | 402 | `QUOTA_EXCEEDED` |

---

## Step 6 — Mirror the key on the frontend

**File:** `frontend/src/app/core/services/entitlements.store.ts`

Add to `FEATURE_KEY` (exact same string as backend):

```typescript
SOCIAL_LISTENING_ENABLED: 'social.listening.enabled',
SOCIAL_MENTIONS_MONTHLY: 'social.mentions.monthly',
```

`EntitlementsStore` loads resolved values from `GET /api/entitlements` — no extra API work once the key exists in catalog + plan.

---

## Step 7 — Frontend UX gating (recommended)

Frontend does **not** enforce security; it hides UI and shows upgrade paths.

### 7a. Route guard

**File:** `frontend/src/app/app-routing.module.ts`

```typescript
{
  path: 'social-listening',
  component: SocialListeningComponent,
  canActivate: [PermissionGuard, PlanFeatureGuard],
  data: {
    permissions: ['analytics.read'],
    planFeature: FEATURE_KEY.SOCIAL_LISTENING_ENABLED
  }
}
```

**File:** `frontend/src/app/core/constants/plan-route-features.ts`  
Add route → feature mapping when the menu DB row may not have `requiresFeature`.

### 7b. Menu filtering

**File:** `frontend/src/app/core/services/menu.service.ts`  
Items with `requiresFeature` or a matching entry in `plan-route-features.ts` are hidden when the plan disallows the feature.

### 7c. Page-level upgrade prompt

**Component pattern** (see `frontend/src/app/features/campaigns/`):

```typescript
readonly planAllowed = computed(() => this.ent.can(FEATURE_KEY.SOCIAL_LISTENING_ENABLED));
```

```html
@if (!planAllowed()) {
  <app-upgrade-prompt
    title="Social listening is not on your plan"
    message="Upgrade to monitor mentions across platforms."
    [featureKey]="FEATURE_KEY.SOCIAL_LISTENING_ENABLED"
  />
} @else {
  <!-- page content -->
}
```

### 7d. Fine-grained UI (buttons, sections)

```html
<button *appPlanGate="FEATURE_KEY.SOCIAL_LISTENING_ENABLED">
  Start monitoring
</button>
```

**Directive:** `frontend/src/app/shared/directives/plan-gate.directive.ts`

### 7e. Usage meter (limits)

```html
<app-usage-meter
  [featureKey]="FEATURE_KEY.SOCIAL_MENTIONS_MONTHLY"
  label="Mentions this month"
/>
```

**Component:** `frontend/src/app/shared/components/usage-meter/`

---

## Step 8 — Show on pricing / plans pages (optional)

If customers should see the feature on `/app/plans` and **Settings → Accounts**:

**File:** `backend/src/services/planPresentationService.js`

| Array | Purpose |
|-------|---------|
| `CARD_LIMIT_KEYS` | Numeric limits on plan cards (`highlights[]`) |
| `CARD_FEATURE_KEYS` | Module bullets on plan cards (`features[]`) |

Only **explicitly configured** plan entitlements appear (catalog defaults are excluded).

---

## Step 9 — Assign via Admin

1. Open **Admin → Plans**
2. Select a plan (Free / Starter / Pro / …)
3. **Limits & features** tab → find your row by category
4. Set `{ enabled: true }` or `{ limit: N }`
5. Save

Saving invalidates entitlements cache for affected orgs. Frontend cache TTL is ~60 seconds.

**Restart backend** after code changes to `planPresentationService` or controllers so pricing APIs return updated card shapes.

---

## Step 10 — Test checklist

| Test | Expected |
|------|----------|
| Org on Free (feature off) | API **403** `FEATURE_DISABLED`; UI shows upgrade prompt |
| Org on Pro (feature on) | API succeeds; full UI visible |
| Over monthly quota | API **402** `QUOTA_EXCEEDED`; usage meter at limit |
| Change entitlements in Admin | Plans/billing pages update; enforcement follows after cache refresh |
| Direct API call (bypass UI) | Backend still blocks |

```bash
# Example authenticated request
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/v1/your-endpoint
```

---

## File reference

| Task | File(s) |
|------|---------|
| Define key + metadata | `backend/src/config/featureCatalog.js` |
| Seed to DB | `backend/scripts/seedFeatures.js` |
| Tier defaults | `backend/scripts/planTierEntitlements.js`, `admin/src/app/features/plans/plan-tier-presets.ts` |
| Enforced badge in admin | `ENFORCED_FEATURE_KEYS` in `featureCatalog.js` |
| Block API (middleware) | `backend/src/middlewares/requireFeature.js` |
| Block API (service) | `backend/src/services/entitlementsService.js` → `assert`, `consume`, `quota`, `can` |
| Monthly usage buckets | `backend/src/services/bucketService.js` (auto via `resetPeriod: 'monthly'`) |
| FE key constant | `frontend/src/app/core/services/entitlements.store.ts` |
| Route / menu gating | `frontend/src/app/app-routing.module.ts`, `plan-route-features.ts`, `menu.service.ts` |
| Upgrade UX | `UpgradePromptComponent`, `PlanGateDirective`, `UsageMeterComponent` |
| Plan card display | `backend/src/services/planPresentationService.js` |
| Admin configuration | Admin app → Plans (no code change after `seedFeatures`) |

---

## Worked example: WhatsApp Campaigns (existing)

| Step | Implementation |
|------|----------------|
| Catalog | `campaigns.enabled` (boolean), `campaigns.recipients.monthly` (monthly limit) |
| Seed | `node backend/scripts/seedFeatures.js` |
| Backend | `routes/campaigns.js` → `requireFeature(CAMPAIGNS_ENABLED)`; launch → `assert` + `consume` recipients in `campaignService.js` |
| Frontend | `PlanFeatureGuard` on `/app/campaigns`; `planAllowed()` + `<app-upgrade-prompt>`; `<app-usage-meter>` for recipients |
| Admin | Enable campaigns + set recipient limits per tier |
| Pricing UI | Keys in `planPresentationService.js` `CARD_*` arrays |

Use this same flow for every new feature.

---

## Related docs

- `backend/docs/MIGRATIONS.md` — database migrations
- `all_generated_docs/docs/PLAN_MANAGEMENT.md` — admin plan CRUD (legacy; prefer entitlements model above)
- `backend/src/config/featureCatalog.js` — inline comments at top of file
