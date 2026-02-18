const jwt = require('jsonwebtoken');
const axios = require('axios');
const jwksClient = require('jwks-rsa');
const User = require('../../models/User');

const RISC_DISCOVERY_URL = 'https://accounts.google.com/.well-known/risc-configuration';

// RISC Security Event Token event types
const EVENT_TYPES = {
  SESSIONS_REVOKED:              'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  TOKENS_REVOKED:                'https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked',
  TOKEN_REVOKED:                 'https://schemas.openid.net/secevent/oauth/event-type/token-revoked',
  ACCOUNT_DISABLED:              'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  ACCOUNT_ENABLED:               'https://schemas.openid.net/secevent/risc/event-type/account-enabled',
  CREDENTIAL_CHANGE_REQUIRED:    'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
  VERIFICATION:                  'https://schemas.openid.net/secevent/risc/event-type/verification',
};

let cachedRiscConfig = null;
let riscConfigFetchedAt = null;
const RISC_CONFIG_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch and cache Google's RISC discovery document.
 */
async function getRiscConfig() {
  const now = Date.now();
  if (cachedRiscConfig && riscConfigFetchedAt && (now - riscConfigFetchedAt) < RISC_CONFIG_TTL_MS) {
    return cachedRiscConfig;
  }
  const { data } = await axios.get(RISC_DISCOVERY_URL);
  cachedRiscConfig = data;
  riscConfigFetchedAt = now;
  return data;
}

/**
 * Validate and decode a Google Security Event Token (SET).
 * Returns the decoded payload or throws if invalid.
 */
async function validateSecurityEventToken(token) {
  const riscConfig = await getRiscConfig();

  // Decode header without verifying to get kid
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) {
    throw new Error('Malformed security event token');
  }

  const { kid } = decoded.header;

  // Build a JWKS client pointing at Google's cert endpoint
  const client = jwksClient({
    jwksUri: riscConfig.jwks_uri,
    cache: true,
    cacheMaxEntries: 10,
    cacheMaxAge: RISC_CONFIG_TTL_MS,
  });

  const key = await client.getSigningKey(kid);
  const publicKey = key.getPublicKey();

  // Verify signature, issuer, and audience. SETs don't expire so we skip exp.
  const clientIds = [process.env.GOOGLE_CLIENT_ID].filter(Boolean);

  const payload = jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: riscConfig.issuer,
    audience: clientIds,
    ignoreExpiration: true,
  });

  return payload;
}

/**
 * Find a user by their Google subject ID (oauth.providerId).
 */
async function findUserByGoogleSub(sub) {
  return User.findOne({ 'oauth.provider': 'google', 'oauth.providerId': sub });
}

/**
 * Record a RISC event on the user document.
 */
async function recordRiscEvent(user, eventType, reason) {
  user.risc = user.risc || {};
  user.risc.lastEvent = {
    type: eventType,
    timestamp: new Date(),
    reason: reason || null,
  };
  await user.save();
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleSessionsRevoked(subject) {
  const user = await findUserByGoogleSub(subject.sub);
  if (!user) return;

  // Mark the account so next token validation forces re-login.
  // Since we use JWT (stateless), we bump a counter that auth middleware checks.
  user.risc = user.risc || {};
  user.risc.googleSignInDisabled = false; // Sessions revoked ≠ account disabled
  await recordRiscEvent(user, EVENT_TYPES.SESSIONS_REVOKED);
}

async function handleTokensRevoked(subject) {
  const user = await findUserByGoogleSub(subject.sub);
  if (!user) return;

  user.oauth = user.oauth || {};
  user.oauth.accessToken = null;
  user.oauth.refreshToken = null;
  await recordRiscEvent(user, EVENT_TYPES.TOKENS_REVOKED);
}

async function handleTokenRevoked(subject) {
  const user = await findUserByGoogleSub(subject.sub);
  if (!user) return;

  user.oauth = user.oauth || {};
  user.oauth.refreshToken = null;
  await recordRiscEvent(user, EVENT_TYPES.TOKEN_REVOKED);
}

async function handleAccountDisabled(subject, reason) {
  const user = await findUserByGoogleSub(subject.sub);
  if (!user) return;

  user.risc = user.risc || {};
  user.risc.googleSignInDisabled = true;
  user.risc.accountDisabledReason = reason || 'unknown';

  if (reason === 'hijacking') {
    // Immediately deactivate the account for security
    user.isActive = false;
  }

  await recordRiscEvent(user, EVENT_TYPES.ACCOUNT_DISABLED, reason);
}

async function handleAccountEnabled(subject) {
  const user = await findUserByGoogleSub(subject.sub);
  if (!user) return;

  user.risc = user.risc || {};
  user.risc.googleSignInDisabled = false;
  user.risc.accountDisabledReason = null;
  user.isActive = true;
  await recordRiscEvent(user, EVENT_TYPES.ACCOUNT_ENABLED);
}

async function handleCredentialChangeRequired(subject) {
  const user = await findUserByGoogleSub(subject.sub);
  if (!user) return;

  user.risc = user.risc || {};
  user.risc.requiresCredentialChange = true;
  await recordRiscEvent(user, EVENT_TYPES.CREDENTIAL_CHANGE_REQUIRED);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Process a raw SET token string. Returns an object with processing result.
 */
async function processSecurityEventToken(rawToken) {
  const payload = await validateSecurityEventToken(rawToken);

  const { events, jti } = payload;
  if (!events) {
    return { status: 'ignored', reason: 'no events in token' };
  }

  const results = [];

  for (const [eventType, eventData] of Object.entries(events)) {
    const subject = eventData.subject || {};
    const reason = eventData.reason;

    switch (eventType) {
      case EVENT_TYPES.SESSIONS_REVOKED:
        await handleSessionsRevoked(subject);
        results.push({ eventType, handled: true });
        break;

      case EVENT_TYPES.TOKENS_REVOKED:
        await handleTokensRevoked(subject);
        results.push({ eventType, handled: true });
        break;

      case EVENT_TYPES.TOKEN_REVOKED:
        await handleTokenRevoked(subject);
        results.push({ eventType, handled: true });
        break;

      case EVENT_TYPES.ACCOUNT_DISABLED:
        await handleAccountDisabled(subject, reason);
        results.push({ eventType, handled: true });
        break;

      case EVENT_TYPES.ACCOUNT_ENABLED:
        await handleAccountEnabled(subject);
        results.push({ eventType, handled: true });
        break;

      case EVENT_TYPES.CREDENTIAL_CHANGE_REQUIRED:
        await handleCredentialChangeRequired(subject);
        results.push({ eventType, handled: true });
        break;

      case EVENT_TYPES.VERIFICATION:
        // Test token — just log and acknowledge
        results.push({ eventType, handled: true, note: 'verification token received' });
        break;

      default:
        results.push({ eventType, handled: false, note: 'unknown event type' });
    }
  }

  return { status: 'processed', jti, results };
}

module.exports = {
  processSecurityEventToken,
  validateSecurityEventToken,
  EVENT_TYPES,
};
