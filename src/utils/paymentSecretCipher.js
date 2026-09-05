'use strict';

/**
 * Payment Gateway Secret Cipher
 *
 * AES-256-GCM authenticated encryption for organization-owned payment gateway
 * credentials (key_id/key_secret, webhook secrets, OAuth tokens).
 *
 * Key hierarchy
 *   PAYMENT_GATEWAY_ENCRYPTION_KEY — dedicated env var, independent of JWT_SECRET.
 *   keyVersion field persists alongside ciphertext so stored records survive key rotation.
 *
 * Storage format: "<keyVersion>:<iv(b64)>:<authTag(b64)>:<ciphertext(b64)>"
 * (colon-delimited, all base64 URL-safe off; never stored in browser or logs)
 */

const crypto = require('crypto');
const logger = require('../config/logger');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const CURRENT_KEY_VERSION = 1;
const FIELD_SEP = ':';

// ── Key resolution ────────────────────────────────────────────────────────────

function _rawKeyForVersion(version) {
  if (version === 1) {
    const raw = process.env.PAYMENT_GATEWAY_ENCRYPTION_KEY;
    if (!raw || String(raw).trim().length < 32) {
      throw new Error(
        'PAYMENT_GATEWAY_ENCRYPTION_KEY must be set and at least 32 characters. ' +
          'Generate with: openssl rand -base64 48'
      );
    }
    return String(raw).trim();
  }
  throw new Error(`Unknown payment cipher key version: ${version}`);
}

function _derivedKey(version) {
  return crypto.createHash('sha256').update(_rawKeyForVersion(version)).digest();
}

// ── Encrypt ───────────────────────────────────────────────────────────────────

/**
 * Encrypt a secret string.
 * @param {string} plaintext
 * @returns {string} versioned cipher envelope
 */
function encrypt(plaintext) {
  if (plaintext == null || String(plaintext).trim() === '') {
    throw new Error('paymentSecretCipher.encrypt: plaintext must not be empty');
  }
  const version = CURRENT_KEY_VERSION;
  const key = _derivedKey(version);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    version,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64')
  ].join(FIELD_SEP);
}

// ── Decrypt ───────────────────────────────────────────────────────────────────

/**
 * Decrypt a versioned cipher envelope.
 * Returns null (and logs a warning) on decryption failure rather than throwing,
 * so callers can distinguish "key error / corrupt" from "secret missing".
 * @param {string|null|undefined} envelope
 * @returns {string|null}
 */
function decrypt(envelope) {
  if (!envelope || typeof envelope !== 'string') return null;
  const parts = envelope.split(FIELD_SEP);
  if (parts.length !== 4) {
    logger.warn('[paymentSecretCipher] malformed envelope — wrong field count');
    return null;
  }
  const [versionStr, ivB64, tagB64, cipherB64] = parts;
  const version = parseInt(versionStr, 10);
  if (!Number.isFinite(version)) {
    logger.warn('[paymentSecretCipher] malformed envelope — invalid version');
    return null;
  }
  try {
    const key = _derivedKey(version);
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(cipherB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain.toString('utf8');
  } catch (err) {
    logger.warn('[paymentSecretCipher] decryption failed', { version, error: err.message });
    return null;
  }
}

// ── Encrypt object map ────────────────────────────────────────────────────────

/**
 * Encrypt every string value in a plain-object credential map.
 * Non-string values are preserved as-is (e.g. booleans, null).
 *
 * Example:
 *   encryptFields({ keyId: 'rzp_live_...', keySecret: 's3cr3t', webhookSecret: 'wh_...' })
 *   → { keyId: '1:iv:tag:ct', keySecret: '1:iv:tag:ct', webhookSecret: '1:iv:tag:ct' }
 */
function encryptFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      typeof v === 'string' && v.trim() ? encrypt(v) : v
    ])
  );
}

/**
 * Decrypt every string value in a plain-object credential map.
 * Fields that do not look like envelopes are returned as-is.
 */
function decryptFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => {
      if (typeof v !== 'string') return [k, v];
      const decoded = decrypt(v);
      return [k, decoded !== null ? decoded : v];
    })
  );
}

/**
 * Returns true if the environment has a usable encryption key.
 * Use this in connection health-check endpoints.
 */
function isConfigured() {
  try {
    _rawKeyForVersion(CURRENT_KEY_VERSION);
    return true;
  } catch {
    return false;
  }
}

/**
 * Redact a credential map for safe logging/API responses.
 * Replaces every non-null string with '***'.
 */
function redactFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v ? '***' : v])
  );
}

module.exports = {
  encrypt,
  decrypt,
  encryptFields,
  decryptFields,
  isConfigured,
  redactFields,
  CURRENT_KEY_VERSION
};
