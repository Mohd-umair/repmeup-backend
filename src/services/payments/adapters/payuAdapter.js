'use strict';

/**
 * PayU Gateway Adapter — APPROVAL GATE ACTIVE
 *
 * From the plan (Phase 7):
 *   "PayU: do not implement delegated merchant access until PayU confirms whether
 *   RepMeUp receives partner-level authority scoped by MID or must store merchant
 *   key/salt; payment and onboarding webhooks use different signature schemes."
 *
 * Implementation checklist (complete before enabling):
 *   [ ] Receive PayU partner written confirmation for delegated merchant access model
 *   [ ] Confirm whether RepMeUp gets partner-level MID scoping or per-merchant key/salt
 *   [ ] Clarify payment vs onboarding webhook signature scheme difference
 *   [ ] Integration test: hash generation → payment form → webhook → status
 *   [ ] Enable by: require('./adapters/payuAdapter') in gatewayRegistry.js
 */

const crypto = require('crypto');
const logger = require('../../../config/logger');

const APPROVAL_GATE_ERROR =
  'PayUAdapter: merchant access model is unconfirmed with PayU. ' +
  'This adapter is not yet registered. See Phase 7 gate in the payments implementation plan.';

function _assertApproval() {
  if (process.env.PAYU_PARTNER_APPROVAL !== 'confirmed') {
    throw new Error(APPROVAL_GATE_ERROR);
  }
}

async function createOrder(params) {
  _assertApproval();
  throw new Error('PayUAdapter.createOrder: pending partner approval');
}

async function createPaymentLink(params) {
  _assertApproval();
  throw new Error('PayUAdapter.createPaymentLink: pending partner approval');
}

async function getPaymentStatus(params) {
  _assertApproval();
  throw new Error('PayUAdapter.getPaymentStatus: pending partner approval');
}

async function createRefund(params) {
  _assertApproval();
  throw new Error('PayUAdapter.createRefund: pending partner approval');
}

/**
 * PayU webhook signature (payment webhook):
 * sha512(key|txnid|amount|productinfo|firstname|email|udf1...|SALT)
 */
function verifyWebhookSignature({ rawBody, headers, credentials }) {
  const { merchantSalt } = credentials || {};
  if (!merchantSalt) return false;
  // Parse form-encoded body
  let params = {};
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    params = Object.fromEntries(new URLSearchParams(body));
  } catch {
    return false;
  }
  const hash = params.hash;
  if (!hash) return false;
  const reverseHashStr = [
    merchantSalt,
    params.udf10 || '', params.udf9 || '', params.udf8 || '', params.udf7 || '',
    params.udf6 || '', params.udf5 || '', params.udf4 || '', params.udf3 || '',
    params.udf2 || '', params.udf1 || '',
    params.email || '', params.firstname || '', params.productinfo || '',
    params.amount || '', params.txnid || '', params.key || ''
  ].join('|');
  const expected = crypto.createHash('sha512').update(reverseHashStr).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
  } catch {
    return false;
  }
}

function mapWebhookEvent(rawEvent, eventType) {
  return {
    normalizedEvent: eventType === 'success' ? 'payment.paid' : 'payment.failed',
    providerEventId: rawEvent?.txnid || crypto.randomBytes(16).toString('hex'),
    providerEventType: eventType,
    providerPaymentId: rawEvent?.mihpayid || null,
    providerOrderId: rawEvent?.txnid || null,
    amount: rawEvent?.amount ? Math.round(parseFloat(rawEvent.amount) * 100) : null,
    currency: 'INR',
    safePayload: { txnid: rawEvent?.txnid, status: rawEvent?.status }
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
    { key: 'merchantKey', label: 'Merchant Key', secret: false },
    { key: 'merchantSalt', label: 'Merchant Salt', secret: true }
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
