'use strict';

const mongoose = require('mongoose');

/**
 * Tracks the multi-turn Instagram DM sales conversation state for a user.
 * Created when a sales-intent product DM is sent via commentToDmService.
 * Advanced by salesConversationService when the user replies.
 */
const salesConversationStateSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  /** Instagram-scoped user ID of the commenter / DM recipient */
  instagramUserId: {
    type: String,
    required: true,
    trim: true
  },

  /** Instagram post ID from which the sales comment originated */
  postId: {
    type: String,
    trim: true
  },

  /** Reference to the ProductOrder created when the CTA DM was sent */
  productOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProductOrder'
  },

  /** Reference to the DM thread Interaction (platformId = dm_${igAccountId}_${userId}) */
  dmInteractionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Interaction'
  },

  /**
   * Sales funnel stage:
   *  awaiting_product_selection — Multi-product post: picker DM sent; waiting for user to choose
   *  initial_cta_sent   — CTA Generic Template DM was sent; waiting for user reply
   *  details_sent       — Bot sent product details (price, sizes, etc.); waiting for next reply
   *  payment_link_sent  — Bot sent payment link; waiting for next reply
   *  whatsapp_requested — Hesitancy detected; bot asked for WhatsApp number
   *  whatsapp_captured  — User shared a WhatsApp number; retargeting data saved
   *  dropped            — Conversation ended with no capture (manual or timeout)
   */
  stage: {
    type: String,
    enum: [
      'awaiting_product_selection',
      'initial_cta_sent',
      'details_sent',
      'payment_link_sent',
      'whatsapp_requested',
      'whatsapp_captured',
      'dropped'
    ],
    default: 'initial_cta_sent'
  },

  /** Token correlating product-picker postback / numeric replies (multi-product posts). */
  selectionToken: {
    type: String,
    trim: true,
    default: null
  },

  /** Product _ids offered on a carousel / multi-product post picker. */
  candidateProductIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],

  /** Original comment Interaction when funnel started from comment-to-DM. */
  commentInteractionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Interaction',
    default: null
  },

  /** Captured WhatsApp number (E.164 or as provided by user) */
  whatsappNumber: {
    type: String,
    trim: true,
    default: null
  },

  /** Timestamp of the last stage transition */
  lastStageAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// One active sales state per user per post per org
salesConversationStateSchema.index(
  { organization: 1, instagramUserId: 1, postId: 1 },
  { unique: true }
);

module.exports = mongoose.model('SalesConversationState', salesConversationStateSchema);
