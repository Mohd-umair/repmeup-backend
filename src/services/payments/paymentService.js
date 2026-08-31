'use strict';

/**
 * PaymentService
 *
 * Owns all create/reuse/status/cancel/refund operations for Payment records.
 * Calls only PaymentIntegration, Payment, and gateway adapters.
 * Does NOT modify CommerceOrder — that is PaymentFulfilmentService's job.
 *
 * All organizationId values are derived from auth context (req.user.organization),
 * never from client-supplied body fields.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const Payment = require('../../models/Payment');
const PaymentAttempt = require('../../models/PaymentAttempt');
const PaymentIntegration = require('../../models/PaymentIntegration');
const CommerceOrder = require('../../models/CommerceOrder');
const { paymentSecretCipher } = require('../../utils/paymentSecretCipher');
const { decryptFields } = require('../../utils/paymentSecretCipher');
const gatewayRegistry = require('./gatewayRegistry');
const stateMachine = require('./paymentStateMachine');
const logger = require('../../config/logger');

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_EXPIRY_MINUTES = 60 * 24; // 24 hours

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a deterministic idempotency key for a payment request.
 * Same org + order + amount + currency always produces the same key prefix,
 * allowing the duplicate-protection index to fire correctly.
 */
function _buildIdempotencyKey(organizationId, orderId, amount, currency) {
  const base = `${organizationId}-${orderId}-${amount}-${String(currency).toUpperCase()}`;
  return `pay-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 24)}`;
}

/**
 * Resolve and decrypt gateway credentials for an integration.
 * Returns the decrypted credential map.
 * @param {object} integration - Mongoose lean document
 * @returns {object} decrypted credential map
 */
function _resolveCredentials(integration) {
  const envelope = integration.credentialEnvelope || {};
  const raw = typeof envelope.toObject === 'function' ? envelope.toObject() : { ...envelope };
  return decryptFields(raw);
}

/**
 * Select the default active integration for an organization.
 * Falls back to the most recently connected integration if no explicit default.
 * @param {string} organizationId
 * @param {string} [provider]
 * @returns {Promise<object|null>}
 */
async function _resolveIntegration(organizationId, provider) {
  const query = {
    organization: organizationId,
    status: 'connected',
    environment: process.env.NODE_ENV === 'production' ? 'live' : 'test'
  };
  if (provider) query.provider = provider;

  // prefer explicit default
  let integration = await PaymentIntegration.findOne({ ...query, isDefault: true }).lean();
  if (!integration) {
    integration = await PaymentIntegration.findOne(query).sort({ createdAt: -1 }).lean();
  }
  return integration;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new payment request or return the existing active one (idempotent).
 *
 * @param {object} params
 * @param {string} params.organizationId       - from auth context
 * @param {string} params.orderId              - CommerceOrder._id
 * @param {number} params.amount               - minor units
 * @param {string} [params.currency]           - default INR
 * @param {string} [params.provider]           - specific provider; omit to use default
 * @param {string} [params.integrationId]      - specific integration; overrides provider
 * @param {string} [params.contactId]
 * @param {string} [params.interactionId]
 * @param {string} [params.conversation]
 * @param {string} [params.channel]
 * @param {string} [params.description]
 * @param {string} [params.customerName]
 * @param {string} [params.customerPhone]
 * @param {string} [params.customerEmail]
 * @param {Date}   [params.expiresAt]
 * @param {string} [params.createdBy]         - 'agent'|'ai'|'api'|'system'
 * @param {string} [params.agentUserId]
 * @returns {Promise<{ payment: object, created: boolean }>}
 */
async function createOrReuse(params) {
  const {
    organizationId,
    orderId,
    amount,
    currency = 'INR',
    provider,
    integrationId,
    contactId,
    interactionId,
    conversation,
    channel = 'manual',
    description,
    customerName,
    customerPhone,
    customerEmail,
    createdBy = 'agent',
    agentUserId
  } = params;

  const orgId = String(organizationId);
  const normCurrency = String(currency).toUpperCase();

  // Validate order ownership
  const order = await CommerceOrder.findOne({ _id: orderId, organization: orgId }).lean();
  if (!order) {
    throw Object.assign(new Error('Order not found or does not belong to this organization'), { code: 'ORDER_NOT_FOUND' });
  }

  // Validate amount
  if (!Number.isInteger(amount) || amount < 1) {
    throw Object.assign(new Error('amount must be a positive integer (minor units)'), { code: 'INVALID_AMOUNT' });
  }

  // Check for existing active payment
  const idempotencyKey = _buildIdempotencyKey(orgId, orderId, amount, normCurrency);
  const existing = await Payment.findOne({
    organization: orgId,
    order: orderId,
    amount,
    currency: normCurrency,
    status: { $in: ['created', 'pending', 'authorized'] }
  }).lean();

  if (existing) {
    logger.info('[PaymentService] Reusing existing active payment', {
      paymentId: String(existing._id),
      status: existing.status
    });
    return { payment: existing, created: false };
  }

  // Resolve integration
  let integration;
  if (integrationId) {
    integration = await PaymentIntegration.findOne({
      _id: integrationId,
      organization: orgId,
      status: 'connected'
    }).lean();
    if (!integration) {
      throw Object.assign(new Error('Payment integration not found or not connected'), { code: 'INTEGRATION_NOT_FOUND' });
    }
  } else {
    integration = await _resolveIntegration(orgId, provider);
    if (!integration) {
      throw Object.assign(new Error('No active payment gateway integration found for this organization'), { code: 'NO_INTEGRATION' });
    }
  }

  const adapter = gatewayRegistry.getAdapter(integration.provider);
  const credentials = _resolveCredentials(integration);

  const expiresAt = params.expiresAt || new Date(Date.now() + DEFAULT_EXPIRY_MINUTES * 60 * 1000);
  const receipt = idempotencyKey.slice(0, 40);

  // Create provider order
  let orderDTO;
  try {
    orderDTO = await adapter.createOrder({
      organizationId: orgId,
      paymentId: null,
      amount,
      currency: normCurrency,
      receipt,
      description: description || `Order ${order.displayRef || String(order._id)}`,
      notes: { orderId: String(orderId), organizationId: orgId },
      credentials
    });
  } catch (err) {
    logger.error('[PaymentService] createOrder failed', {
      provider: integration.provider,
      error: err.message
    });
    throw Object.assign(
      new Error(`Payment gateway error: ${err.message}`),
      { code: 'GATEWAY_ERROR', cause: err }
    );
  }

  // Create provider payment link
  let linkDTO;
  try {
    linkDTO = await adapter.createPaymentLink({
      organizationId: orgId,
      paymentId: null,
      providerOrderId: orderDTO.providerOrderId,
      amount,
      currency: normCurrency,
      description: description || `Order ${order.displayRef || String(order._id)}`,
      customerName,
      customerPhone,
      customerEmail,
      expiresAt,
      callbackUrl: `${process.env.BACKEND_URL || ''}/api/payments/callback/${integration.provider}`,
      credentials
    });
  } catch (err) {
    logger.error('[PaymentService] createPaymentLink failed', {
      provider: integration.provider,
      error: err.message
    });
    throw Object.assign(
      new Error(`Payment link creation failed: ${err.message}`),
      { code: 'GATEWAY_ERROR', cause: err }
    );
  }

  // Persist Payment record
  let payment;
  try {
    payment = await Payment.create({
      organization: orgId,
      contact: contactId || order.contact || null,
      interaction: interactionId || order.sourceInteraction || null,
      conversation: conversation || null,
      channel,
      order: orderId,
      integration: integration._id,
      provider: integration.provider,
      status: 'created',
      amount,
      currency: normCurrency,
      idempotencyKey,
      providerOrderId: orderDTO.providerOrderId,
      paymentUrl: linkDTO.paymentUrl,
      shortUrl: linkDTO.shortUrl || null,
      expiresAt: linkDTO.expiresAt || expiresAt,
      description,
      createdBy,
      agentUser: agentUserId || null,
      providerMeta: { orderRaw: orderDTO.raw, linkRaw: linkDTO.raw }
    });
  } catch (err) {
    if (err.code === 11000) {
      // Concurrent duplicate — reload winner
      logger.info('[PaymentService] Concurrent duplicate payment — reloading winner');
      const winner = await Payment.findOne({
        organization: orgId,
        order: orderId,
        amount,
        currency: normCurrency,
        status: { $in: ['created', 'pending', 'authorized'] }
      }).lean();
      if (winner) return { payment: winner, created: false };
    }
    throw err;
  }

  logger.info('[PaymentService] Payment created', {
    paymentId: String(payment._id),
    provider: integration.provider,
    orderId,
    amount,
    currency: normCurrency
  });

  return { payment: payment.toObject(), created: true };
}

/**
 * Get current status for a payment from the provider (reconciliation / manual poll).
 * Updates the Payment record if status has changed.
 *
 * @param {string} organizationId
 * @param {string} paymentId       - Payment._id
 * @returns {Promise<object>} updated Payment lean doc
 */
async function reconcileStatus(organizationId, paymentId) {
  const payment = await Payment.findOne({
    _id: paymentId,
    organization: organizationId
  }).lean();
  if (!payment) throw Object.assign(new Error('Payment not found'), { code: 'PAYMENT_NOT_FOUND' });

  if (stateMachine.isTerminal(payment.status)) {
    return payment;
  }

  const integration = await PaymentIntegration.findOne({
    _id: payment.integration,
    organization: organizationId
  }).lean();
  if (!integration) throw Object.assign(new Error('Integration not found'), { code: 'INTEGRATION_NOT_FOUND' });

  const adapter = gatewayRegistry.getAdapter(payment.provider);
  const credentials = _resolveCredentials(integration);

  let statusDTO;
  try {
    statusDTO = await adapter.getPaymentStatus({
      providerOrderId: payment.providerOrderId,
      providerPaymentId: payment.providerPaymentId,
      credentials
    });
  } catch (err) {
    logger.error('[PaymentService] status poll failed', { paymentId, error: err.message });
    throw Object.assign(new Error(`Status check failed: ${err.message}`), { code: 'GATEWAY_ERROR' });
  }

  if (statusDTO.normalizedStatus !== payment.status && stateMachine.canTransition(payment.status, statusDTO.normalizedStatus)) {
    const tsField = stateMachine.timestampFieldFor(statusDTO.normalizedStatus);
    const update = {
      $set: {
        status: statusDTO.normalizedStatus,
        ...(statusDTO.providerPaymentId ? { providerPaymentId: statusDTO.providerPaymentId } : {}),
        ...(tsField ? { [tsField]: new Date() } : {})
      }
    };
    const updated = await Payment.findOneAndUpdate(
      { _id: paymentId, organization: organizationId, status: payment.status },
      update,
      { new: true }
    ).lean();
    if (updated) {
      logger.info('[PaymentService] Payment status reconciled', {
        paymentId,
        from: payment.status,
        to: statusDTO.normalizedStatus
      });
      return updated;
    }
  }

  return payment;
}

/**
 * Cancel an active payment request.
 * @param {string} organizationId
 * @param {string} paymentId
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
async function cancel(organizationId, paymentId, reason) {
  const payment = await Payment.findOne({ _id: paymentId, organization: organizationId }).lean();
  if (!payment) throw Object.assign(new Error('Payment not found'), { code: 'PAYMENT_NOT_FOUND' });

  stateMachine.assertTransition(payment.status, 'cancelled');

  const updated = await Payment.findOneAndUpdate(
    { _id: paymentId, organization: organizationId, status: payment.status },
    { $set: { status: 'cancelled', cancelledAt: new Date(), internalNote: reason || null } },
    { new: true }
  ).lean();

  logger.info('[PaymentService] Payment cancelled', { paymentId, organizationId });
  return updated;
}

/**
 * Initiate a (partial or full) refund.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.paymentId
 * @param {number} params.amount           - minor units
 * @param {string} [params.reason]
 * @param {string} [params.notes]
 * @param {string} [params.agentUserId]
 * @returns {Promise<{ refund: object, payment: object }>}
 */
async function requestRefund(params) {
  const { organizationId, paymentId, amount, reason = 'customer_request', notes, agentUserId } = params;

  const payment = await Payment.findOne({ _id: paymentId, organization: organizationId }).lean();
  if (!payment) throw Object.assign(new Error('Payment not found'), { code: 'PAYMENT_NOT_FOUND' });

  if (!stateMachine.isRefundable(payment.status)) {
    throw Object.assign(
      new Error(`Payment status "${payment.status}" does not allow refunds`),
      { code: 'INVALID_STATUS' }
    );
  }

  const refundable = payment.amount - (payment.refundedAmount || 0);
  if (amount > refundable) {
    throw Object.assign(
      new Error(`Refund amount (${amount}) exceeds refundable balance (${refundable})`),
      { code: 'REFUND_EXCEEDS_BALANCE' }
    );
  }

  const integration = await PaymentIntegration.findOne({
    _id: payment.integration,
    organization: organizationId
  }).lean();
  if (!integration) throw Object.assign(new Error('Integration not found'), { code: 'INTEGRATION_NOT_FOUND' });

  const adapter = gatewayRegistry.getAdapter(payment.provider);
  const credentials = _resolveCredentials(integration);

  const idempotencyKey = `rfnd-${String(payment._id)}-${amount}-${Date.now()}`;

  let refundDTO;
  try {
    refundDTO = await adapter.createRefund({
      providerPaymentId: payment.providerPaymentId,
      amount,
      reason,
      idempotencyKey,
      credentials
    });
  } catch (err) {
    logger.error('[PaymentService] createRefund failed', { paymentId, error: err.message });
    throw Object.assign(new Error(`Refund failed: ${err.message}`), { code: 'GATEWAY_ERROR' });
  }

  const Refund = require('../../models/Refund');
  const refundDoc = await Refund.create({
    organization: organizationId,
    payment: paymentId,
    amount,
    currency: payment.currency,
    providerRefundId: refundDTO.providerRefundId,
    providerIdempotencyKey: idempotencyKey,
    status: refundDTO.status || 'pending',
    reason,
    notes,
    initiatedBy: 'agent',
    agentUser: agentUserId || null,
    completedAt: refundDTO.status === 'completed' ? new Date() : null
  });

  const newRefundedAmount = (payment.refundedAmount || 0) + amount;
  const isFullRefund = newRefundedAmount >= payment.amount;
  const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';

  const updatedPayment = await Payment.findOneAndUpdate(
    { _id: paymentId, organization: organizationId },
    {
      $set: {
        refundedAmount: newRefundedAmount,
        status: newStatus
      }
    },
    { new: true }
  ).lean();

  logger.info('[PaymentService] Refund initiated', {
    paymentId,
    refundId: String(refundDoc._id),
    amount,
    newStatus
  });

  return { refund: refundDoc.toObject(), payment: updatedPayment };
}

/**
 * List payments for an organization with optional filters.
 * @param {string} organizationId
 * @param {object} [filters]
 * @param {object} [pagination]
 * @returns {Promise<{ payments: object[], total: number }>}
 */
async function list(organizationId, filters = {}, pagination = {}) {
  const query = { organization: organizationId };

  if (filters.status) query.status = Array.isArray(filters.status) ? { $in: filters.status } : filters.status;
  if (filters.orderId) query.order = filters.orderId;
  if (filters.contactId) query.contact = filters.contactId;
  if (filters.provider) query.provider = filters.provider;
  if (filters.from || filters.to) {
    query.createdAt = {};
    if (filters.from) query.createdAt.$gte = new Date(filters.from);
    if (filters.to) query.createdAt.$lte = new Date(filters.to);
  }

  const page = Math.max(1, parseInt(pagination.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(pagination.limit) || 20));
  const skip = (page - 1) * limit;

  const [payments, total] = await Promise.all([
    Payment.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-providerMeta -providerSignature')
      .lean(),
    Payment.countDocuments(query)
  ]);

  return { payments, total, page, limit };
}

/**
 * Get a single payment by ID.
 * @param {string} organizationId
 * @param {string} paymentId
 * @returns {Promise<object>}
 */
async function getById(organizationId, paymentId) {
  const payment = await Payment.findOne({ _id: paymentId, organization: organizationId })
    .select('-providerMeta -providerSignature')
    .lean();
  if (!payment) throw Object.assign(new Error('Payment not found'), { code: 'PAYMENT_NOT_FOUND' });
  return payment;
}

module.exports = {
  createOrReuse,
  reconcileStatus,
  cancel,
  requestRefund,
  list,
  getById
};
