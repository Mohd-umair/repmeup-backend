'use strict';
/**
 * Correlation Context Utility
 *
 * Builds structured log metadata for each inbound message processing event.
 * Applies PII-safe hashing to phone numbers / customer identifiers so that
 * production logs contain enough information to trace an issue without exposing
 * raw customer data.
 *
 * Usage:
 *   const ctx = buildCorrelationCtx({ organizationId, senderId, mid, platform });
 *   logger.info('[WhatsApp] Processing message', ctx);
 */

const crypto = require('crypto');

/**
 * One-way hash of a raw identifier for PII-safe logging.
 * Returns the first 12 hex chars (6 bytes) — unique enough for tracing,
 * too short to reverse.
 *
 * @param {string} raw
 * @returns {string}
 */
function hashId(raw) {
  if (!raw) return 'unknown';
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 12);
}

/**
 * Build a correlation context object suitable for structured logging.
 *
 * @param {object} opts
 * @param {string}  opts.organizationId
 * @param {string}  [opts.senderId]       Raw customer phone / platform ID — will be hashed
 * @param {string}  [opts.phoneNumberId]  WhatsApp business phone number ID
 * @param {string}  [opts.mid]            Inbound message ID (wamid)
 * @param {string}  [opts.platform]
 * @param {string}  [opts.sessionId]
 * @param {string}  [opts.engine]         Which engine handled this: 'appointment'|'commerce'|'keyword'|'generic_ai'|'order_handler'
 * @param {string}  [opts.interactionId]  MongoDB Interaction _id
 * @param {string}  [opts.orderId]        CommerceOrder _id
 * @param {string}  [opts.productId]      Product _id
 * @param {boolean} [opts.sessionReset]   True when a new session was detected
 * @returns {object}
 */
function buildCorrelationCtx(opts = {}) {
  return {
    orgId:       opts.organizationId ? String(opts.organizationId) : undefined,
    senderHash:  hashId(opts.senderId),
    phoneNumId:  opts.phoneNumberId || undefined,
    mid:         opts.mid || undefined,
    platform:    opts.platform || undefined,
    sessionId:   opts.sessionId || undefined,
    engine:      opts.engine || undefined,
    iid:         opts.interactionId ? String(opts.interactionId) : undefined,
    orderId:     opts.orderId ? String(opts.orderId) : undefined,
    productId:   opts.productId ? String(opts.productId) : undefined,
    sessionReset: opts.sessionReset || undefined,
    _ts:         Date.now()
  };
}

module.exports = { buildCorrelationCtx, hashId };
