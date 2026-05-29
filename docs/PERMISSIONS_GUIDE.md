# Permissions & groups guide

Step-by-step playbook for adding a new **permission** to RepMeUp and wiring it through groups, the main app, and (optionally) the API.

**Golden rule:** Admin defines permissions → **groups bundle them** → **users inherit codes on login** → frontend gates UX → backend should enforce sensitive actions.

> **Permissions vs plan features:** Subscription **plan features** (`featureCatalog.js`, entitlements) control what an *organization* can use. **RBAC permissions** control what a *user* can do within an org. Both may apply to the same screen — see `backend/docs/PLAN_FEATURE_ENFORCEMENT.md` for plan features.

---

## Architecture

```
Admin: Permission record (code, category)
       ↓
Admin: Group.permissions[]  (many-to-many)
       ↓
User.group assignment  (Organization → Users)
       ↓
authService → user.resolvedPermissions[]  (on login / token refresh)
       ↓
Frontend: PermissionGuard, PermissionService, sidebar menu
Backend:  route guards (role-based today; permission-based where added)
```

| Layer | Responsibility |
|-------|----------------|
| `Permission` model | Stores code, category, actions metadata |
| Admin → Groups & Permissions | CRUD permissions; assign to groups |
| `Group` model | Named role template with permission IDs |
| `User.group` | Single group per user (plus legacy `role` fallback) |
| `authService._extractPermissionCodes` | Resolves codes from group into JWT payload |
| Frontend `PermissionService` | `hasPermission('inbox.read')` checks |
| Frontend routes / menu | `PermissionGuard`, `requiredPermissions`, `ROUTE_PERMISSION_MAP` |

---

## Permission code conventions

Use **`category.action`** lowercase dot notation:

| Part | Examples |
|------|----------|
| Category | `inbox`, `posts`, `knowledge_base`, `billing` |
| Action suffix | `.read`, `.create`, `.update`, `.delete`, `.manage`, `.export`, `.assign` |

Examples already in the system:

- `inbox.read` — open inbox
- `posts.create` — create/schedule posts
- `billing.manage` — change subscription / plans page
- `knowledge_base.update` — edit KB entries

**Rules:**

- Codes are **immutable** after creation (API disables code edits).
- Names and descriptions can change anytime.
- `actions[]` on the permission document are **metadata tags** only; enforcement uses the **code string**.

---

## Step 1 — Choose or add a category

**File:** `backend/src/models/Permission.js`

Allowed categories live in `CATEGORIES`:

```javascript
const CATEGORIES = [
  'inbox', 'analytics', 'users', 'settings', 'integrations',
  'knowledge_base', 'posts', 'media', 'organization', 'billing'
];
```

### Adding a new category

1. Add the slug to `CATEGORIES` in `Permission.js`.
2. Add a default row in `seedDefaultPermissions()` inside `backend/src/services/groupPermissionService.js` (at least one permission using that category).
3. Update admin labels in `admin/src/app/features/groups-permissions/groups-permissions.component.ts` (`CATEGORY_LABELS` and `CATEGORY_STYLES`).
4. Restart backend and re-open Admin → Groups & Permissions.

---

## Step 2 — Create the permission record

Pick **one** of these paths.

### Option A — Admin UI (no deploy)

1. Open **Admin → Groups & Permissions → Permissions** tab.
2. Click **New permission**.
3. Fill in:
   - **Display name** — human label (e.g. `Manage Campaigns`)
   - **Code** — e.g. `campaigns.manage` (auto-suggested from name)
   - **Category** — pick from dropdown
   - **Description** — what this allows (optional but recommended)
   - **Actions** — metadata tags (`read`, `manage`, etc.)
4. Click **Create permission**.

### Option B — Seed defaults (repeatable across environments)

**File:** `backend/src/services/groupPermissionService.js` → `seedDefaultPermissions()`

```javascript
{ name: 'Manage Campaigns', code: 'campaigns.manage', category: 'settings', actions: ['manage'] },
```

Then either:

- Click **Seed defaults** in Admin (creates missing rows only), or
- Call `POST /api/super-admin/seed/permissions` (super-admin auth required).

Existing codes are **skipped**, not overwritten.

---

## Step 3 — Assign permission to groups

1. Admin → **Groups & Permissions → Groups**.
2. Select a group (e.g. Manager, Admin) or create a custom group.
3. Tick the new permission in the checklist (use search if needed).
4. **Save changes**.

System groups (Super Admin, Admin, Manager, Agent, Viewer) can be edited but not deleted.

To include the permission in **seeded** system groups for new installs, update `permissionCodes` arrays in `seedDefaultGroups()` in `groupPermissionService.js`.

---

## Step 4 — Assign users to groups

Permissions reach users through their **group**, not by editing the permission directly.

1. Admin → **Organizations** → open an org → **Users**.
2. Set the user's **Group** field (via `PATCH .../users/:userId/group` with `{ groupId }`).
3. User must **log in again** (or refresh token) to receive updated `resolvedPermissions`.

Legacy fallback: users with `role` but no `group` still map to system groups by slug (`admin` → `admin`, etc.) in `authService._resolveEffectiveGroup`.

---

## Step 5 — Wire the frontend (required for UX)

### 5a. Route guard

**File:** `frontend/src/app/app-routing.module.ts`

```typescript
{
  path: 'campaigns',
  component: CampaignsComponent,
  canActivate: [PermissionGuard],
  data: { permissions: ['campaigns.manage'] }
}
```

Use `permissions: ['a', 'b']` when **any one** code is enough (`hasAnyPermission`).

### 5b. Sidebar / menu visibility

**File:** `frontend/src/app/core/services/permission.service.ts`

Add to `ROUTE_PERMISSION_MAP`:

```typescript
'/app/campaigns': 'campaigns.manage',
```

Dynamic menus also respect `requiredPermissions` on menu documents (seeded in `menuController.js`).

### 5c. Button / field disabling

In templates:

```html
<button [disabled]="!permissionService.hasPermission('campaigns.manage')">
  Launch campaign
</button>
```

Inject `PermissionService` in the component `constructor` / `inject()`.

### 5d. Super-admin bypass

`super_admin` role bypasses all permission checks. Legacy `admin` users without resolved permissions also bypass (migration safety).

---

## Step 6 — Wire the backend (recommended for security)

Today most API routes use **role-based** `authorize('admin', 'manager')` from `backend/src/middlewares/auth.js`. For new capabilities, prefer checking permission codes when the action is group-scoped.

### Pattern: check codes on the request

After `protect` middleware, resolve the user's group permissions (populate `req.user.group`) or compare against codes already attached at login.

Example approach for a new middleware (if you add one):

```javascript
function requirePermission(...codes) {
  return async (req, res, next) => {
    const userPerms = await resolveUserPermissionCodes(req.user);
    if (codes.some(c => userPerms.includes(c))) return next();
    return res.status(403).json({ success: false, error: 'Insufficient permissions' });
  };
}
```

Until permission middleware is universal, **at minimum** keep role checks on destructive endpoints.

---

## Step 7 — Verify end-to-end

| Check | How |
|-------|-----|
| Permission exists | Admin → Permissions tab shows code |
| Group has permission | Edit group → checkbox selected |
| User assigned | Org → Users → group set |
| Login payload | DevTools → login response → `resolvedPermissions` includes code |
| Route access | Log in as Agent → URL blocked or redirected without code |
| UI elements | Buttons hidden/disabled without code |
| API | Mutating action returns 403 without access |

Test matrix:

1. **Super Admin** — should always pass.
2. **Custom group** with only the new permission.
3. **Viewer** (read-only) — should not get manage/create codes.

---

## Quick reference — files to touch

| Task | File(s) |
|------|---------|
| New category enum | `backend/src/models/Permission.js` |
| Seed permission | `backend/src/services/groupPermissionService.js` |
| Admin UI labels | `admin/.../groups-permissions.component.ts` |
| Route guard | `frontend/src/app/app-routing.module.ts` |
| Sidebar map | `frontend/src/app/core/services/permission.service.ts` |
| Menu item | `backend/src/controllers/menuController.js` (menu seeds) |
| User group API | `PATCH /api/super-admin/users/:userId/group` |
| Auth resolution | `backend/src/services/authService.js` |

---

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| User still sees old access | Cached session — log out and back in |
| Permission not in picker | `isActive: false` or not created — seed or create in Admin |
| Cannot delete permission | Still assigned to one or more groups — remove from groups first |
| Code validation error | Must match `/^[a-z][a-z0-9_.]*$/` |
| Menu shows but route blocks | `ROUTE_PERMISSION_MAP` and route `data.permissions` mismatch |
| Admin works, Agent blocked correctly | Expected — RBAC is working |

---

## Related docs

- Plan entitlements (org-level): `backend/docs/PLAN_FEATURE_ENFORCEMENT.md`
- Super-admin API: `all_generated_docs/docs/SUPER_ADMIN_API.md`
