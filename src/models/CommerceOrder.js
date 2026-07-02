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
  currency: { type: String, default: 'INR', trim: true }
}, { _id: false });

/** Structured shipping address (parsed from chat or edited by an agent). */
const shippingSchema = new mongoose.Schema({
  name:    { type: String, trim: true },
  phone:   { type: String, trim: true },
  line1:   { type: String, trim: true },
  line2:   { type: String, trim: true },
  city:    { type: String, trim: true },
  state:   { type: String, trim: true },
  pincode: { type: String, trim: true },
  country: { type: String, trim: true, default: 'India' }
}, { _id: false });

/** Shipment tracking captured at dispatch. */
const trackingSchema = new mongoose.Schema({
  courier:        { type: String, trim: true },
  trackingNumber: { type: String, trim: true },
  trackingUrl:    { type: String, trim: true }
}, { _id: false });

/** Append-only audit of every status change (powers the order timeline). */
const statusEventSchema = new mongoose.Schema({
  status: { type: String, trim: true },
  at:     { type: Date, default: Date.now },
  note:   { type: String, trim: true },
  byName: { type: String, trim: true }
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
   * Full e-commerce lifecycle:
   *   pending          → new order placed, awaiting merchant action
   *   confirmed        → merchant accepted the order
   *   payment_pending  → awaiting payment
   *   paid             → payment confirmed
   *   processing       → being packed / prepared
   *   dispatched       → handed to courier (tracking captured)
   *   out_for_delivery → with the delivery agent
   *   delivered        → customer received the order
   *   cancelled        → cancelled at any open stage (reason captured)
   *   returned         → customer returned a delivered order (reason captured)
   *   refunded         → money returned to the customer
   * Legacy (kept for old records): intent, product_sent, cart_started, shipped.
   */
  status: {
    type: String,
    enum: [
      'pending', 'intent', 'product_sent', 'cart_started', 'confirmed',
      'payment_pending', 'paid', 'processing', 'dispatched', 'shipped',
      'out_for_delivery', 'delivered', 'cancelled', 'returned', 'refunded'
    ],
    default: 'pending',
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
  paymentMethod: { type: String, trim: true }, // e.g. 'cod', 'razorpay', 'upi', 'card'
  /** Total order value (may be null until cart is confirmed) */
  totalAmount: { type: Number, min: 0 },
  currency: { type: String, default: 'INR', trim: true },

  // ── Lifecycle timestamps ───────────────────────────────────────────────────
  confirmedAt: { type: Date },
  paidAt: { type: Date },
  processingAt: { type: Date },
  dispatchedAt: { type: Date },
  shippedAt: { type: Date }, // legacy alias of dispatchedAt
  outForDeliveryAt: { type: Date },
  deliveredAt: { type: Date },
  cancelledAt: { type: Date },
  returnedAt: { type: Date },
  refundedAt: { type: Date },

  // ── Fulfilment ─────────────────────────────────────────────────────────────
  tracking: { type: trackingSchema, default: undefined },
  cancellationReason: { type: String, trim: true },
  returnReason: { type: String, trim: true },
  refund: {
    amount:    { type: Number, min: 0 },
    reference: { type: String, trim: true },
    at:        { type: Date }
  },

  // ── Buyer details from WA native cart ─────────────────────────────────────
  buyerName: { type: String, trim: true },
  buyerPhone: { type: String, trim: true },
  /** Free-text address (legacy / as received). Structured address in `shipping`. */
  shippingAddress: { type: String, trim: true },
  shipping: { type: shippingSchema, default: undefined },

  // ── Audit ──────────────────────────────────────────────────────────────────
  statusHistory: { type: [statusEventSchema], default: [] },

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
