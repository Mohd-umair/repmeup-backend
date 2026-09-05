const mongoose = require('mongoose');

/**
 * Story-to-DM automation audit + idempotency.
 * One log per (org, user, story, triggerType) when deduplicateDms is enabled.
 */
const storyEngagementLogSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    instagramUserId: { type: String, required: true, index: true },
    storyMediaId: { type: String, required: true, index: true },
    triggerType: {
      type: String,
      enum: ['story_reply', 'story_mention'],
      required: true
    },
    dmInteractionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Interaction',
      required: true
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null
    }
  },
  { timestamps: true }
);

storyEngagementLogSchema.index(
  { organization: 1, instagramUserId: 1, storyMediaId: 1, triggerType: 1 },
  { unique: true }
);

module.exports = mongoose.model('StoryEngagementLog', storyEngagementLogSchema);
