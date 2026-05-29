const mongoose = require('mongoose');

/**
 * Product / Catalog item.
 * Stores the org's product details and the list of Instagram post IDs mapped to this product.
 * When a comment arrives on a linked post, RepMeUp can automatically send the commenter a DM.
 */
const productSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  sku: {
    type: String,
    trim: true,
    index: true
  },

  name: {
    type: String,
    required: true,
    trim: true
  },

  description: {
    type: String,
    trim: true,
    default: ''
  },

  price: {
    type: Number,
    required: true,
    min: 0
  },

  currency: {
    type: String,
    default: 'AED',
    trim: true
  },

  discountPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

  /** Array of image URLs (can be CDN or direct URLs) */
  images: [{
    type: String,
    trim: true
  }],

  /** External checkout / payment link customers are sent in the DM */
  paymentUrl: {
    type: String,
    trim: true,
    default: ''
  },

  sizes: [{
    type: String,
    trim: true
  }],

  colors: [{
    type: String,
    trim: true
  }],

  /** null = unlimited */
  stock: {
    type: Number,
    default: null,
    min: 0
  },

  /**
   * Instagram media/post IDs this product is linked to.
   * When a comment arrives on any of these posts, it may trigger a product DM.
   */
  instagramPostIds: [{
    type: String,
    trim: true
  }],

  /**
   * Instagram story media IDs linked to this product for Story-to-DM automation.
   */
  instagramStoryIds: [{
    type: String,
    trim: true
  }],

  /**
   * Optional per-post metadata when multiple products share one IG post (e.g. carousel).
   * postId matches parent carousel album id or single-post id.
   */
  instagramPostLinks: [{
    postId: { type: String, trim: true },
    slideIndex: { type: Number, min: 0, default: null },
    sortOrder: { type: Number, min: 0, default: null }
  }],

  /**
   * Per-product Comment-to-DM configuration.
   * Every field is optional — if omitted the field inherits from
   * org.salesFlowSettings (global defaults).  Presence of ctaButtons[]
   * takes full precedence over the org array (no partial merge on buttons).
   */
  dmConfig: {
    ctaTitle:    { type: String, trim: true },
    ctaSubtitle: { type: String, trim: true },
    ctaImageUrl: { type: String, trim: true },

    ctaButtons: [{
      label:   { type: String, trim: true, maxlength: 20 },
      type:    { type: String, enum: ['postback', 'web_url'], default: 'postback' },
      payload: { type: String, trim: true, maxlength: 64 },
      url:     { type: String, trim: true }
    }],

    /** Override the org-level trigger keywords for this product */
    triggerKeywords: [String],

    /** Override the public comment reply stub */
    publicReplyTemplate: { type: String, trim: true },

    /** Override hesitancy keywords for WhatsApp-capture flow */
    hesitancyKeywords: [String],

    /** Override WhatsApp-capture request / confirmation messages */
    whatsappCaptureMessage:      { type: String, trim: true },
    whatsappCaptureConfirmation: { type: String, trim: true }
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  /**
   * WhatsApp Commerce Catalog sync state.
   * catalogItemId — Meta's product item id returned after a successful sync.
   * syncStatus    — tracks per-item sync state so the UI can show badges.
   */
  whatsapp: {
    catalogItemId: String,
    syncStatus: {
      type: String,
      enum: ['synced', 'pending', 'failed', 'not_synced'],
      default: 'not_synced'
    },
    syncedAt: Date,
    syncError: String
  }
}, {
  timestamps: true
});

productSchema.index({ organization: 1, isActive: 1 });
productSchema.index({ organization: 1, instagramPostIds: 1 });
productSchema.index({ organization: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $exists: true, $type: 'string' } } });
productSchema.index({ organization: 1, 'whatsapp.syncStatus': 1 });
// Text index for AI product search — enables $text queries in productSearchService
productSchema.index({ name: 'text', description: 'text', sku: 'text' }, { weights: { name: 10, sku: 5, description: 1 } });

/** Returns the effective price after discount */
productSchema.virtual('effectivePrice').get(function () {
  if (!this.discountPercent) return this.price;
  return +(this.price * (1 - this.discountPercent / 100)).toFixed(2);
});

module.exports = mongoose.model('Product', productSchema);
