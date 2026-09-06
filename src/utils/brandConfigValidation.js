/**
 * Input validation/sanitization for Brand Hub mutations (BrandConfig, brand
 * profile overrides). These values flow straight into AI prompts
 * (brandContextService) with no further checks, so unbounded strings/arrays
 * here become unbounded prompt-injection / token-cost / storage-bloat risk.
 *
 * Every validator returns { errors: string[], value }. Callers should 400 on
 * any errors and only persist `value` (never the raw req.body).
 */
const { sanitizeString } = require('./sanitize');

const TONE_OPTIONS = ['professional', 'casual', 'friendly', 'authoritative', 'playful', 'inspirational', 'neutral'];
const EMOJI_USAGE_OPTIONS = ['heavy', 'moderate', 'minimal', 'none'];

const LIMITS = {
  TAG_MAX_LEN: 60,
  TAG_MAX_COUNT: 30,
  HASHTAG_MAX_LEN: 60,
  HASHTAG_MAX_COUNT: 50,
  DISCLAIMER_MAX_LEN: 2000,
  SHORT_TEXT_MAX_LEN: 300,
  PROFILE_ARRAY_MAX_LEN: 60,
  PROFILE_ARRAY_MAX_COUNT: 30
};

/**
 * Trim/cap/dedupe an array of primitive values into clean strings.
 * Non-string/number entries are dropped rather than erroring — keeps the UX
 * forgiving for e.g. stray nulls from a half-typed tag input.
 */
function sanitizeStringArray(input, { maxItems, maxLength, lowercase = false } = {}) {
  if (!Array.isArray(input)) return { value: [], error: null };
  if (maxItems != null && input.length > maxItems) {
    return { value: null, error: `maximum ${maxItems} items allowed (received ${input.length})` };
  }
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    let s = sanitizeString(String(raw), { maxLength });
    if (lowercase) s = s.toLowerCase();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return { value: out, error: null };
}

/**
 * Validate the manual "Brand Settings" fields (PUT /api/brand-config body).
 * Only whitelisted, type-checked fields make it into `values` — unknown keys
 * in the request body are ignored, never persisted.
 */
function validateBrandConfigUpdate(body = {}) {
  const errors = [];
  const values = {};

  if (body.toneOfVoice !== undefined) {
    if (!TONE_OPTIONS.includes(body.toneOfVoice)) {
      errors.push(`toneOfVoice must be one of: ${TONE_OPTIONS.join(', ')}`);
    } else {
      values.toneOfVoice = body.toneOfVoice;
    }
  }

  if (body.personalityTags !== undefined) {
    if (!Array.isArray(body.personalityTags)) {
      errors.push('personalityTags must be an array of strings');
    } else {
      const { value, error } = sanitizeStringArray(body.personalityTags, {
        maxItems: LIMITS.TAG_MAX_COUNT, maxLength: LIMITS.TAG_MAX_LEN
      });
      if (error) errors.push(`personalityTags: ${error}`); else values.personalityTags = value;
    }
  }

  if (body.bannedWords !== undefined) {
    if (!Array.isArray(body.bannedWords)) {
      errors.push('bannedWords must be an array of strings');
    } else {
      const { value, error } = sanitizeStringArray(body.bannedWords, {
        maxItems: LIMITS.TAG_MAX_COUNT, maxLength: LIMITS.TAG_MAX_LEN, lowercase: true
      });
      if (error) errors.push(`bannedWords: ${error}`); else values.bannedWords = value;
    }
  }

  if (body.approvedHashtags !== undefined) {
    if (!Array.isArray(body.approvedHashtags)) {
      errors.push('approvedHashtags must be an array of strings');
    } else {
      const { value, error } = sanitizeStringArray(body.approvedHashtags, {
        maxItems: LIMITS.HASHTAG_MAX_COUNT, maxLength: LIMITS.HASHTAG_MAX_LEN
      });
      if (error) errors.push(`approvedHashtags: ${error}`); else values.approvedHashtags = value;
    }
  }

  if (body.legalDisclaimers !== undefined) {
    if (typeof body.legalDisclaimers !== 'string') {
      errors.push('legalDisclaimers must be a string');
    } else {
      values.legalDisclaimers = sanitizeString(body.legalDisclaimers, { maxLength: LIMITS.DISCLAIMER_MAX_LEN });
    }
  }

  return { errors, values };
}

const PROFILE_OVERRIDE_STRING_FIELDS = ['writingStyle', 'visualComposition', 'typographyStyle', 'logoPlacement', 'imageMood'];
const PROFILE_OVERRIDE_ARRAY_FIELDS = ['recurringEmojis', 'ctaStyle', 'personalityDescriptors', 'colorPalette'];

/**
 * Validate manual overrides for the AI-analyzed brand profile
 * (PUT /api/brand-config/profile-overrides body.overrides).
 * Unknown keys (e.g. a stray `hashtagStrategy`, `analyzedAt`,
 * `sourceConnectionIds`) are dropped silently — those are analysis-only
 * fields and must never be settable by a client request.
 */
function validateProfileOverrides(overrides) {
  if (overrides === null || overrides === undefined) {
    return { errors: [], value: null };
  }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { errors: ['overrides must be an object'], value: null };
  }

  const errors = [];
  const value = {};

  for (const key of Object.keys(overrides)) {
    const raw = overrides[key];

    if (key === 'emojiUsage') {
      if (raw === null || raw === '') continue;
      if (!EMOJI_USAGE_OPTIONS.includes(raw)) {
        errors.push(`emojiUsage must be one of: ${EMOJI_USAGE_OPTIONS.join(', ')}`);
      } else {
        value.emojiUsage = raw;
      }
      continue;
    }

    if (PROFILE_OVERRIDE_STRING_FIELDS.includes(key)) {
      if (raw === null || raw === '') continue;
      if (typeof raw !== 'string') {
        errors.push(`${key} must be a string`);
      } else {
        const s = sanitizeString(raw, { maxLength: LIMITS.SHORT_TEXT_MAX_LEN });
        if (s) value[key] = s;
      }
      continue;
    }

    if (PROFILE_OVERRIDE_ARRAY_FIELDS.includes(key)) {
      if (raw === null) continue;
      if (!Array.isArray(raw)) {
        errors.push(`${key} must be an array of strings`);
      } else {
        const { value: arr, error } = sanitizeStringArray(raw, {
          maxItems: LIMITS.PROFILE_ARRAY_MAX_COUNT,
          maxLength: LIMITS.PROFILE_ARRAY_MAX_LEN
        });
        if (error) errors.push(`${key}: ${error}`); else if (arr.length) value[key] = arr;
      }
      continue;
    }

    // Any other key (unknown/unsupported) is intentionally ignored, not persisted.
  }

  return { errors, value: Object.keys(value).length ? value : null };
}

module.exports = {
  TONE_OPTIONS,
  EMOJI_USAGE_OPTIONS,
  LIMITS,
  sanitizeStringArray,
  validateBrandConfigUpdate,
  validateProfileOverrides
};
