'use strict';
/**
 * WhatsApp AI Session State
 *
 * Stores per-customer AI conversation state for WhatsApp DMs.
 * Used to:
 *   - Track pending actions (awaiting_shipping_address, awaiting_product_choice)
 *   - Ground image/product requests to real DB entities
 *   - Detect session boundaries (gaps > SESSION_GAP_MS reset the state)
 *
 * Unique per (organization, phoneNumberId, senderId). TTL index on expiresAt
 * automatically purges stale states so no cron cleanup is needed.
 */

const mongoose = require('mongoose');

const PENDING_ACTIONS = [
  'awaiting_shipping_address',
  'awaiting_product_choice'
];

const ACTIVE_DOMAINS = ['commerce', 'appointment', 'general'];

const schema = new mongoose.Schema(
  {
    organization:  { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    phoneNumberId: { type: String, required: true },
    senderId:      { type: String, required: true },

    // Which conversation domain is currently active
    activeDomain: { type: String, enum: ACTIVE_DOMAINS, default: 'general' },

    // What we are currently waiting for from the customer
    pendingAction: { type: String, enum: PENDING_ACTIONS, default: null },

    // The CommerceOrder we are tracking (when pendingAction = awaiting_shipping_address)
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Last product the customer was shown / inquired about
    selectedProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    selectedVariant:   { type: String, default: null },

    // Session metadata — set on every new session start
    sessionId:         { type: String, default: null },
    sessionStartedAt:  { type: Date,   default: null },

    // TTL: Mongo removes the document automatically at this time.
    // Set to 48h from last update so idle states self-clean.
    expiresAt: { type: Date, index: { expires: 0 } }
  },
  { timestamps: true }
);

// Compound unique so we can upsert with findOneAndUpdate
schema.index(
  { organization: 1, phoneNumberId: 1, senderId: 1 },
  { unique: true }
);

/**
 * Upsert helper: set pendingAction + optional entityId + expiry.
 * Always use this instead of raw findOneAndUpdate so the TTL is always refreshed.
 *
 * @param {object} key  { organization, phoneNumberId, senderId }
 * @param {object} data { pendingAction?, entityId?, selectedProductId?, selectedVariant?,
 *                        activeDomain?, sessionId?, sessionStartedAt? }
 * @param {number} [ttlMs=48*3600*1000]
 */
schema.statics.setPendingAction = async function setPendingAction(key, data, ttlMs = 48 * 3600 * 1000) {
  const expiresAt = new Date(Date.now() + ttlMs);
  return this.findOneAndUpdate(
    { organization: key.organization, phoneNumberId: key.phoneNumberId, senderId: key.senderId },
    { $set: { ...data, expiresAt } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

/**
 * Clear all pending state for a customer (e.g. address captured, session reset).
 */
schema.statics.clearPendingAction = async function clearPendingAction(key) {
  return this.findOneAndUpdate(
    { organization: key.organization, phoneNumberId: key.phoneNumberId, senderId: key.senderId },
    { $set: { pendingAction: null, entityId: null, activeDomain: 'general', expiresAt: new Date(Date.now() + 48 * 3600 * 1000) } }
  );
};

/**
 * Fully delete the AI state record for a customer (on session reset).
 */
schema.statics.resetSession = async function resetSession(key) {
  return this.deleteOne(
    { organization: key.organization, phoneNumberId: key.phoneNumberId, senderId: key.senderId }
  );
};

module.exports = mongoose.model('WhatsAppAiState', schema);
