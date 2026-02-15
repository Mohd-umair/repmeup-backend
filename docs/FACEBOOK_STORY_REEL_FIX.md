# Facebook Story & Reel Publishing Fix

## Problem
Similar to Instagram, when selecting "Story" or "Reel" in the publish form for Facebook, the backend was publishing a regular feed post instead of the correct content type.

## Root Cause
The `publishToFacebook()` function was ignoring the `postType` parameter and always using `facebookService.createPost()` which only posts to the feed.

## Solution

### 1. Added New Facebook Service Methods

Created three specialized methods in `facebookService.js`:

#### **createPost()** - Regular Feed Posts
```javascript
// Posts to /{page-id}/feed or /{page-id}/photos
// Creates standard feed posts that stay on page
// Supports text, images, links
```

#### **createStory()** - 24-Hour Stories  
```javascript
// Uses temporary: true parameter
// Posts to /{page-id}/photos or /{page-id}/videos
// Creates temporary content that disappears after 24 hours
// URL: https://www.facebook.com/stories/{story_id}
```

#### **createReel()** - Short-Form Videos (with fallback)
```javascript
// Uses /{page-id}/video_reels endpoint
// Creates short-form vertical video content
// Falls back to regular video post if Reels API not available
// URL: https://www.facebook.com/reel/{video_id}
```

#### **createVideoPost()** - Regular Video Posts (fallback)
```javascript
// Uses /{page-id}/videos endpoint
// Posts regular videos to feed
// Used as fallback when Reels API unavailable
```

### 2. Updated Controller Logic

Modified `publishToFacebook()` in `postController.js` to route based on `postType`:

```javascript
switch (postType) {
  case 'story':
    result = await facebookService.createStory(connection, {...});
    break;
    
  case 'reel':
  case 'short':
    result = await facebookService.createReel(connection, {...});
    break;
    
  case 'post':
  default:
    result = await facebookService.createPost(connection, {...});
    break;
}
```

## Facebook API Details

### Story Requirements:
- **Endpoint**: `/{page-id}/photos` or `/{page-id}/videos`
- **Parameter**: `temporary: true` (makes it a 24h story)
- **Supported formats**: Image (JPEG, PNG) or Video (MP4)
- **Video duration**: Up to 60 seconds
- **Aspect ratio**: 9:16 (vertical) recommended
- **Lifespan**: 24 hours

### Reel Requirements:
- **Endpoint**: `/{page-id}/video_reels` (with 3-phase upload)
- **Upload phases**: 
  1. `start` - Initialize upload session
  2. `transfer` - Upload video file
  3. `finish` - Complete and publish
- **Supported format**: Video only (MP4)
- **Video duration**: 15-90 seconds
- **Aspect ratio**: 9:16 (vertical)
- **Fallback**: Uses regular video post if Reels API unavailable

### Post Requirements:
- **Endpoints**: 
  - Text: `/{page-id}/feed`
  - Photos: `/{page-id}/photos`
  - Videos: `/{page-id}/videos`
  - Links: `/{page-id}/feed`
- **Supported formats**: Text, Image (JPEG, PNG), Video (MP4), Links
- **Captions**: Up to 63,206 characters

## Important Notes

### Facebook Stories:
- ⏱️ Disappear after 24 hours (just like Instagram Stories)
- 📱 Best with vertical 9:16 format
- 💬 Limited caption support (use `caption` parameter)
- 🎨 Can be viewed on both Facebook app and web

### Facebook Reels (Shorts):
- 🎵 Similar to Instagram Reels and TikTok
- 🎯 Uses 3-phase upload process (more complex than Instagram)
- ⚠️ **May not be available for all pages** - falls back to video post
- 📺 Appears in Reels/Shorts section when supported
- ⏱️ 15-90 seconds recommended

### Fallback Strategy:
If Reel creation fails (API not available for page):
1. Catches the error
2. Automatically tries `createVideoPost()` instead
3. Posts as regular video to feed
4. User still gets their content published

## Testing

### To Test Story Publishing:
1. Go to Publish page
2. Select Facebook
3. Select **"Story"** as content type
4. Upload image or video
5. Click "Publish Now"
6. Check Facebook - should appear in Stories (not feed)

### To Test Reel Publishing:
1. Go to Publish page
2. Select Facebook
3. Select **"Short"** as content type (Facebook's name for Reels)
4. Upload video (must be video, not image)
5. Add description
6. Click "Publish Now"
7. Check Facebook - should appear in Reels/Shorts section (if available) or as video post

### To Test Regular Post:
1. Go to Publish page
2. Select Facebook
3. Select **"Post"** as content type
4. Upload image/video or just text
5. Add caption
6. Click "Publish Now"
7. Check Facebook - should appear in page feed

## Files Modified

### Backend:
- `backend/src/integrations/meta/facebookService.js`
  - Added `createStory()` method (~70 lines)
  - Added `createReel()` method (~80 lines with fallback)
  - Added `createVideoPost()` method (~50 lines)

- `backend/src/controllers/postController.js`
  - Updated `publishToFacebook()` to switch on `postType`
  - Added validation (stories/reels require media)
  - Added video URL generation for reels

## Expected Behavior

| Content Type | API Call | Where It Appears | Duration |
|--------------|----------|------------------|----------|
| **Post** | `createPost()` | Page feed + Timeline | Permanent |
| **Story** | `createStory()` | Stories (top of page) | 24 hours |
| **Reel/Short** | `createReel()` → `createVideoPost()` | Reels section OR feed | Permanent |

## Error Handling

### Stories:
- Validates media exists
- Supports both image buffers and URLs
- Returns detailed API errors

### Reels:
- Validates video file only
- 3-phase upload with error handling at each phase
- **Automatic fallback** to video post if Reels API unavailable:
  ```javascript
  try {
    // Try Reels API
  } catch {
    // Fallback to regular video post
    return await createVideoPost(...);
  }
  ```

Common errors:
- **Code 100**: Invalid access token
- **Code 190**: Token expired - reconnect Facebook
- **Code 200**: Permission error - need `pages_manage_posts` permission
- **Code 368**: Reel creation not supported for this page (fallback activates)

## Permissions Required

Make sure Facebook app has these permissions:
- ✅ `pages_show_list` (list pages)
- ✅ `pages_read_engagement` (read page data)
- ✅ `pages_manage_posts` (create posts/stories/reels)

## Comparison: Instagram vs Facebook

| Feature | Instagram | Facebook |
|---------|-----------|----------|
| **Stories** | Direct API | Uses `temporary: true` |
| **Reels** | Direct API | 3-phase upload + fallback |
| **API Complexity** | Simpler | More complex |
| **Fallback** | No | Yes (reels → video) |

## Verification

After deploying, verify by:
1. Publishing a story → Check Stories section
2. Publishing a reel → Check Reels section (or feed if fallback)
3. Publishing a post → Check page feed
4. Check backend logs for correct method being called

## Troubleshooting

### Story Not Appearing:
- Check page permissions
- Verify `temporary: true` parameter is set
- Stories expire after 24h

### Reel Falls Back to Video:
- Normal behavior if page doesn't support Reels API
- Some pages don't have Reels enabled
- Fallback ensures content still gets published

### Post Fails Completely:
- Check `pages_manage_posts` permission
- Verify page ID is correct
- Check token hasn't expired

## Rollback

If issues occur, revert these commits:
- `backend/src/integrations/meta/facebookService.js` (lines 560+)
- `backend/src/controllers/postController.js` (publishToFacebook function)

The old behavior will publish everything as regular posts.
