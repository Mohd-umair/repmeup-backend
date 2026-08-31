'use strict';

/**
 * Gateway Registry
 *
 * Central map from provider name → adapter instance.
 * Business logic (PaymentService, FulfilmentService) calls getAdapter(provider)
 * and never switches on provider name directly.
 *
 * Adapters are registered lazily at require-time and must satisfy gatewayContract.
 */

const { assertAdapterShape } = require('./gatewayContract');
const logger = require('../../config/logger');

/** @type {Map<string, object>} */
const _registry = new Map();

/**
 * Register a gateway adapter.
 * @param {string} provider  - e.g. 'razorpay'
 * @param {object} adapter   - must implement all gatewayContract methods
 */
function register(provider, adapter) {
  assertAdapterShape(provider, adapter);
  _registry.set(provider, adapter);
  logger.info(`[GatewayRegistry] registered adapter: ${provider}`);
}

/**
 * Retrieve an adapter by provider name.
 * @param {string} provider
 * @returns {object} adapter
 * @throws {Error} if not registered
 */
function getAdapter(provider) {
  const adapter = _registry.get(provider);
  if (!adapter) {
    throw new Error(
      `GatewayRegistry: no adapter registered for provider "${provider}". ` +
        `Registered: [${[..._registry.keys()].join(', ')}]`
    );
  }
  return adapter;
}

/**
 * Returns true if an adapter is registered for the given provider.
 * @param {string} provider
 * @returns {boolean}
 */
function has(provider) {
  return _registry.has(provider);
}

/**
 * Returns list of registered provider names.
 * @returns {string[]}
 */
function listProviders() {
  return [..._registry.keys()];
}

/**
 * Returns the capabilities of a registered adapter.
 * Convenience wrapper so callers don't need to call getAdapter().getCapabilities() manually.
 * @param {string} provider
 * @returns {object} CapabilitiesDTO
 */
function getCapabilities(provider) {
  return getAdapter(provider).getCapabilities();
}

/**
 * Returns the credential schema for a registered adapter.
 * @param {string} provider
 * @returns {object[]} CredentialSchemaDTO[]
 */
function getCredentialSchema(provider) {
  return getAdapter(provider).getCredentialSchema();
}

// ── Boot-time adapter registration ────────────────────────────────────────────
// Each adapter is required here so the registry is populated when this module loads.
// Add new providers by appending to this block; no changes needed in business logic.

try {
  const razorpayAdapter = require('./adapters/razorpayAdapter');
  register('razorpay', razorpayAdapter);
} catch (err) {
  logger.warn('[GatewayRegistry] Could not load razorpayAdapter', { error: err.message });
}

// ── Gated providers — registered only after written partner approval ──────────
// Each env var must be set to 'confirmed' AND the adapter must pass assertAdapterShape.
// The adapters exist in the codebase for review; they are NOT active by default.

if (process.env.CASHFREE_PARTNER_APPROVAL === 'confirmed') {
  try {
    const cashfreeAdapter = require('./adapters/cashfreeAdapter');
    register('cashfree', cashfreeAdapter);
  } catch (err) {
    logger.warn('[GatewayRegistry] Could not load cashfreeAdapter', { error: err.message });
  }
}

if (process.env.PAYU_PARTNER_APPROVAL === 'confirmed') {
  try {
    const payuAdapter = require('./adapters/payuAdapter');
    register('payu', payuAdapter);
  } catch (err) {
    logger.warn('[GatewayRegistry] Could not load payuAdapter', { error: err.message });
  }
}

if (process.env.PHONEPE_PARTNER_APPROVAL === 'confirmed') {
  try {
    const phonepayAdapter = require('./adapters/phonepayAdapter');
    register('phonepe', phonepayAdapter);
  } catch (err) {
    logger.warn('[GatewayRegistry] Could not load phonepayAdapter', { error: err.message });
  }
}

module.exports = {
  register,
  getAdapter,
  has,
  listProviders,
  getCapabilities,
  getCredentialSchema
};
