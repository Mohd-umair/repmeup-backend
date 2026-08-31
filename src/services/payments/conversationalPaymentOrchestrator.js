'use strict';

/**
 * Conversational Payment Orchestrator
 *
 * Channel-independent handler for payment-related customer intents that arrive
 * through Instagram DMs, WhatsApp, or AI-assisted inbox replies.
 *
 * Safety rules (plan section 5):
 *   - LLM may classify/extract intent candidates, but CANNOT choose an amount,
 *     assert payment success, or initiate a refund.
 *   - Amount, order, and contact are always resolved from tenant-owned DB records
 *     — never from unverified LLM output.
 *   - If zero or multiple payable orders exist, the service returns an "ambiguous"
 *     response rather than guessing.
 *   - "Pay now" on an active link returns the existing link (idempotent).
 *   - Paid orders return confirmation. Expired/failed links create a new attempt
 *     only after server-side reconciliation.
 */

const mongoose = require('mongoose');
const logger = require('../../config/logger');

const CommerceOrder = require('../../models/CommerceOrder');
const Payment = require('../../models/Payment');
const Contact = require('../../models/Contact');
const paymentService = require('../payments/paymentService');

// ── Intent types handled here ────────────────────────────────────────────────

const PAYMENT_INTENTS = new Set([
  'purchase_intent',   // customer expresses intent to buy
  'payment_request',   // customer or agent requests a payment link
  'payment_status',    // customer asks about payment status
  'refund_request'     // customer asks for a refund
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Handle a payment-related intent from a conversation.
 *
 * @param {object} params
 * @param {string} params.intentType       - one of PAYMENT_INTENTS
 * @param {string} params.organizationId   - tenant id (from auth/webhook context, NOT from LLM)
 * @param {string} [params.contactId]      - resolved contact id
 * @param {string} [params.interactionId]  - source inbox interaction
 * @param {string} [params.channel]        - 'instagram'|'whatsapp'|'manual'
 * @param {string} [params.orderId]        - explicit order id if already known
 * @param {string} [params.createdBy]      - 'ai'|'agent'|'system'
 * @returns {Promise<ConversationalPaymentResult>}
 */
async function handlePaymentIntent(params) {
  const {
    intentType,
    organizationId,
    contactId,
    interactionId,
    channel = 'manual',
    orderId,
    createdBy = 'ai'
  } = params;

  if (!PAYMENT_INTENTS.has(intentType)) {
    return { action: 'ignore', reason: 'not_payment_intent' };
  }

  // Resolve payable orders for this contact
  const orders = await _resolvePayableOrders(organizationId, contactId, orderId);

  if (intentType === 'payment_status') {
    return _handleStatusQuery(organizationId, orders, contactId);
  }

  if (intentType === 'refund_request') {
    return { action: 'escalate_to_agent', reason: 'refund_requires_human_review' };
  }

  // purchase_intent or payment_request
  if (orders.length === 0) {
    return { action: 'no_payable_order', reason: 'no_confirmed_unpaid_order_found' };
  }

  if (orders.length > 1) {
    return {
      action: 'ambiguous',
      reason: 'multiple_payable_orders',
      orderRefs: orders.map(o => o.displayRef || String(o._id)).slice(0, 3)
    };
  }

  const order = orders[0];
  const totalAmountPaise = Math.round((order.totalAmount || 0) * 100);

  if (!totalAmountPaise || totalAmountPaise < 1) {
    return { action: 'no_amount', reason: 'order_has_no_confirmed_total' };
  }

  // Create or reuse payment
  try {
    const { payment, created } = await paymentService.createOrReuse({
      organizationId,
      orderId: String(order._id),
      amount: totalAmountPaise,
      currency: order.currency || 'INR',
      contactId,
      interactionId,
      channel,
      createdBy,
      description: `Payment for order ${order.displayRef || String(order._id)}`
    });

    return {
      action: 'payment_link_ready',
      payment,
      created,
      order: {
        id: String(order._id),
        ref: order.displayRef || String(order._id),
        totalAmount: order.totalAmount,
        currency: order.currency || 'INR'
      }
    };
  } catch (err) {
    if (err.code === 'NO_INTEGRATION') {
      return { action: 'no_gateway', reason: 'no_payment_gateway_configured' };
    }
    logger.error('[ConversationalPayments] createOrReuse failed', {
      error: err.message,
      organizationId,
      orderId: String(order._id)
    });
    return { action: 'error', reason: err.message };
  }
}

/**
 * Resolve the canonical "pay now" message text for a payment URL.
 * Channel-safe: plain text with just the URL (no markdown, no HTML).
 *
 * @param {object} params
 * @param {string} params.paymentUrl
 * @param {string} params.orderRef
 * @param {number} params.amount      - minor units
 * @param {string} params.currency
 * @returns {string}
 */
function buildPayNowMessage({ paymentUrl, orderRef, amount, currency }) {
  const symbol = currency === 'INR' ? '₹' : currency;
  const formatted = (amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 0 });
  return `Hi! Here is your payment link for order ${orderRef} (${symbol}${formatted}):\n${paymentUrl}\n\nThis link is valid for 24 hours.`;
}

/**
 * Returns whether an intent string is a payment intent.
 * Use this to gate payment flow before calling handlePaymentIntent.
 * @param {string} intent
 * @returns {boolean}
 */
function isPaymentIntent(intent) {
  return PAYMENT_INTENTS.has(intent);
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function _resolvePayableOrders(organizationId, contactId, orderId) {
  const query = {
    organization: organizationId,
    status: { $in: ['confirmed', 'payment_pending', 'pending'] }
  };

  if (orderId) {
    query._id = orderId;
  } else if (contactId) {
    query.contact = contactId;
  } else {
    return [];
  }

  return CommerceOrder.find(query)
    .select('_id displayRef totalAmount currency status contact sourceInteraction channel')
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
}

async function _handleStatusQuery(organizationId, orders, contactId) {
  if (orders.length === 0) {
    return { action: 'no_order_for_status', reason: 'no_open_orders_found' };
  }

  // Look for existing payments for these orders
  const orderIds = orders.map(o => o._id);
  const payments = await Payment.find({
    organization: organizationId,
    order: { $in: orderIds }
  })
    .select('_id order status amount currency paymentUrl shortUrl paidAt expiresAt provider')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  return {
    action: 'payment_status_info',
    orders: orders.map(order => ({
      id: String(order._id),
      ref: order.displayRef || String(order._id),
      orderStatus: order.status,
      totalAmount: order.totalAmount,
      currency: order.currency || 'INR',
      payments: payments.filter(p => String(p.order) === String(order._id)).map(p => ({
        id: String(p._id),
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        paymentUrl: p.shortUrl || p.paymentUrl,
        paidAt: p.paidAt,
        expiresAt: p.expiresAt
      }))
    }))
  };
}

module.exports = {
  handlePaymentIntent,
  buildPayNowMessage,
  isPaymentIntent,
  PAYMENT_INTENTS
};
