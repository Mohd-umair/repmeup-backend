'use strict';

/**
 * Gateway Contract
 *
 * Formal interface that every payment gateway adapter must implement.
 * Importing this module gives you the DTO type definitions and the
 * `assertAdapterShape` function to validate adapters at registration time.
 *
 * All adapter methods return plain objects (DTOs) — never Mongoose documents.
 * All amounts are in minor units (paise, cents, etc.).
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ Adapter interface                                                       │
 * │                                                                         │
 * │  createOrder(params: CreateOrderParams) → OrderDTO                      │
 * │  createPaymentLink(params: CreateLinkParams) → PaymentLinkDTO           │
 * │  getPaymentStatus(params: StatusParams) → StatusDTO                     │
 * │  createRefund(params: RefundParams) → RefundDTO                         │
 * │  verifyWebhookSignature(params: WebhookVerifyParams) → boolean          │
 * │  mapWebhookEvent(rawEvent: object, eventType: string) → MappedEventDTO  │
 * │  getCapabilities() → CapabilitiesDTO                                    │
 * │  getCredentialSchema() → CredentialSchemaDTO[]                          │
 * └────────────────────────────────────────────────────────────────────────┘
 */

/**
 * @typedef {Object} CreateOrderParams
 * @property {string}  organizationId
 * @property {string}  paymentId          - Payment._id string
 * @property {number}  amount             - minor units
 * @property {string}  currency           - ISO 4217 (e.g. 'INR')
 * @property {string}  receipt            - short idempotency key / order ref
 * @property {string}  description
 * @property {object}  [notes]            - non-sensitive key/value metadata
 * @property {object}  credentials        - decrypted gateway credentials
 */

/**
 * @typedef {Object} OrderDTO
 * @property {string}  providerOrderId
 * @property {number}  amount
 * @property {string}  currency
 * @property {string}  [receipt]
 * @property {string}  [status]
 * @property {object}  [raw]              - non-sensitive subset of provider response
 */

/**
 * @typedef {Object} CreateLinkParams
 * @property {string}  organizationId
 * @property {string}  paymentId
 * @property {string}  providerOrderId    - from createOrder
 * @property {number}  amount
 * @property {string}  currency
 * @property {string}  description
 * @property {string}  [customerPhone]
 * @property {string}  [customerEmail]
 * @property {string}  [customerName]
 * @property {Date}    [expiresAt]
 * @property {string}  callbackUrl
 * @property {object}  credentials
 */

/**
 * @typedef {Object} PaymentLinkDTO
 * @property {string}  paymentUrl         - URL to send to customer
 * @property {string}  [shortUrl]
 * @property {string}  [linkId]           - provider's payment link ID
 * @property {Date}    [expiresAt]
 * @property {object}  [raw]
 */

/**
 * @typedef {Object} StatusParams
 * @property {string}  providerOrderId
 * @property {string}  [providerPaymentId]
 * @property {object}  credentials
 */

/**
 * @typedef {Object} StatusDTO
 * @property {string}  normalizedStatus   - one of PAYMENT_STATUSES
 * @property {string}  [providerPaymentId]
 * @property {number}  [capturedAmount]   - minor units
 * @property {string}  [paymentMethod]
 * @property {object}  [raw]
 */

/**
 * @typedef {Object} RefundParams
 * @property {string}  providerPaymentId
 * @property {number}  amount             - minor units
 * @property {string}  [reason]
 * @property {string}  idempotencyKey
 * @property {object}  credentials
 */

/**
 * @typedef {Object} RefundDTO
 * @property {string}  providerRefundId
 * @property {number}  amount
 * @property {string}  status             - 'pending' | 'processing' | 'completed' | 'failed'
 * @property {object}  [raw]
 */

/**
 * @typedef {Object} WebhookVerifyParams
 * @property {Buffer}  rawBody
 * @property {object}  headers
 * @property {object}  credentials        - decrypted (may include webhookSecret)
 */

/**
 * @typedef {Object} MappedEventDTO
 * @property {string}  normalizedEvent    - e.g. 'payment.paid', 'payment.failed'
 * @property {string}  providerEventId
 * @property {string}  [providerPaymentId]
 * @property {string}  [providerOrderId]
 * @property {number}  [amount]
 * @property {string}  [currency]
 * @property {string}  [errorCode]
 * @property {string}  [errorDescription]
 * @property {object}  safePayload        - non-sensitive subset safe to persist
 */

/**
 * @typedef {Object} CapabilitiesDTO
 * @property {boolean} hostedCheckout
 * @property {boolean} paymentLinks
 * @property {boolean} webhooks
 * @property {boolean} refunds
 * @property {boolean} partialRefunds
 * @property {boolean} statusPolling
 */

/**
 * @typedef {Object} CredentialSchemaDTO
 * @property {string}  key                - e.g. 'keyId'
 * @property {string}  label              - e.g. 'Key ID'
 * @property {boolean} secret             - if true, encrypt and never return
 * @property {string}  [hint]
 */

/** Ordered list of methods every adapter must export */
const REQUIRED_METHODS = [
  'createOrder',
  'createPaymentLink',
  'getPaymentStatus',
  'createRefund',
  'verifyWebhookSignature',
  'mapWebhookEvent',
  'getCapabilities',
  'getCredentialSchema'
];

/**
 * Validate that an adapter object has all required methods.
 * Called at registration time (gateway startup or test).
 * @param {string} providerName
 * @param {object} adapter
 * @throws {Error} if any method is missing
 */
function assertAdapterShape(providerName, adapter) {
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(
        `GatewayContract: adapter "${providerName}" is missing required method "${method}"`
      );
    }
  }
}

module.exports = {
  assertAdapterShape,
  REQUIRED_METHODS
};
