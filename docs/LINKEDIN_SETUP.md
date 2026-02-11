# LinkedIn Integration Setup Guide

## Problem: Can't Get LinkedIn Comments

The LinkedIn integration requires **advanced API scopes** that need approval from LinkedIn before they work.

## Why It's Not Working

1. **Missing Scopes**: By default, only basic scopes are requested (openid, profile, email)
2. **Advanced Scopes Needed**:
   - `r_organization_social` - Read organization posts and comments
   - `w_organization_social` - Post on behalf of organization
   - `rw_organization_admin` - Manage organization
3. **LinkedIn Approval Required**: These scopes require your LinkedIn app to be approved by LinkedIn

## Current Status

The `.env` now has `LINKEDIN_ENABLE_ADVANCED_SCOPES=true`, which means the OAuth flow will **request** these scopes, but they **won't work until LinkedIn approves your app**.

## Steps to Get LinkedIn Comments Working

### 1. Apply for LinkedIn API Access

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Click on your app (Client ID: `773qlgxu65xv9o`)
3. Go to **Products** tab
4. Request access to **"Share on LinkedIn"** or **"Community Management API"** products
5. Fill out the application form (explain you're building a reputation management tool)
6. Wait for LinkedIn approval (can take 1-2 weeks)

### 2. Required Scopes After Approval

Once approved, your app will have access to:
- ✅ `r_organization_social` - Read organization posts/comments
- ✅ `w_organization_social` - Post on behalf of organization  
- ✅ `rw_organization_admin` - Manage organization pages

### 3. After Approval

1. **Reconnect LinkedIn** - Users must disconnect and reconnect their LinkedIn accounts
2. **Grant New Permissions** - During OAuth, they'll see the new scopes and must approve them
3. **Sync Will Work** - The sync button will now fetch posts and comments

## Testing Before Approval

**Without approval**, the sync will show:
```
⚠️ [LinkedIn] Cannot fetch organizations - advanced scopes not approved
❌ LinkedIn API access denied. Please ensure "Share on LinkedIn" product is approved
```

## Temporarily Disable Advanced Scopes

If you want to connect LinkedIn without comments (just save the connection):

In `.env`, set:
```
LINKEDIN_ENABLE_ADVANCED_SCOPES=false
```

This will only request basic profile info (no posts/comments).

## API Endpoints Used

The LinkedIn integration uses:
- `GET /v2/organizationAcls` - List organizations user can manage (requires `r_organization_social`)
- `GET /v2/posts?author={org}` - Fetch organization posts (requires `r_organization_social`)
- `GET /v2/socialActions/{post}/comments` - Fetch post comments (requires `r_organization_social`)
- `POST /v2/socialActions/{post}/comments` - Reply to comments (requires `w_organization_social`)

## Expected Behavior After Setup

1. **Connect LinkedIn** → User selects their Company Page
2. **Sync** → Fetches last 50 posts and all their comments
3. **Inbox** → Comments appear in unified inbox
4. **Reply** → Can reply to comments from the app

## Current Limitation

Until LinkedIn approves your app, the integration will:
- ✅ Connect (save profile info)
- ❌ Sync posts/comments (403 Forbidden)
- ❌ Reply to comments (403 Forbidden)

## More Info

- [LinkedIn OAuth Scopes](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authentication)
- [LinkedIn API Products](https://learn.microsoft.com/en-us/linkedin/marketing/getting-started)
- [Apply for LinkedIn Products](https://www.linkedin.com/developers/apps)
