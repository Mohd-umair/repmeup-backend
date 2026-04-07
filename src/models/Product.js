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

  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

productSchema.index({ organization: 1, isActive: 1 });
productSchema.index({ organization: 1, instagramPostIds: 1 });

/** Returns the effective price after discount */
productSchema.virtual('effectivePrice').get(function () {
  if (!this.discountPercent) return this.price;
  return +(this.price * (1 - this.discountPercent / 100)).toFixed(2);
});

module.exports = mongoose.model('Product', productSchema);
