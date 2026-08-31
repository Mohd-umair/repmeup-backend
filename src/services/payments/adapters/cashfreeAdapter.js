'use strict';

/**
 * Cashfree Gateway Adapter — APPROVAL GATE ACTIVE
 *
 * This adapter is available for implementation but will not be registered in
 * gatewayRegistry.js until Cashfree partner written approval is confirmed.
 *
 * From the plan (Phase 7):
 *   "Cashfree: preferred next provider because official embedded-partner OAuth /
 *   platform authentication is documented; use payment sessions/links and
 *   timestamp-plus-raw-body webhook verification."
 *
 * Implementation checklist (complete before enabling):
 *   [ ] Receive Cashfree embedded-partner OAuth approval in writing
 *   [ ] Verify merchant credential delegation flow (platform authentication)
 *   [ ] Confirm webhook ownership model (who registers, who verifies)
 *   [ ] Integration test: create session → payment link → webhook → refund
 *   [ ] Enable by: require('./adapters/cashfreeAdapter') in gatewayRegistry.js
 */

const crypto = require('crypto');
const logger = require('../../../config/logger');

const APPROVAL_GATE_ERROR =
  'CashfreeAdapter: live merchant onboarding requires written Cashfree partner approval. ' +
  'This adapter is not yet registered. See Phase 7 gate in the payments implementation plan.';

function _assertApproval() {
  if (process.env.CASHFREE_PARTNER_APPROVAL !== 'confirmed') {
    throw new Error(APPROVAL_GATE_ERROR);
  }
}

function _buildClient(credentials) {
  if (!credentials?.appId || !credentials?.secretKey) {
    throw new Error('Cashfree credentials missing appId or secretKey');
  }
  return { appId: credentials.appId, secretKey: credentials.secretKey };
}

async function createOrder({ organizationId, paymentId, amount, currency, receipt, description, credentials }) {
  _assertApproval();
  const { appId, secretKey } = _buildClient(credentials);
  const axios = require('axios');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(`${timestamp}${appId}`)
    .digest('base64');

  try {
    const resp = await axios.post(
      'https://sandbox.cashfree.com/pg/orders',
      {
        order_id: receipt,
        order_amount: (amount / 100).toFixed(2),
        order_currency: String(currency).toUpperCase(),
        order_note: description || ''
      },
      {
        headers: {
          'x-api-version': '2022-09-01',
          'x-client-id': appId,
          'x-client-secret': secretKey
        },
        timeout: 15000
      }
    );
    logger.info('[CashfreeAdapter] Order created', { cfOrderId: resp.data.order_id });
    return {
      providerOrderId: resp.data.order_id,
      amount,
      currency,
      receipt,
      status: resp.data.order_status,
      raw: { id: resp.data.order_id, status: resp.data.order_status }
    };
  } catch (err) {
    throw new Error(`Cashfree createOrder: ${err?.response?.data?.message || err.message}`);
  }
}

async function createPaymentLink({ providerOrderId, amount, currency, description, customerPhone, customerEmail, expiresAt, credentials }) {
  _assertApproval();
  // Payment session / link creation using Cashfree payment sessions API
  // Implementation pending partner approval
  throw new Error('CashfreeAdapter.createPaymentLink: pending partner approval');
}

async function getPaymentStatus({ providerOrderId, credentials }) {
  _assertApproval();
  throw new Error('CashfreeAdapter.getPaymentStatus: pending partner approval');
}

async function createRefund({ providerPaymentId, amount, reason, idempotencyKey, credentials }) {
  _assertApproval();
  throw new Error('CashfreeAdapter.createRefund: pending partner approval');
}

/**
 * Cashfree webhook signature:
 * timestamp = X-Cashfree-Timestamp header
 * signature = base64(HMAC-SHA256(timestamp + rawBody, secretKey))
 * Compare to X-Cashfree-Signature header
 */
function verifyWebhookSignature({ rawBody, headers, credentials }) {
  const webhookSecret = credentials?.secretKey;
  if (!webhookSecret) return false;
  const timestamp = headers['x-cashfree-timestamp'];
  const signature = headers['x-cashfree-signature'];
  if (!timestamp || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${timestamp}${body}`)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function mapWebhookEvent(rawEvent, eventType) {
  const providerEventId =
    rawEvent?.data?.order?.order_id ||
    crypto.createHash('sha256').update(JSON.stringify(rawEvent)).digest('hex').slice(0, 32);
  return {
    normalizedEvent: _mapEventType(eventType),
    providerEventId,
    providerEventType: eventType,
    providerPaymentId: rawEvent?.data?.payment?.cf_payment_id || null,
    providerOrderId: rawEvent?.data?.order?.order_id || null,
    amount: rawEvent?.data?.payment?.payment_amount ? Math.round(rawEvent.data.payment.payment_amount * 100) : null,
    currency: rawEvent?.data?.payment?.payment_currency || null,
    errorCode: rawEvent?.data?.payment?.payment_message || null,
    safePayload: {
      eventType,
      orderId: rawEvent?.data?.order?.order_id || null,
      paymentId: rawEvent?.data?.payment?.cf_payment_id || null,
      status: rawEvent?.data?.payment?.payment_status || null
    }
  };
}

function _mapEventType(eventType) {
  const map = {
    'PAYMENT_SUCCESS_WEBHOOK': 'payment.paid',
    'PAYMENT_FAILED_WEBHOOK': 'payment.failed',
    'REFUND_STATUS_WEBHOOK': 'refund.processed'
  };
  return map[eventType] || `unknown.${eventType}`;
}

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

function getCredentialSchema() {
  return [
    { key: 'appId', label: 'App ID', secret: false, hint: 'From Cashfree dashboard' },
    { key: 'secretKey', label: 'Secret Key', secret: true, hint: 'Keep this confidential' },
    { key: 'webhookSecret', label: 'Webhook Secret', secret: true, hint: 'Set in your Cashfree dashboard' }
  ];
}

module.exports = {
  createOrder,
  createPaymentLink,
  getPaymentStatus,
  createRefund,
  verifyWebhookSignature,
  mapWebhookEvent,
  getCapabilities,
  getCredentialSchema,
  APPROVAL_GATE_ERROR
};
