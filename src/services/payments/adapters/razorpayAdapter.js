'use strict';

/**
 * Razorpay Gateway Adapter
 *
 * Implements the PaymentGateway contract for Razorpay.
 *
 * This adapter supports:
 *   - Orders API (creates a Razorpay order for tracking)
 *   - Payment Links API (generates a hosted checkout URL to send customers)
 *   - Webhook HMAC-SHA256 signature verification
 *   - Payment status lookup
 *   - Partial and full refunds
 *
 * ── Sandbox / live gate ────────────────────────────────────────────────────────
 * The adapter itself is environment-agnostic: it uses whatever key_id/key_secret
 * is passed in `credentials`. The caller (PaymentService / integration) determines
 * which environment credentials to use.
 *
 * Live merchant onboarding (collecting real merchant keys) is DISABLED until
 * Razorpay Technology Partner approval is confirmed. The PaymentIntegration API
 * enforces this gate via the PAYMENTS_LIVE_MERCHANT_ONBOARDING feature flag.
 */

const crypto = require('crypto');
const logger = require('../../../config/logger');

// ── Razorpay SDK ──────────────────────────────────────────────────────────────

function _buildClient(credentials) {
  const Razorpay = require('razorpay');
  if (!credentials?.keyId || !credentials?.keySecret) {
    throw new Error('Razorpay credentials missing keyId or keySecret');
  }
  return new Razorpay({ key_id: credentials.keyId, key_secret: credentials.keySecret });
}

// ── Create Order ──────────────────────────────────────────────────────────────

/**
 * @param {import('../gatewayContract').CreateOrderParams} params
 * @returns {Promise<import('../gatewayContract').OrderDTO>}
 */
async function createOrder({ organizationId, paymentId, amount, currency, receipt, description, notes, credentials }) {
  const client = _buildClient(credentials);

  const orderData = {
    amount,
    currency: String(currency).toUpperCase(),
    receipt: (receipt || `pay-${Date.now()}`).slice(0, 40),
    notes: {
      ...(notes || {}),
      description: (description || '').slice(0, 100)
    }
  };

  try {
    const order = await client.orders.create(orderData);
    logger.info('[RazorpayAdapter] Order created', { rzpOrderId: order.id, amount });
    return {
      providerOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      raw: _safeOrderMeta(order)
    };
  } catch (err) {
    logger.error('[RazorpayAdapter] createOrder failed', { error: err.message, code: err?.error?.code });
    throw new Error(`Razorpay createOrder: ${err?.error?.description || err.message}`);
  }
}

// ── Create Payment Link ───────────────────────────────────────────────────────

/**
 * @param {import('../gatewayContract').CreateLinkParams} params
 * @returns {Promise<import('../gatewayContract').PaymentLinkDTO>}
 */
async function createPaymentLink({
  organizationId,
  paymentId,
  providerOrderId,
  amount,
  currency,
  description,
  customerPhone,
  customerEmail,
  customerName,
  expiresAt,
  callbackUrl,
  credentials
}) {
  const client = _buildClient(credentials);

  const linkData = {
    amount,
    currency: String(currency).toUpperCase(),
    accept_partial: false,
    description: (description || 'Payment').slice(0, 255),
    notify: {
      sms: !!customerPhone,
      email: !!customerEmail
    },
    reminder_enable: false,
    ...(providerOrderId ? { order_id: providerOrderId } : {}),
    ...(expiresAt ? { expire_by: Math.floor(new Date(expiresAt).getTime() / 1000) } : {}),
    ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {})
  };

  if (customerPhone || customerEmail || customerName) {
    linkData.customer = {
      ...(customerName ? { name: customerName } : {}),
      ...(customerEmail ? { email: customerEmail } : {}),
      ...(customerPhone ? { contact: customerPhone } : {})
    };
  }

  try {
    const link = await client.paymentLink.create(linkData);
    logger.info('[RazorpayAdapter] Payment link created', { linkId: link.id });
    return {
      paymentUrl: link.short_url || link.link_url,
      shortUrl: link.short_url,
      linkId: link.id,
      expiresAt: link.expire_by ? new Date(link.expire_by * 1000) : null,
      raw: { id: link.id, status: link.status }
    };
  } catch (err) {
    logger.error('[RazorpayAdapter] createPaymentLink failed', { error: err.message });
    throw new Error(`Razorpay createPaymentLink: ${err?.error?.description || err.message}`);
  }
}

// ── Get Payment Status ────────────────────────────────────────────────────────

/**
 * @param {import('../gatewayContract').StatusParams} params
 * @returns {Promise<import('../gatewayContract').StatusDTO>}
 */
async function getPaymentStatus({ providerOrderId, providerPaymentId, credentials }) {
  const client = _buildClient(credentials);

  // If we have a payment ID, check it directly
  if (providerPaymentId) {
    try {
      const p = await client.payments.fetch(providerPaymentId);
      return {
        normalizedStatus: _mapPaymentStatus(p.status),
        providerPaymentId: p.id,
        capturedAmount: p.amount_refunded ? p.amount - p.amount_refunded : p.amount,
        paymentMethod: p.method,
        raw: { id: p.id, status: p.status, method: p.method }
      };
    } catch (err) {
      logger.warn('[RazorpayAdapter] payments.fetch failed', { providerPaymentId, error: err.message });
    }
  }

  // Fall back to order payments list
  if (providerOrderId) {
    try {
      const { items } = await client.orders.fetchPayments(providerOrderId);
      const captured = (items || []).find(p => p.status === 'captured');
      const latest = captured || (items || [])[0];
      if (latest) {
        return {
          normalizedStatus: _mapPaymentStatus(latest.status),
          providerPaymentId: latest.id,
          capturedAmount: latest.amount,
          paymentMethod: latest.method,
          raw: { id: latest.id, status: latest.status }
        };
      }
    } catch (err) {
      logger.warn('[RazorpayAdapter] orders.fetchPayments failed', { providerOrderId, error: err.message });
    }
  }

  return { normalizedStatus: 'pending' };
}

// ── Create Refund ─────────────────────────────────────────────────────────────

/**
 * @param {import('../gatewayContract').RefundParams} params
 * @returns {Promise<import('../gatewayContract').RefundDTO>}
 */
async function createRefund({ providerPaymentId, amount, reason, idempotencyKey, credentials }) {
  if (!providerPaymentId) {
    throw new Error('Razorpay createRefund: providerPaymentId is required');
  }
  const client = _buildClient(credentials);
  try {
    const refund = await client.payments.refund(providerPaymentId, {
      amount,
      notes: { reason: reason || 'customer_request', idempotency: idempotencyKey }
    });
    logger.info('[RazorpayAdapter] Refund created', { refundId: refund.id, amount });
    return {
      providerRefundId: refund.id,
      amount: refund.amount,
      status: _mapRefundStatus(refund.status),
      raw: { id: refund.id, status: refund.status }
    };
  } catch (err) {
    logger.error('[RazorpayAdapter] createRefund failed', { error: err.message });
    throw new Error(`Razorpay createRefund: ${err?.error?.description || err.message}`);
  }
}

// ── Webhook Signature Verification ───────────────────────────────────────────

/**
 * @param {import('../gatewayContract').WebhookVerifyParams} params
 * @returns {boolean}
 */
function verifyWebhookSignature({ rawBody, headers, credentials }) {
  const webhookSecret = credentials?.webhookSecret;
  if (!webhookSecret) {
    logger.warn('[RazorpayAdapter] webhookSecret not configured — signature verification skipped');
    return process.env.NODE_ENV !== 'production';
  }

  const signature = headers['x-razorpay-signature'];
  if (!signature) {
    logger.warn('[RazorpayAdapter] Missing x-razorpay-signature header');
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
  const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ── Map Webhook Event ─────────────────────────────────────────────────────────

/**
 * @param {object} rawEvent  - parsed JSON body of the webhook
 * @param {string} eventType - from rawEvent.event
 * @returns {import('../gatewayContract').MappedEventDTO}
 */
function mapWebhookEvent(rawEvent, eventType) {
  const entity = rawEvent?.payload?.payment?.entity || rawEvent?.payload?.payment_link?.entity || {};
  const refundEntity = rawEvent?.payload?.refund?.entity || {};
  const linkEntity = rawEvent?.payload?.payment_link?.entity || {};

  const providerEventId =
    rawEvent.id ||
    crypto.createHash('sha256').update(JSON.stringify(rawEvent)).digest('hex').slice(0, 32);

  const normalizedEvent = _mapEventType(eventType);

  const safePayload = {
    eventType,
    orderId: entity.order_id || null,
    paymentId: entity.id || null,
    amount: entity.amount || null,
    currency: entity.currency || null,
    status: entity.status || null,
    method: entity.method || null,
    refundId: refundEntity.id || null,
    linkId: linkEntity.id || null,
    linkStatus: linkEntity.status || null
  };

  return {
    normalizedEvent,
    providerEventId,
    providerEventType: eventType,
    providerPaymentId: entity.id || null,
    providerOrderId: entity.order_id || linkEntity.order_id || null,
    amount: entity.amount || null,
    currency: entity.currency || null,
    errorCode: entity.error_code || null,
    errorDescription: entity.error_description || null,
    safePayload
  };
}

// ── Capabilities ──────────────────────────────────────────────────────────────

/**
 * @returns {import('../gatewayContract').CapabilitiesDTO}
 */
function getCapabilities() {
  return {
    hostedCheckout: true,
    paymentLinks: true,
    webhooks: true,
    refunds: true,
    partialRefunds: true,
    statusPolling: true
  };
}

// ── Credential Schema ─────────────────────────────────────────────────────────

/**
 * @returns {import('../gatewayContract').CredentialSchemaDTO[]}
 */
function getCredentialSchema() {
  return [
    { key: 'keyId', label: 'Key ID', secret: false, hint: 'Starts with rzp_test_ or rzp_live_' },
    { key: 'keySecret', label: 'Key Secret', secret: true, hint: 'Keep this confidential' },
    { key: 'webhookSecret', label: 'Webhook Secret', secret: true, hint: 'Set this in your Razorpay dashboard' }
  ];
}

// ── Private mappers ───────────────────────────────────────────────────────────

function _mapPaymentStatus(rzpStatus) {
  const map = {
    created: 'created',
    authorized: 'authorized',
    captured: 'paid',
    refunded: 'refunded',
    failed: 'failed'
  };
  return map[rzpStatus] || 'pending';
}

function _mapRefundStatus(rzpStatus) {
  const map = {
    pending: 'pending',
    processed: 'completed',
    failed: 'failed'
  };
  return map[rzpStatus] || 'pending';
}

function _mapEventType(eventType) {
  const map = {
    'payment.authorized': 'payment.authorized',
    'payment.captured': 'payment.paid',
    'payment.failed': 'payment.failed',
    'refund.processed': 'refund.processed',
    'refund.failed': 'refund.failed',
    'payment_link.paid': 'payment.paid',
    'payment_link.cancelled': 'payment.cancelled',
    'payment_link.expired': 'payment.expired'
  };
  return map[eventType] || `unknown.${eventType}`;
}

function _safeOrderMeta(order) {
  return {
    id: order.id,
    status: order.status,
    receipt: order.receipt,
    amount: order.amount,
    currency: order.currency
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  createOrder,
  createPaymentLink,
  getPaymentStatus,
  createRefund,
  verifyWebhookSignature,
  mapWebhookEvent,
  getCapabilities,
  getCredentialSchema
};
