const mongoose = require('mongoose');

/**
 * Follow-invite DMs sent from Instagram comment automation (audit + idempotency).
 * - Webhook retries: unique on (organization, commentInteractionId).
 * - Per user/post cap: checked in code when deduplicateDms is enabled.
 */
const commentFollowInviteLogSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },
    instagramUserId: { type: String, required: true, index: true },
    instagramPostId: { type: String, required: true, index: true },
    commentInteractionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Interaction',
      required: true
    },
    dmMethod: {
      type: String,
      enum: ['generic_template', 'text_fallback'],
      default: 'generic_template'
    }
  },
  { timestamps: true }
);

commentFollowInviteLogSchema.index(
  { organization: 1, commentInteractionId: 1 },
  { unique: true }
);
commentFollowInviteLogSchema.index({ organization: 1, instagramUserId: 1, instagramPostId: 1 });

module.exports = mongoose.model('CommentFollowInviteLog', commentFollowInviteLogSchema);
