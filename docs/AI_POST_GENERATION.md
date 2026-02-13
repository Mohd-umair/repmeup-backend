# AI Post Generation with Credit System

## Overview
Users can generate social media posts using AI by simply describing what they want to post. The system supports two modes with smart credit usage.

## Features

### 1. **Two Generation Modes**

#### **Same Post Mode** (1 Credit)
- Generates ONE post that works for ALL selected platforms
- Optimized for cross-platform posting
- Cost: **1 credit** regardless of platform count
- Use case: Generic announcements, updates, promotions

#### **Custom Mode** (N Credits)
- Generates UNIQUE post for EACH platform
- Optimized per platform (tone, hashtags, format)
- Cost: **1 credit per platform**
- Use case: Platform-specific content, tailored messaging

### 2. **Credit System**

Credits are deducted based on mode:
- **Same mode**: 1 credit (post used on Instagram, Facebook, LinkedIn)
- **Custom mode**: 3 credits (unique post for Instagram, Facebook, LinkedIn)

### 3. **Platform-Specific Optimization**

#### Instagram:
- Visual-first language
- 5-10 hashtags
- Emojis encouraged
- 2200 character max
- **Stories**: Casual, behind-the-scenes tone
- **Reels**: Hook in 3 seconds, discovery hashtags

#### Facebook:
- Community-focused
- Questions for engagement
- Longer form OK (63,206 chars)
- 2-3 hashtags
- **Stories**: Conversational, call-to-action
- **Reels/Shorts**: Share-worthy, community angle

#### LinkedIn:
- Professional tone
- Industry insights
- 3000 character max
- 1-3 hashtags only
- Business value focus

## API Endpoints

### Generate Post
```http
POST /api/posts/generate
Authorization: Bearer {token}
Content-Type: application/json

{
  "prompt": "Announce our new product launch with excitement",
  "platforms": ["instagram", "facebook", "linkedin"],
  "mode": "same",  // or "custom"
  "postType": "post"  // or "story", "reel", "short"
}
```

**Response (Same Mode):**
```json
{
  "success": true,
  "data": {
    "mode": "same",
    "posts": {
      "all": "🚀 Exciting news! We're thrilled to announce..."
    },
    "creditsUsed": 1
  },
  "credits": {
    "used": 1,
    "current": 45,
    "limit": 500,
    "remaining": 455,
    "isUnlimited": false
  }
}
```

**Response (Custom Mode):**
```json
{
  "success": true,
  "data": {
    "mode": "custom",
    "posts": {
      "instagram": "🎉 BIG NEWS! Our new product is here...",
      "facebook": "Friends, we have exciting news to share...",
      "linkedin": "We're pleased to announce the launch of..."
    },
    "creditsUsed": 3
  },
  "credits": {
    "used": 3,
    "current": 48,
    "limit": 500,
    "remaining": 452
  }
}
```

**Error Response (Insufficient Credits):**
```json
{
  "success": false,
  "message": "Insufficient AI credits. You need 3 credits but have 2 remaining this month.",
  "credits": {
    "current": 498,
    "limit": 500,
    "remaining": 2,
    "needed": 3
  }
}
```

### Get AI Credits
```http
GET /api/users/ai-credits
Authorization: Bearer {token}
```

**Response:**
```json
{
  "success": true,
  "credits": {
    "current": 45,
    "limit": 500,
    "remaining": 455,
    "percentage": 9,
    "isUnlimited": false,
    "isNearLimit": false,
    "isAtLimit": false
  }
}
```

## Frontend Implementation

### UI Components

**1. Mode Selection**
```
┌─────────────────────────────────────────────┐
│ [Same Post (1 credit)] [Custom (3 credits)] │
└─────────────────────────────────────────────┘
```

**2. Prompt Input**
```
┌─────────────────────────────────────────────┐
│ What do you want to post about?             │
│ ┌─────────────────────────────────────────┐ │
│ │ Example: 'Announce our new product...'  │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**3. Generate Button**
```
┌─────────────────────────────────────────────┐
│ [✨ Generate Post with AI (1 credit)]       │
└─────────────────────────────────────────────┘
```

**4. Custom Mode: Platform Tabs**
```
After generation in custom mode:
┌─────────────────────────────────────────────┐
│ View/Edit Platform-Specific Content:        │
│ [Instagram] [Facebook] [LinkedIn]           │
└─────────────────────────────────────────────┘
```

### User Flow

#### Same Post Mode:
1. User selects platforms (Instagram, Facebook, LinkedIn)
2. Toggles "Same Post" mode
3. Enters prompt: "Share a motivational Monday post"
4. Clicks "Generate Post with AI (1 credit)"
5. AI generates one post
6. Post appears in caption textarea
7. User can edit if needed
8. Publishes to all platforms

**Credits used: 1**

#### Custom Mode:
1. User selects platforms (Instagram, Facebook, LinkedIn)
2. Toggles "Custom" mode
3. Enters prompt: "Announce our summer sale"
4. Clicks "Generate Post with AI (3 credits)"
5. AI generates 3 unique posts
6. Platform tabs appear
7. User clicks each platform to view/edit its content
8. Publishes (each platform gets its custom content)

**Credits used: 3**

## Code Flow

### Backend Flow:
```
1. POST /api/posts/generate
   ↓
2. userController.getAICredits (check balance)
   ↓
3. aiCreditService.checkCredits(org, creditsNeeded)
   ↓
4. aiService.generatePost(prompt, platforms, mode, postType)
   ↓
   If mode === 'same':
     → _generateSinglePost() once
     → Return { posts: { all: content }, creditsUsed: 1 }
   
   If mode === 'custom':
     → _generateSinglePost() for each platform
     → Return { posts: { instagram: ..., facebook: ... }, creditsUsed: N }
   ↓
5. aiCreditService.deductCredits(org, creditsUsed)
   ↓
6. Return generated posts + updated credit balance
```

### Frontend Flow:
```
1. User enters prompt
   ↓
2. User selects mode (same/custom)
   ↓
3. Click "Generate Post with AI"
   ↓
4. Frontend calls POST /api/posts/generate
   ↓
5. Backend generates post(s)
   ↓
6. Frontend receives result:
   If same mode:
     → Set postContent = result.posts.all
   
   If custom mode:
     → Store platformPosts = result.posts
     → Set postContent = first platform's post
     → Show platform tabs to switch between them
   ↓
7. User can edit content
   ↓
8. User publishes normally
```

## Credit Tracking

### Metadata Stored:
```javascript
{
  operation: 'post_generation',
  prompt: 'Announce our new product...',
  platforms: ['instagram', 'facebook', 'linkedin'],
  mode: 'same',
  postType: 'post',
  timestamp: Date
}
```

### Credit Limits by Plan:
- **Free**: 500 credits/month
- **Starter**: 1000 credits/month
- **Professional**: 5000 credits/month
- **Enterprise**: Unlimited (-1)

## Examples

### Example 1: Product Launch (Same Mode)
**Prompt:** "Announce our new AI-powered chatbot with excitement and highlight 3 key benefits"

**Generated Post (All Platforms):**
```
🚀 Big news! We're thrilled to introduce our NEW AI-powered chatbot! 

✨ Key Benefits:
• 24/7 instant customer support
• Understands context & learns from conversations
• Reduces response time by 80%

Ready to revolutionize your customer service? 
Link in bio to learn more!

#AI #Chatbot #CustomerService #Innovation #TechNews
```

**Credits: 1**

### Example 2: Event Promotion (Custom Mode)
**Prompt:** "Promote our webinar on digital marketing happening next Tuesday at 2pm"

**Instagram:**
```
📅 Mark your calendar! 

Join us NEXT TUESDAY at 2pm for an exclusive webinar on digital marketing trends for 2026! 

🎯 What you'll learn:
• Social media strategy hacks
• Content that converts
• Analytics that matter

Limited spots! Link in bio to register 👆

#Webinar #DigitalMarketing #SocialMedia #MarketingTips #Learn
```

**Facebook:**
```
Hey everyone! 👋

We're hosting a FREE webinar next Tuesday (2pm) all about digital marketing strategies that actually work in 2026.

Whether you're a business owner, marketer, or just curious about growing your online presence, this session is for you!

Topics we'll cover:
✓ Social media best practices
✓ Content creation tips
✓ Understanding your analytics

Drop a 🙋 if you're interested and we'll send you the link!

#DigitalMarketing #Webinar #FreeTraining
```

**LinkedIn:**
```
Join us for a professional development webinar on Digital Marketing Strategy.

📅 Date: Next Tuesday
⏰ Time: 2:00 PM
💻 Format: Virtual (Zoom)

In this 60-minute session, we'll explore:

1. Data-driven social media strategies
2. Content optimization for maximum reach
3. Analytics frameworks for measuring ROI

Ideal for marketing professionals, business owners, and team leaders looking to enhance their digital presence.

Comment "INTERESTED" or DM for registration details.

#DigitalMarketing #ProfessionalDevelopment #MarketingStrategy
```

**Credits: 3**

## Testing

### Test Same Mode:
```bash
curl -X POST https://repmeup.in/api/posts/generate \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Share a motivational quote about persistence",
    "platforms": ["instagram", "facebook"],
    "mode": "same",
    "postType": "post"
  }'
```

### Test Custom Mode:
```bash
curl -X POST https://repmeup.in/api/posts/generate \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Announce our Black Friday sale",
    "platforms": ["instagram", "facebook", "linkedin"],
    "mode": "custom",
    "postType": "post"
  }'
```

### Test Credits Check:
```bash
curl https://repmeup.in/api/users/ai-credits \
  -H "Authorization: Bearer {token}"
```

## Error Handling

### Insufficient Credits:
```javascript
if (!creditCheck.allowed) {
  return res.status(403).json({
    success: false,
    message: 'Insufficient AI credits',
    credits: {
      current: 498,
      limit: 500,
      remaining: 2,
      needed: 3
    }
  });
}
```

### AI Generation Failed:
```javascript
catch (error) {
  res.status(500).json({
    success: false,
    message: 'Failed to generate post'
  });
}
```

### No Platforms Selected:
```javascript
if (platforms.length === 0) {
  return res.status(400).json({
    success: false,
    message: 'At least one platform required'
  });
}
```

## Files Modified

### Backend:
- ✅ `backend/src/services/aiService.js` - Added `generatePost()`, `_generateSinglePost()`, `_getPlatformGuidelines()`
- ✅ `backend/src/controllers/postController.js` - Added `generatePostWithAI()`
- ✅ `backend/src/controllers/userController.js` - Added `getAICredits()`
- ✅ `backend/src/routes/postRoutes.js` - Added `/generate` endpoint
- ✅ `backend/src/routes/users.js` - Added `/ai-credits` endpoint

### Frontend:
- ✅ `frontend/src/app/features/publish/publish.component.ts` - Added AI generation logic
- ✅ `frontend/src/app/features/publish/publish.component.html` - Added AI writer UI

### Services Used:
- `aiService.js` - Handles OpenAI/Ollama calls
- `aiCreditService.js` - Manages credit checking and deduction
- Existing subscription system

## Benefits

### For Users:
- ⚡ Generate posts in seconds
- 🎯 Platform-optimized content
- 💰 Flexible pricing (1 vs N credits)
- ✏️ Can edit AI-generated content
- 📊 Real-time credit tracking

### For Business:
- 💵 Revenue from credit usage
- 📈 Higher engagement (platform-optimized)
- ⏱️ Saves time for users
- 🎨 Professional content quality

## Usage Scenarios

| Scenario | Platforms | Mode | Credits | Why |
|----------|-----------|------|---------|-----|
| **Company announcement** | All 3 | Same | 1 | Same message everywhere |
| **Product launch** | All 3 | Custom | 3 | Different tone per platform |
| **Behind-the-scenes** | IG story | Same | 1 | Single platform |
| **Recruitment post** | LinkedIn | Same | 1 | Professional only |
| **Sale promotion** | IG + FB | Custom | 2 | Different CTAs |

## Credit Deduction Tracking

Every generation is logged:
```javascript
await aiCreditService.deductCredits(organizationId, creditsUsed, {
  operation: 'post_generation',
  prompt: 'Announce our new...',
  platforms: ['instagram', 'facebook', 'linkedin'],
  mode: 'same',
  postType: 'post'
});
```

Logged info:
- ✅ Timestamp
- ✅ Organization
- ✅ Prompt (first 100 chars)
- ✅ Platforms used
- ✅ Mode (same/custom)
- ✅ Post type
- ✅ Credits deducted

## Frontend UI Details

### Location in App:
`Publish Page → AI Post Writer Section` (appears above composer when platforms selected)

### Visual Design:
- 🟣 Purple/blue gradient background
- ⚡ Credit counter badge (top right)
- 🔘 Two-button mode selector
- 📝 Prompt textarea
- ✨ Generate button (shows credit cost)
- 📑 Platform tabs (custom mode only)

### States:
1. **Initial**: Empty prompt, "Generate" button disabled
2. **Typing**: User enters prompt, button enabled
3. **Generating**: Spinner animation, button disabled
4. **Generated (Same)**: Content appears in composer
5. **Generated (Custom)**: Content + platform tabs appear

## Best Practices

### For Users:
- 📝 Be specific in prompts ("announce product launch" vs "post something")
- 🎯 Use custom mode for very different audiences
- ✏️ Always review and edit AI content before publishing
- 💰 Use same mode when message is universal (saves credits)

### For Admins:
- 📊 Monitor credit usage per organization
- ⚙️ Adjust limits based on plan
- 🔍 Review prompt patterns for abuse
- 💡 Educate users on mode selection

## Rollback Plan

If issues occur:
1. Comment out route in `postRoutes.js`
2. Remove AI writer section from publish template
3. Credits won't be deducted
4. Users can still compose manually

## Future Enhancements

Potential improvements (not implemented yet):
- 📸 Image generation with DALL-E
- 🎨 Tone selector (professional/casual/funny)
- 🌐 Language selection
- 📅 Best time to post suggestions
- 🔄 Regenerate option (no extra credits)
- 💾 Save favorite prompts
- 📊 A/B testing content variations
- 🎯 Audience targeting suggestions

## Security

### Rate Limiting:
- Protected by auth middleware
- Credit system prevents abuse
- Max 10 credits per operation

### Validation:
- ✅ Prompt required
- ✅ Platforms array required
- ✅ Mode validation (same/custom)
- ✅ Organization verification
- ✅ Credit check before generation

### Data Privacy:
- Prompts logged (first 100 chars only)
- Generated content not stored permanently
- Credits tracked per organization
- User can edit before publishing

## Monitoring

### Backend Logs:
```
✍️ [AI] Generating same post for platforms: [ 'instagram', 'facebook' ]
📝 [AI] Prompt: "Share a motivational Monday post"
📋 [AI] Post type: post
💰 [AI Credits] Deducted 1 credits for org {id}. New total: 46/500
```

### Metrics to Track:
- Total generations per day
- Credits used per organization
- Same vs custom ratio
- Platform popularity
- Average prompt length
- Generation success rate

## Testing Checklist

### Backend:
- [ ] Generate endpoint returns posts
- [ ] Credits deducted correctly
- [ ] Same mode: 1 post returned
- [ ] Custom mode: N posts returned
- [ ] Insufficient credits rejected
- [ ] AI credits endpoint works
- [ ] Platform guidelines applied

### Frontend:
- [ ] AI writer appears when platforms selected
- [ ] Mode toggle works
- [ ] Credit counter displays
- [ ] Generate button shows correct cost
- [ ] Same mode: content fills composer
- [ ] Custom mode: platform tabs appear
- [ ] Platform tabs switch content
- [ ] Credits update after generation
- [ ] Error messages show properly

## Deployment

1. **Backend**:
   - Restart server to load new endpoints
   - Verify OpenAI API key in `.env`
   - Test generation manually

2. **Frontend**:
   - Angular will hot-reload changes
   - Test in browser

3. **Verify**:
   - Check credits deduct properly
   - Test both modes
   - Verify posts are platform-optimized

The feature is now complete and ready to use! 🎉
