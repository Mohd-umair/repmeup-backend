'use strict';

const mongoose = require('mongoose');

/**
 * Unified CommerceOrder
 *
 * Replaces the Instagram-only ProductOrder with an omnichannel order record
 * that tracks the full lifecycle from discovery to delivery across Instagram,
 * WhatsApp, and Voice channels.
 *
 * The ProductOrder model remains for backward compatibility (retargeting FK,
 * payment webhook). New code should write here; reads for analytics should
 * union both collections or rely on the `channel: 'instagram'` filter.
 */
const lineItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  /** SKU or product._id string — the retailer_id used in WhatsApp catalog */
  retailerId: { type: String, trim: true },
  name: { type: String, trim: true },
  qty: { type: Number, default: 1, min: 1 },
  unitPrice: { type: Number, min: 0 },
  currency: { type: String, default: 'AED', trim: true }
}, { _id: false });

const commerceOrderSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  // ── Channel ────────────────────────────────────────────────────────────────
  channel: {
    type: String,
    enum: ['instagram', 'whatsapp', 'voice', 'manual'],
    required: true,
    index: true
  },

  // ── Status lifecycle ───────────────────────────────────────────────────────
  /**
   * intent          → AI/automation detected purchase intent, no message sent yet
   * product_sent    → Product card sent via WhatsApp catalog or IG DM
   * cart_started    → Customer added item to WhatsApp native cart
   * payment_pending → Payment link sent / awaiting confirmation
   * paid            → Payment confirmed
   * shipped         → Order shipped
   * delivered       → Customer received order
   * cancelled       → Order cancelled at any stage
   */
  status: {
    type: String,
    enum: ['intent', 'product_sent', 'cart_started', 'payment_pending', 'paid', 'shipped', 'delivered', 'cancelled'],
    default: 'product_sent',
    index: true
  },

  // ── Products ───────────────────────────────────────────────────────────────
  lineItems: [lineItemSchema],

  // ── Source references ──────────────────────────────────────────────────────
  /** The inbox Interaction thread this order is attached to */
  sourceInteraction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Interaction'
  },
  /** Instagram post that triggered the IG comment-to-DM flow */
  sourcePostId: { type: String, trim: true },
  /** Resolved Contact for the buyer */
  contact: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact'
  },

  // ── Channel-specific IDs ───────────────────────────────────────────────────
  /** WhatsApp wamid of the product message sent */
  whatsappMessageId: { type: String, trim: true },
  /** Meta Commerce order id from WhatsApp native cart webhook */
  metaOrderId: { type: String, trim: true, index: true, sparse: true },
  /** Instagram user id (migrated from ProductOrder) */
  instagramUserId: { type: String, trim: true },
  /** Correlation token embedded in payment URL (migrated from ProductOrder) */
  orderToken: {
    type: String,
    trim: true,
    unique: true,
    sparse: true
  },

  // ── Payment ────────────────────────────────────────────────────────────────
  paymentRef: { type: String, trim: true },
  /** Total order value (may be null until cart is confirmed) */
  totalAmount: { type: Number, min: 0 },
  currency: { type: String, default: 'AED', trim: true },
  paidAt: { type: Date },
  shippedAt: { type: Date },
  deliveredAt: { type: Date },

  // ── Buyer details from WA native cart ─────────────────────────────────────
  buyerName: { type: String, trim: true },
  buyerPhone: { type: String, trim: true },
  shippingAddress: { type: String, trim: true },

  // ── Meta data ──────────────────────────────────────────────────────────────
  notes: { type: String, trim: true },

  /** Human-readable order ref for inbox ops (e.g. ORD-2847) */
  orderNumber: { type: Number, index: true },
  displayRef: { type: String, trim: true, index: true }
}, {
  timestamps: true
});

// Indexes for common queries
commerceOrderSchema.index({ organization: 1, status: 1, createdAt: -1 });
commerceOrderSchema.index({ organization: 1, channel: 1, createdAt: -1 });
commerceOrderSchema.index({ organization: 1, contact: 1 });
commerceOrderSchema.index({ organization: 1, 'lineItems.product': 1 });
commerceOrderSchema.index({ organization: 1, displayRef: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('CommerceOrder', commerceOrderSchema);
