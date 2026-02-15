# AI Credit Usage Tracking Fix

## Issues Fixed

### 1. Knowledge Base from URL - Missing User Tracking
**Problem**: When creating knowledge base entries from URLs, AI credits were being deducted but not properly tracked with the user who performed the action.

**Root Cause**: The `deductCredits` call was missing `userId` in metadata.

**Fix Applied**:
- Added `userId: req.user._id` to the metadata in `knowledgeBaseController.js`
- Now properly tracks which user created the knowledge base entry from URL

**File**: `backend/src/controllers/knowledgeBaseController.js` (lines 313-322)

### 2. Auto-Reply - Missing User Tracking
**Problem**: When auto-replies were generated, AI credits were being deducted but not associated with any user in the credit usage records.

**Root Cause**: The `deductCredits` call in `aiService.generateAutoReply()` was missing `userId` in metadata.

**Fix Applied**:
- Added logic to find the appropriate user to attribute the auto-reply to:
  1. First checks if interaction has an `assignedTo` user
  2. Falls back to finding an admin/manager from the organization
- Passes the `userId` to `deductCredits` metadata

**File**: `backend/src/services/aiService.js` (lines 1075-1092)

### 3. Missing Operation Types in AICreditUsage Model
**Problem**: The `operation` enum in AICreditUsage model didn't include `'knowledge_base_from_url'` and `'auto_reply'`, causing validation errors when trying to save credit usage records.

**Fix Applied**:
- Added both operation types to the enum:
  - `'knowledge_base_from_url'`
  - `'auto_reply'`

**File**: `backend/src/models/AICreditUsage.js` (line 22-30)

## How It Works Now

### Credit Deduction Flow
1. **Knowledge Base from URL**:
   ```javascript
   await aiCreditService.deductCredits(orgId, credits, {
     operation: 'knowledge_base_from_url',
     userId: req.user._id,  // ✅ Now tracked!
     url: url,
     wordCount: wordCount,
     tagCount: tagCount
   });
   ```

2. **Auto-Reply**:
   ```javascript
   // Find user to attribute to
   let userId = interaction.assignedTo;
   if (!userId) {
     const adminUser = await User.findOne({ 
       organization: orgId, 
       role: { $in: ['admin', 'manager'] } 
     });
     userId = adminUser?._id;
   }
   
   await aiCreditService.deductCredits(orgId, 1, {
     operation: 'auto_reply',
     userId: userId,  // ✅ Now tracked!
     interactionId: interaction._id,
     platform: interaction.platform
   });
   ```

### AICreditUsage Records Created
Both operations now properly create records in `AICreditUsage` collection with:
- `organization`: Organization ID
- `user`: User ID who performed/triggered the action
- `operation`: Type of AI operation
- `creditsUsed`: Number of credits consumed
- `metadata`: Additional context (URL, platform, interaction ID, etc.)
- `createdAt`: Timestamp

## Testing
To verify the fix works:

1. **Test Knowledge Base from URL**:
   - Create a knowledge base entry from URL
   - Check `AICreditUsage` collection
   - Verify record has correct `userId` and `operation: 'knowledge_base_from_url'`

2. **Test Auto-Reply**:
   - Trigger an auto-reply (via sync or webhook)
   - Check `AICreditUsage` collection
   - Verify record has correct `userId` (assigned user or admin) and `operation: 'auto_reply'`

## Database Query Examples

```javascript
// Check knowledge base credit usage
db.aicreditusages.find({ 
  operation: 'knowledge_base_from_url' 
}).sort({ createdAt: -1 }).limit(10)

// Check auto-reply credit usage
db.aicreditusages.find({ 
  operation: 'auto_reply' 
}).sort({ createdAt: -1 }).limit(10)

// Check all usage for a specific user
db.aicreditusages.find({ 
  user: ObjectId('USER_ID_HERE') 
}).sort({ createdAt: -1 })
```

## Impact
- ✅ All AI credit usage is now properly tracked with user attribution
- ✅ Credit usage analytics and reports will show accurate data
- ✅ Admins can see who is using AI credits and for what operations
- ✅ No more "orphaned" credit deductions without user tracking
