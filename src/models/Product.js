const mongoose = require('mongoose');
const {
  CONDITIONS,
  AVAILABILITY_VALUES,
  GENDERS,
  AGE_GROUPS,
  WA_COMPLIANCE_CATEGORIES,
  WEIGHT_UNITS
} = require('../utils/productCommerceFields');

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
    default: 'INR',
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

  /**
   * Product page URL on the business's website — sent to Meta as the catalog
   * item `link`. Falls back to paymentUrl in the sync payload when unset.
   */
  websiteUrl: {
    type: String,
    trim: true,
    default: ''
  },

  /**
   * Meta/WhatsApp Commerce catalog attributes (all optional; unset fields are
   * simply omitted from the sync payload). Enums/values mirror Meta's catalog
   * field spec — see utils/productCommerceFields.js (single source of truth).
   * `default: undefined` keeps old documents untouched (no empty {} persisted).
   */
  commerce: {
    type: new mongoose.Schema({
      brand: { type: String, trim: true, maxlength: 100 },
      condition: { type: String, enum: CONDITIONS },
      /** Explicit override; unset → derived from `stock === 0`. */
      availability: { type: String, enum: AVAILABILITY_VALUES },

      /** Identifiers */
      gtin: { type: String, trim: true, maxlength: 14 },
      mpn: { type: String, trim: true, maxlength: 100 },

      /** Categorization */
      googleProductCategory: { type: String, trim: true, maxlength: 750 },
      fbProductCategory: { type: String, trim: true, maxlength: 750 },
      productType: { type: String, trim: true, maxlength: 750 },

      /** Variant attributes (single item per product — no auto-expansion) */
      itemGroupId: { type: String, trim: true, maxlength: 100 },
      color: { type: String, trim: true, maxlength: 200 },
      size: { type: String, trim: true, maxlength: 200 },
      gender: { type: String, enum: GENDERS },
      ageGroup: { type: String, enum: AGE_GROUPS },
      material: { type: String, trim: true, maxlength: 200 },
      pattern: { type: String, trim: true, maxlength: 100 },

      /** India compliance (WhatsApp requirement for India sellers) */
      originCountry: { type: String, trim: true, uppercase: true, maxlength: 2 },
      importerName: { type: String, trim: true, maxlength: 200 },
      importerAddress: {
        street1: { type: String, trim: true, maxlength: 200 },
        street2: { type: String, trim: true, maxlength: 200 },
        city: { type: String, trim: true, maxlength: 200 },
        region: { type: String, trim: true, maxlength: 200 },
        postalCode: { type: String, trim: true, maxlength: 20 },
        country: { type: String, trim: true, uppercase: true, maxlength: 2 }
      },
      manufacturerInfo: { type: String, trim: true, maxlength: 1000 },
      waComplianceCategory: { type: String, enum: WA_COMPLIANCE_CATEGORIES },

      /** Sale window — sale price itself derives from discountPercent */
      salePriceStart: { type: Date },
      salePriceEnd: { type: Date },

      unitPrice: {
        value: { type: Number, min: 0 },
        currency: { type: String, trim: true, uppercase: true, maxlength: 3 },
        unit: { type: String, trim: true, lowercase: true }
      },

      shippingWeight: {
        value: { type: Number, min: 0 },
        unit: { type: String, enum: WEIGHT_UNITS }
      },

      /** Direct-download video URLs (Meta supports up to 20) */
      videoUrls: { type: [String], default: undefined }
    }, { _id: false }),
    default: undefined
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

  /** Where the product originated (manual creation or platform import/sync). */
  source: {
    type: String,
    enum: ['manual', 'shopify', 'woocommerce', 'custom_url'],
    default: 'manual'
  },

  /**
   * Shopify sync state — populated for products synced from a Shopify store.
   * productId  — Shopify product GID (gid://shopify/Product/123)
   * variantId  — Shopify variant GID (used for per-variant upsert keying)
   * syncedAt   — timestamp of last successful sync for this product/variant
   */
  shopify: {
    productId: String,
    variantId: String,
    syncedAt: Date
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
productSchema.index(
  { organization: 1, 'shopify.productId': 1, 'shopify.variantId': 1 },
  { unique: true, sparse: true }
);
// Text index for AI product search — enables $text queries in productSearchService
productSchema.index({ name: 'text', description: 'text', sku: 'text' }, { weights: { name: 10, sku: 5, description: 1 } });

/** Returns the effective price after discount */
productSchema.virtual('effectivePrice').get(function () {
  if (!this.discountPercent) return this.price;
  return +(this.price * (1 - this.discountPercent / 100)).toFixed(2);
});

module.exports = mongoose.model('Product', productSchema);
