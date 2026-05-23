'use strict';

const libphonenumber = require('google-libphonenumber');

const phoneUtil = libphonenumber.PhoneNumberUtil.getInstance();
const PhoneNumberFormat = libphonenumber.PhoneNumberFormat;

const FALLBACK_REGION = 'IN';

/** ISO 3166-1 alpha-2 codes we expose in the campaign UI. */
const SUPPORTED_REGIONS = [
  'IN', 'AE', 'US', 'GB', 'SA', 'QA', 'KW', 'BH', 'OM', 'SG', 'MY', 'AU', 'CA', 'DE', 'FR'
];

/**
 * Infer ISO region from a WhatsApp display number (e.g. "+971 52 948 2432" → "AE").
 */
function inferDefaultRegionFromDisplayNumber(displayPhoneNumber) {
  const raw = String(displayPhoneNumber || '').trim();
  if (!raw) return FALLBACK_REGION;

  try {
    const parsed = phoneUtil.parse(raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`, undefined);
    if (phoneUtil.isValidNumber(parsed)) {
      const region = phoneUtil.getRegionCodeForNumber(parsed);
      if (region) return region;
    }
  } catch {
    // fall through
  }

  return FALLBACK_REGION;
}

/**
 * Resolve a CSV country hint to an ISO region code.
 * Accepts: "IN", "91", "+971", "971", "UAE" (limited aliases).
 */
function resolveRegionFromCountryHint(hint) {
  const s = String(hint || '').trim();
  if (!s) return null;

  const upper = s.toUpperCase().replace(/^\+/, '');
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  const aliasMap = {
    UAE: 'AE',
    UK: 'GB',
    USA: 'US'
  };
  if (aliasMap[upper]) return aliasMap[upper];

  const digits = s.replace(/\D/g, '');
  if (digits) {
    try {
      const code = parseInt(digits, 10);
      const region = phoneUtil.getRegionCodeForCountryCode(code);
      if (region && region !== 'ZZ') return region;
    } catch {
      // ignore
    }
  }

  return null;
}

function sanitizeDefaultRegion(region) {
  const r = String(region || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(r)) return r;
  return FALLBACK_REGION;
}

function getNationalDigitLength(region) {
  try {
    const example = phoneUtil.getExampleNumberForType(
      region,
      libphonenumber.PhoneNumberType.MOBILE
    );
    if (example) {
      return String(example.getNationalNumber()).length;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Normalise a phone string to E.164 digits-only (no leading +).
 *
 * Digits-only values are parsed as local/national numbers for the default (or row)
 * region first. International parsing is only used when the user supplied a leading "+"
 * or when national parsing fails but a valid international form exists (mixed lists).
 *
 * @returns {{ phone: string|null, status: 'valid'|'prefixed'|'invalid', reason?: string }}
 */
function normalizePhoneE164(raw, options = {}) {
  const defaultRegion = sanitizeDefaultRegion(options.defaultRegion || FALLBACK_REGION);
  const trimmed = String(raw || '').trim();

  if (!trimmed) {
    return { phone: null, status: 'invalid', reason: 'Empty phone number' };
  }

  const rowRegion = options.rowRegion
    ? resolveRegionFromCountryHint(options.rowRegion) || defaultRegion
    : defaultRegion;

  const hadPlus = trimmed.startsWith('+');
  const digitsOnly = trimmed.replace(/\D/g, '');

  if (!digitsOnly) {
    return { phone: null, status: 'invalid', reason: 'No digits found' };
  }

  let parsed = null;
  let usedNationalRegion = false;

  try {
    if (hadPlus) {
      parsed = phoneUtil.parse(trimmed, undefined);
    } else {
      // Prefer national parse — avoids misreading 10-digit IN numbers like 9613014412 as +961…
      try {
        const national = phoneUtil.parse(trimmed, rowRegion);
        if (phoneUtil.isValidNumber(national)) {
          parsed = national;
          usedNationalRegion = true;
        }
      } catch {
        parsed = null;
      }

      if (!parsed) {
        const nationalLength = getNationalDigitLength(rowRegion);
        const looksLikeLocalOnly =
          nationalLength != null && digitsOnly.length <= nationalLength;

        if (!looksLikeLocalOnly) {
          try {
            const intl = phoneUtil.parse(`+${digitsOnly}`, undefined);
            if (phoneUtil.isValidNumber(intl)) {
              parsed = intl;
            }
          } catch {
            parsed = null;
          }
        }
      }
    }

    if (!parsed || !phoneUtil.isValidNumber(parsed)) {
      return { phone: null, status: 'invalid', reason: 'Invalid phone number' };
    }

    const e164 = phoneUtil.format(parsed, PhoneNumberFormat.E164).replace(/^\+/, '');
    const nationalNumber = String(parsed.getNationalNumber() || '');
    const countryCallingCode = String(parsed.getCountryCode() || '');

    let status = 'valid';
    if (usedNationalRegion && digitsOnly === nationalNumber) {
      status = 'prefixed';
    } else if (!hadPlus && digitsOnly === nationalNumber) {
      status = 'prefixed';
    } else if (
      !hadPlus &&
      !digitsOnly.startsWith(countryCallingCode) &&
      digitsOnly.length === nationalNumber.length
    ) {
      status = 'prefixed';
    }

    return { phone: e164, status, reason: undefined };
  } catch {
    return { phone: null, status: 'invalid', reason: 'Invalid phone number' };
  }
}

/**
 * Legacy helper — digits-only E.164 without status (uses default region IN).
 * Prefer normalizePhoneE164 for campaign imports.
 */
function normalizePhoneLegacy(raw, defaultRegion = FALLBACK_REGION) {
  const result = normalizePhoneE164(raw, { defaultRegion });
  return result.phone;
}

module.exports = {
  FALLBACK_REGION,
  SUPPORTED_REGIONS,
  inferDefaultRegionFromDisplayNumber,
  resolveRegionFromCountryHint,
  sanitizeDefaultRegion,
  normalizePhoneE164,
  normalizePhoneLegacy
};
