# Instagram Story & Reel Publishing Fix

## Problem
When selecting "Story" in the publish form, the backend was publishing a regular Instagram post instead of a story.

## Root Cause
The backend was receiving the `postType` parameter but **ignoring it** when publishing to Instagram. The `publishToInstagram()` function always called `instagramService.createPost()` regardless of the post type selected.

## Solution

### 1. Added New Instagram Service Methods

Created three specialized methods in `instagramService.js`:

#### **createPost()** - Regular Feed Posts
```javascript
// Uses media_type: 'IMAGE' or 'VIDEO'
// Creates standard feed posts that stay on profile
```

#### **createStory()** - 24-Hour Stories
```javascript
// Uses media_type: 'STORIES'
// Creates temporary content that disappears after 24 hours
// URL: https://www.instagram.com/stories/{account}/{story_id}
```

#### **createReel()** - Short-Form Videos
```javascript
// Uses media_type: 'REELS'
// Creates short-form video content optimized for discovery
// Also shares to main feed (share_to_feed: true)
// Requires video file only
```

### 2. Updated Controller Logic

Modified `publishToInstagram()` in `postController.js` to route based on `postType`:

```javascript
switch (postType) {
  case 'story':
    result = await instagramService.createStory(connection, {...});
    break;
    
  case 'reel':
    result = await instagramService.createReel(connection, {...});
    break;
    
  case 'post':
  default:
    result = await instagramService.createPost(connection, {...});
    break;
}
```

## Instagram API Details

### Story Requirements:
- **Endpoint**: `/{instagram-business-id}/media`
- **media_type**: `'STORIES'`
- **Supported formats**: Image (JPEG, PNG) or Video (MP4)
- **Video duration**: Up to 60 seconds
- **Aspect ratio**: 9:16 (vertical)
- **Lifespan**: 24 hours

### Reel Requirements:
- **Endpoint**: `/{instagram-business-id}/media`
- **media_type**: `'REELS'`
- **Supported format**: Video only (MP4)
- **Video duration**: 15-90 seconds (90 seconds recommended)
- **Aspect ratio**: 9:16 (vertical)
- **share_to_feed**: Automatically shares to main feed

### Post Requirements:
- **media_type**: `'IMAGE'` or `'VIDEO'`
- **Supported formats**: Image (JPEG, PNG) or Video (MP4)
- **Multiple images**: Supported via carousel
- **Captions**: Up to 2,200 characters

## Testing

### To Test Story Publishing:
1. Go to Publish page
2. Select Instagram
3. Select **"Story"** as content type
4. Upload image or video (vertical format works best)
5. Click "Publish Now"
6. Check Instagram - should appear in Stories section (not feed)

### To Test Reel Publishing:
1. Go to Publish page
2. Select Instagram
3. Select **"Reel"** as content type
4. Upload video (must be video, not image)
5. Add caption with hashtags
6. Click "Publish Now"
7. Check Instagram - should appear in Reels tab AND main feed

### To Test Regular Post:
1. Go to Publish page
2. Select Instagram
3. Select **"Post"** as content type
4. Upload image or video
5. Add caption
6. Click "Publish Now"
7. Check Instagram - should appear in main feed

## Files Modified

### Backend:
- `backend/src/integrations/meta/instagramService.js`
  - Added `createStory()` method (~60 lines)
  - Added `createReel()` method (~70 lines)

- `backend/src/controllers/postController.js`
  - Updated `publishToInstagram()` to switch on `postType`
  - Added validation (reels require video)

### Frontend:
No changes needed - already sending `postType` parameter correctly.

## Expected Behavior

| Content Type | API Call | Where It Appears | Duration |
|--------------|----------|------------------|----------|
| **Post** | `createPost()` | Main feed + Profile grid | Permanent |
| **Story** | `createStory()` | Stories ring (top of app) | 24 hours |
| **Reel** | `createReel()` | Reels tab + Main feed | Permanent |

## Important Notes

### Stories:
- ⏱️ Disappear after 24 hours
- 📱 Best with vertical 9:16 format
- 💬 No caption support in API (add text via Instagram app after)
- 🎨 Stickers/polls added manually after publishing

### Reels:
- 🎵 Add audio/music manually in Instagram app
- 🎯 Use hashtags in caption for discovery
- ⏱️ 15-90 seconds (90 is sweet spot)
- 📺 Automatically appears in both Reels tab and main feed

### Posts:
- 📸 Supports carousel (up to 10 images/videos)
- 💬 Full caption support (2,200 chars)
- 🔗 Link in caption (if enabled for account)
- 🌍 Location tagging (via separate API call)

## Error Handling

The code includes detailed error handling:

```javascript
if (apiError) {
  const detailedError = new Error(apiError.message);
  detailedError.platformError = {
    title: apiError.error_user_title || 'Instagram Story Error',
    message: apiError.error_user_msg || apiError.message,
    code: apiError.code,
    subcode: apiError.error_subcode,
    type: apiError.type
  };
  throw detailedError;
}
```

Common errors:
- **Code 100**: Invalid access token or expired permissions
- **Code 190**: Access token expired - reconnect Instagram
- **Code 200**: Permission error - need Instagram Content Publishing permission
- **Subcode 33**: Video processing failed (wrong format/size)

## Permissions Required

Make sure Instagram app has these permissions:
- ✅ `instagram_basic` (profile info)
- ✅ `instagram_content_publish` (create posts/stories/reels)
- ✅ `pages_read_engagement` (read page data)

## Verification

After deploying, verify by:
1. Publishing a story → Check Stories ring
2. Publishing a reel → Check Reels tab
3. Publishing a post → Check main feed
4. Check backend logs for correct method being called

## Rollback

If issues occur, revert these commits:
- `backend/src/integrations/meta/instagramService.js` (lines 710-900)
- `backend/src/controllers/postController.js` (lines 474-520)

The old behavior will publish everything as regular posts.
