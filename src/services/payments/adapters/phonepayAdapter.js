'use strict';

/**
 * PhonePe Gateway Adapter — APPROVAL GATE ACTIVE
 *
 * From the plan (Phase 7):
 *   "PhonePe: do not implement platform onboarding until PhonePe confirms partner
 *   eligibility, merchant credential delegation, webhook ownership, and Payment Link
 *   approval. Standard client credentials are not merchant-consent OAuth."
 *
 * Implementation checklist (complete before enabling):
 *   [ ] PhonePe confirms partner eligibility and platform API access
 *   [ ] Confirm merchant credential delegation model (not standard client credentials)
 *   [ ] Confirm webhook ownership: who registers the URL, which secret is used
 *   [ ] Payment Link API approval from PhonePe
 *   [ ] Integration test: initiate payment → redirect → S2S callback → refund
 *   [ ] Enable by: require('./adapters/phonepayAdapter') in gatewayRegistry.js
 */

const crypto = require('crypto');
const logger = require('../../../config/logger');

const APPROVAL_GATE_ERROR =
  'PhonePeAdapter: partner eligibility and merchant credential delegation not yet confirmed with PhonePe. ' +
  'This adapter is not yet registered. See Phase 7 gate in the payments implementation plan.';

function _assertApproval() {
  if (process.env.PHONEPE_PARTNER_APPROVAL !== 'confirmed') {
    throw new Error(APPROVAL_GATE_ERROR);
  }
}

async function createOrder(params) {
  _assertApproval();
  throw new Error('PhonePeAdapter.createOrder: pending partner approval');
}

async function createPaymentLink(params) {
  _assertApproval();
  throw new Error('PhonePeAdapter.createPaymentLink: pending partner approval');
}

async function getPaymentStatus(params) {
  _assertApproval();
  throw new Error('PhonePeAdapter.getPaymentStatus: pending partner approval');
}

async function createRefund(params) {
  _assertApproval();
  throw new Error('PhonePeAdapter.createRefund: pending partner approval');
}

/**
 * PhonePe S2S callback verification:
 * x-verify = sha256(base64Payload + apiEndpoint + saltKey) + "###" + saltIndex
 */
function verifyWebhookSignature({ rawBody, headers, credentials }) {
  const { saltKey, saltIndex } = credentials || {};
  if (!saltKey) return false;
  const xVerify = headers['x-verify'] || '';
  const [receivedHash] = xVerify.split('###');
  if (!receivedHash) return false;
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    const parsed = JSON.parse(body);
    const base64Payload = parsed?.response || '';
    const endpointPath = '/pg/v1/status';
    const toHash = `${base64Payload}${endpointPath}${saltKey}`;
    const expected = crypto.createHash('sha256').update(toHash).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expected));
  } catch {
    return false;
  }
}

function mapWebhookEvent(rawEvent, eventType) {
  const code = rawEvent?.code || eventType || 'UNKNOWN';
  let normalized = 'payment.failed';
  if (code === 'PAYMENT_SUCCESS') normalized = 'payment.paid';
  else if (code === 'PAYMENT_PENDING') normalized = 'payment.pending';

  return {
    normalizedEvent: normalized,
    providerEventId: rawEvent?.transactionId || crypto.randomBytes(16).toString('hex'),
    providerEventType: code,
    providerPaymentId: rawEvent?.transactionId || null,
    providerOrderId: rawEvent?.merchantTransactionId || null,
    amount: rawEvent?.amount || null,
    currency: 'INR',
    safePayload: { code, merchantTransactionId: rawEvent?.merchantTransactionId }
  };
}

function getCapabilities() {
  return {
    hostedCheckout: true,
    paymentLinks: false,
    webhooks: true,
    refunds: true,
    partialRefunds: false,
    statusPolling: true
  };
}

function getCredentialSchema() {
  return [
    { key: 'merchantId', label: 'Merchant ID', secret: false },
    { key: 'saltKey', label: 'Salt Key', secret: true },
    { key: 'saltIndex', label: 'Salt Index', secret: false, hint: 'Usually 1' }
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
