# AI Credit Tracking System

## Overview
Complete AI credit tracking system that monitors and logs all AI operations across the platform, including post generation, AI responses in inbox, and auto-replies.

## Features Implemented

### 1. AI Credits Page (`/app/ai-credits`)
A dedicated page showing comprehensive credit usage information:

- **Overview Cards**
  - Total monthly limit
  - Credits used this month
  - Credits remaining
  - Color-coded status (green/yellow/red)

- **Progress Bar**
  - Visual representation of usage percentage
  - Color changes based on usage level

- **Warning Messages**
  - Alerts when approaching limit (90%+)
  - Critical alerts when limit reached
  - Direct upgrade link

- **Usage History**
  - Paginated list of all credit usage events
  - Operation type icons and labels
  - Timestamp and metadata
  - Credits used per operation
  - Full context (prompt preview, platforms, etc.)

### 2. Header Badge
Persistent AI credits display in the application header:

- **Always Visible**: Shows remaining credits at all times
- **Color-Coded Status**:
  - Purple (Normal): Regular usage
  - Yellow (Warning): 90%+ used
  - Red (Critical): At limit
- **Clickable**: Opens AI Credits page
- **Auto-Refresh**: Updates every 30 seconds
- **Responsive**: Adapts to mobile/tablet/desktop

### 3. Credit Tracking Operations

#### A. Post Generation (`post_generation`)
**Location**: `backend/src/controllers/postController.js`

Tracks credits when generating AI posts from the Publish page:
- 1 credit for same post across all platforms
- 1 credit per platform for custom posts per platform

**Metadata Logged**:
- User ID
- Prompt (first 100 chars)
- Platforms selected
- Mode (same/custom)
- Post type

#### B. AI Response Generation (`ai_response`)
**Location**: `backend/src/controllers/inboxController.js`

Tracks credits when generating AI suggestions in inbox:
- 1 credit per AI response generated
- Checks credits before generation
- Shows error if insufficient credits

**Metadata Logged**:
- User ID
- Interaction ID
- Platform
- Message preview (first 100 chars)
- Whether it's an auto-reply

#### C. Auto-Reply Generation
**Location**: `backend/src/controllers/inboxController.js`

Tracks credits for batch auto-reply operations:
- 1 credit per auto-reply generated
- Skips interactions if insufficient credits
- Tracks both manual and automated batches

**Metadata Logged**:
- User ID
- Interaction ID
- Platform
- Auto-reply flag
- Test flag (for auto-reply testing)

### 4. Backend Implementation

#### Database Model
**File**: `backend/src/models/AICreditUsage.js`

```javascript
{
  organization: ObjectId,
  user: ObjectId,
  operation: 'post_generation' | 'ai_response' | 'sentiment_analysis' | 'content_analysis',
  creditsUsed: Number,
  metadata: {
    prompt: String,
    platforms: Array,
    interactionId: String,
    platform: String,
    // ... additional context
  },
  createdAt: Date
}
```

#### Service Layer
**File**: `backend/src/services/aiCreditService.js`

**New Methods**:
- `getUsageHistory(organizationId, options)`: Get paginated usage history
  - Supports date filtering
  - Pagination (page, limit)
  - Sorted by most recent

**Enhanced Methods**:
- `deductCredits()`: Now logs usage events to `AICreditUsage` collection
  - Records operation type
  - Stores user ID
  - Saves metadata for audit trail

#### API Endpoints
**File**: `backend/src/routes/users.js`

- `GET /api/users/ai-credits`: Get current credit status
- `GET /api/users/ai-credits/usage`: Get paginated usage history
  - Query params: `page`, `limit`, `startDate`, `endDate`

### 5. Frontend Implementation

#### Components Created
**File**: `frontend/src/app/features/ai-credits/ai-credits.component.ts`

- Loads current credit status
- Displays usage history with pagination
- Shows operation icons and labels
- Formats dates and metadata
- Provides navigation controls

#### Header Integration
**File**: `frontend/src/app/shared/components/header/header.component.ts`

- Loads credits on user authentication
- Refreshes every 30 seconds
- Navigates to credits page on click
- Color-codes based on status

#### Inbox Integration
**File**: `frontend/src/app/features/inbox/inbox-detail/inbox-detail.component.ts`

- Shows credit error messages
- Handles insufficient credit errors gracefully
- Logs credit warnings to console

### 6. Credit Check Flow

```
User Action (e.g., Generate AI Response)
    ↓
Check Credits (aiCreditService.checkCredits)
    ↓
├─ Insufficient → Return 403 Error
│                 Show error message to user
│                 Suggest upgrade
│
└─ Sufficient → Generate AI Content
                    ↓
                Deduct Credits (aiCreditService.deductCredits)
                    ↓
                Log Usage Event (AICreditUsage.create)
                    ↓
                Return Success + Updated Credit Balance
```

### 7. Error Handling

#### Backend
- Returns specific error codes:
  - `AI_CREDITS_EXCEEDED`: No credits remaining
  - `INSUFFICIENT_CREDITS`: Not enough for operation
  - `NO_SUBSCRIPTION`: No active subscription

#### Frontend
- Displays user-friendly error messages
- Shows upgrade prompt when at limit
- Provides navigation to plans page

### 8. Operation Labels

| Operation Code | Display Label | Icon |
|----------------|---------------|------|
| `post_generation` | Post Generation | 🪄 (wand-magic-sparkles) |
| `ai_response` | AI Response | ⚡ (bolt) |
| `content_analysis` | Content Analysis | 📊 (chart-line) |
| `sentiment_analysis` | Sentiment Analysis | 😊 (face-smile) |

## Usage Examples

### Check Credits Before Operation
```javascript
const creditCheck = await aiCreditService.checkCredits(organizationId, 1);
if (!creditCheck.allowed) {
  return res.status(403).json({
    success: false,
    error: creditCheck.error,
    code: creditCheck.code
  });
}
```

### Deduct Credits After Success
```javascript
await aiCreditService.deductCredits(organizationId, 1, {
  operation: 'ai_response',
  userId: req.user._id,
  interactionId: interaction._id,
  platform: 'instagram',
  messagePreview: 'Hello...'
});
```

### Get Usage History
```javascript
const history = await aiCreditService.getUsageHistory(organizationId, {
  page: 1,
  limit: 20,
  startDate: '2026-01-01',
  endDate: '2026-01-31'
});
```

## Testing

### Test Credit Tracking
1. Navigate to Publish page
2. Generate a post with AI
3. Check header badge (credits should decrease)
4. Click on credits badge
5. Verify usage appears in history

### Test Insufficient Credits
1. Use AI until credits are exhausted
2. Try to generate another AI response
3. Verify error message appears
4. Verify upgrade prompt is shown

## Security Considerations

- All credit checks happen on backend
- Credit deduction is atomic
- Usage logs are tied to specific users
- Organization-level credit tracking prevents abuse

## Future Enhancements

1. **Real-time Updates**: WebSocket for instant credit updates
2. **Credit Alerts**: Email notifications when approaching limit
3. **Usage Analytics**: Detailed charts and trends
4. **Export**: Download usage history as CSV
5. **Rollover**: Unused credits roll over to next month
6. **Refunds**: Credit refunds for failed operations

## Related Files

### Backend
- `/backend/src/models/AICreditUsage.js` - Usage tracking model
- `/backend/src/services/aiCreditService.js` - Credit management service
- `/backend/src/controllers/postController.js` - Post generation tracking
- `/backend/src/controllers/inboxController.js` - AI response tracking
- `/backend/src/controllers/userController.js` - Credit API endpoints
- `/backend/src/routes/users.js` - Credit routes

### Frontend
- `/frontend/src/app/features/ai-credits/` - Credits page component
- `/frontend/src/app/shared/components/header/` - Header badge
- `/frontend/src/app/features/inbox/inbox-detail/` - Inbox integration
- `/frontend/src/app/app-routing.module.ts` - Routes configuration

## Date Implemented
January 27, 2026
