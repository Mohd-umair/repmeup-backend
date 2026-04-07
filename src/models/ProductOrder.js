const mongoose = require('mongoose');

/**
 * Tracks a "comment-to-DM" conversation for an Instagram product.
 * Created when RepMeUp sends a product DM to a commenter.
 * Also used for deduplication (don't DM the same person twice for the same post).
 */
const productOrderSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },

  /** IG platform user ID of the commenter */
  instagramUserId: {
    type: String,
    required: true,
    trim: true
  },

  instagramPostId: {
    type: String,
    trim: true
  },

  /** platformId of the original comment Interaction */
  commentInteractionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Interaction'
  },

  /**
   * Unique token embedded in the payment URL so the payment webhook can correlate
   * this order back to an IG user without exposing PII in the URL.
   * e.g. paymentUrl = `${product.paymentUrl}?ref=${orderToken}`
   */
  orderToken: {
    type: String,
    unique: true,
    sparse: true,
    trim: true
  },

  status: {
    type: String,
    enum: ['dm_sent', 'payment_initiated', 'paid', 'cancelled'],
    default: 'dm_sent'
  },

  /** Reference from payment provider (e.g. Razorpay payment_id) */
  paymentRef: {
    type: String,
    trim: true,
    default: null
  },

  paidAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Fast deduplication lookup: did we already DM this user for this product+post combo?
productOrderSchema.index({ organization: 1, instagramUserId: 1, instagramPostId: 1 });
// Note: orderToken already has a unique index via `unique: true` in the schema field — no duplicate needed.

module.exports = mongoose.model('ProductOrder', productOrderSchema);
