'use strict';

/**
 * Platform-scoped voice AI keys only — never returned to clients or stored per-org.
 * Org documents may still contain legacy fields; callers should use this module.
 */

function getPlatformSarvamKey() {
  const k = process.env.PLATFORM_SARVAM_API_KEY || process.env.SARVAM_API_KEY || '';
  return String(k).trim();
}

function getPlatformOpenAiKey() {
  const k = process.env.PLATFORM_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
  return String(k).trim();
}

module.exports = {
  getPlatformSarvamKey,
  getPlatformOpenAiKey
};
