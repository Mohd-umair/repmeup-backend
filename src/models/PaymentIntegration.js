'use strict';

/**
 * PaymentIntegration
 *
 * Represents a payment gateway credential set owned by an organization.
 * Each organization may have multiple integrations (one per provider/environment pair),
 * but only one may be the default for a given provider+environment combination.
 *
 * Credentials are stored as an encrypted envelope using paymentSecretCipher.
 * Only safe (non-sensitive) fields are returned to the frontend.
 *
 * Compound tenant index enforces one active integration per provider+environment per org.
 */

const mongoose = require('mongoose');

const PROVIDERS = ['razorpay', 'cashfree', 'payu', 'phonepe', 'stripe'];
const ENVIRONMENTS = ['test', 'live'];
const STATUSES = ['connected', 'disconnected', 'error', 'pending'];

const paymentIntegrationSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true
    },

    // ── Provider identity ───────────────────────────────────────────────────
    provider: {
      type: String,
      enum: PROVIDERS,
      required: true
    },

    /** test or live. test connections are always allowed; live requires partner approval gate. */
    environment: {
      type: String,
      enum: ENVIRONMENTS,
      required: true,
      default: 'test'
    },

    status: {
      type: String,
      enum: STATUSES,
      default: 'pending'
    },

    // ── Encrypted credential envelope ───────────────────────────────────────
    /**
     * Plain-object where each string value is a versioned AES-256-GCM envelope
     * produced by paymentSecretCipher.encrypt().
     *
     * Keys vary by provider:
     *   razorpay:  { keyId, keySecret, webhookSecret }
     *   cashfree:  { appId, secretKey, webhookSecret }
     *   payu:      { merchantKey, merchantSalt }
     *   phonepe:   { merchantId, saltKey, saltIndex }
     */
    credentialEnvelope: {
      type: Map,
      of: String,
      default: {}
    },

    /** Non-sensitive identifier shown in UI: masked key_id, account name, email, etc. */
    safeMerchantIdentifier: { type: String, trim: true },

    /** Human label the org gives this connection */
    displayName: { type: String, trim: true },

    /** Opaque endpoint token appended to webhook URL so provider can target this integration */
    webhookEndpointToken: {
      type: String,
      trim: true,
      index: true,
      sparse: true
    },

    /** Whether this is the default integration for its provider+environment */
    isDefault: { type: Boolean, default: false },

    // ── Capabilities declared by the adapter ────────────────────────────────
    capabilities: {
      hostedCheckout: { type: Boolean, default: false },
      paymentLinks: { type: Boolean, default: false },
      webhooks: { type: Boolean, default: false },
      refunds: { type: Boolean, default: false },
      partialRefunds: { type: Boolean, default: false },
      statusPolling: { type: Boolean, default: false }
    },

    // ── OAuth token fields (providers using OAuth) ──────────────────────────
    oauthAccessTokenEnv: { type: String },
    oauthRefreshTokenEnv: { type: String },
    oauthExpiresAt: { type: Date },
    oauthScope: { type: String },

    // ── Connection audit ────────────────────────────────────────────────────
    connectedAt: { type: Date },
    disconnectedAt: { type: Date },
    lastHealthCheckAt: { type: Date },
    lastHealthCheckStatus: { type: String, enum: ['ok', 'error', null], default: null },
    lastErrorAt: { type: Date },
    lastErrorMessage: { type: String, trim: true },

    // ── Webhook health ──────────────────────────────────────────────────────
    lastWebhookReceivedAt: { type: Date },
    webhookFailureCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// One active/default integration per provider+environment per org
paymentIntegrationSchema.index({ organization: 1, provider: 1, environment: 1 }, { unique: true });

// Fast lookup of integration by incoming webhook endpoint token
paymentIntegrationSchema.index({ webhookEndpointToken: 1 }, { sparse: true });

// List all integrations for an org ordered by creation
paymentIntegrationSchema.index({ organization: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentIntegration', paymentIntegrationSchema);
module.exports.PROVIDERS = PROVIDERS;
module.exports.ENVIRONMENTS = ENVIRONMENTS;
module.exports.STATUSES = STATUSES;
