/**
 * Tests for brandConfigValidation — the gate between client-supplied Brand
 * Hub input and BrandConfig persistence / AI prompt injection
 * (brandContextService feeds these fields straight into prompts).
 */
const {
  TONE_OPTIONS,
  EMOJI_USAGE_OPTIONS,
  LIMITS,
  sanitizeStringArray,
  validateBrandConfigUpdate,
  validateProfileOverrides
} = require('../../../src/utils/brandConfigValidation');

describe('sanitizeStringArray', () => {
  test('non-array input returns empty array, no error', () => {
    expect(sanitizeStringArray('not-an-array')).toEqual({ value: [], error: null });
    expect(sanitizeStringArray(null)).toEqual({ value: [], error: null });
    expect(sanitizeStringArray(undefined)).toEqual({ value: [], error: null });
  });

  test('trims, drops empties, dedupes case-insensitively', () => {
    const { value, error } = sanitizeStringArray(['  Bold  ', 'bold', 'BOLD', '', '   ', 'Cheeky']);
    expect(error).toBeNull();
    expect(value).toEqual(['Bold', 'Cheeky']);
  });

  test('drops non-string/number entries silently', () => {
    const { value } = sanitizeStringArray(['ok', null, undefined, {}, [], 42, true]);
    expect(value).toEqual(['ok', '42']);
  });

  test('errors (returns null value) when item count exceeds maxItems', () => {
    const { value, error } = sanitizeStringArray(['a', 'b', 'c'], { maxItems: 2 });
    expect(value).toBeNull();
    expect(error).toMatch(/maximum 2 items allowed \(received 3\)/);
  });

  test('truncates individual items to maxLength', () => {
    const { value } = sanitizeStringArray(['a'.repeat(100)], { maxLength: 10 });
    expect(value[0].length).toBe(10);
  });

  test('lowercases when lowercase: true (used for bannedWords)', () => {
    const { value } = sanitizeStringArray(['Guarantee', 'CURE'], { lowercase: true });
    expect(value).toEqual(['guarantee', 'cure']);
  });
});

describe('validateBrandConfigUpdate', () => {
  test('empty body → no errors, no values', () => {
    const { errors, values } = validateBrandConfigUpdate({});
    expect(errors).toEqual([]);
    expect(values).toEqual({});
  });

  test('rejects toneOfVoice outside the enum', () => {
    const { errors, values } = validateBrandConfigUpdate({ toneOfVoice: 'sarcastic' });
    expect(errors[0]).toMatch(new RegExp(`toneOfVoice must be one of: ${TONE_OPTIONS.join(', ')}`));
    expect(values.toneOfVoice).toBeUndefined();
  });

  test('accepts a valid toneOfVoice', () => {
    const { errors, values } = validateBrandConfigUpdate({ toneOfVoice: 'playful' });
    expect(errors).toEqual([]);
    expect(values.toneOfVoice).toBe('playful');
  });

  test('rejects non-array personalityTags/bannedWords/approvedHashtags', () => {
    const { errors } = validateBrandConfigUpdate({
      personalityTags: 'bold', bannedWords: 'x', approvedHashtags: 'y'
    });
    expect(errors).toEqual(expect.arrayContaining([
      'personalityTags must be an array of strings',
      'bannedWords must be an array of strings',
      'approvedHashtags must be an array of strings'
    ]));
  });

  test('sanitizes and caps array fields, lowercases bannedWords', () => {
    const { errors, values } = validateBrandConfigUpdate({
      personalityTags: ['Bold', ' Cheeky '],
      bannedWords: ['GUARANTEE', 'Cure'],
      approvedHashtags: ['#Repmeup']
    });
    expect(errors).toEqual([]);
    expect(values.personalityTags).toEqual(['Bold', 'Cheeky']);
    expect(values.bannedWords).toEqual(['guarantee', 'cure']);
    expect(values.approvedHashtags).toEqual(['#Repmeup']);
  });

  test('propagates the array-count-exceeded error with field prefix', () => {
    const tooMany = Array.from({ length: LIMITS.TAG_MAX_COUNT + 1 }, (_, i) => `tag${i}`);
    const { errors, values } = validateBrandConfigUpdate({ personalityTags: tooMany });
    expect(errors[0]).toMatch(/^personalityTags: maximum \d+ items allowed/);
    expect(values.personalityTags).toBeUndefined();
  });

  test('rejects non-string legalDisclaimers, sanitizes valid ones', () => {
    expect(validateBrandConfigUpdate({ legalDisclaimers: 123 }).errors)
      .toEqual(['legalDisclaimers must be a string']);
    const { errors, values } = validateBrandConfigUpdate({ legalDisclaimers: '  Terms apply.  ' });
    expect(errors).toEqual([]);
    expect(values.legalDisclaimers).toBe('Terms apply.');
  });

  test('unknown fields on the body are ignored, never persisted', () => {
    const { errors, values } = validateBrandConfigUpdate({
      toneOfVoice: 'professional',
      __proto__: { polluted: true },
      isAdmin: true,
      organization: 'some-other-org-id'
    });
    expect(errors).toEqual([]);
    expect(values).toEqual({ toneOfVoice: 'professional' });
  });
});

describe('validateProfileOverrides', () => {
  test('null/undefined → no errors, null value (clears overrides)', () => {
    expect(validateProfileOverrides(null)).toEqual({ errors: [], value: null });
    expect(validateProfileOverrides(undefined)).toEqual({ errors: [], value: null });
  });

  test('non-object (string/array) → error', () => {
    expect(validateProfileOverrides('nope').errors).toEqual(['overrides must be an object']);
    expect(validateProfileOverrides(['a']).errors).toEqual(['overrides must be an object']);
  });

  test('validates emojiUsage enum, treats empty string / null as "clear"', () => {
    expect(validateProfileOverrides({ emojiUsage: 'excessive' }).errors[0])
      .toMatch(new RegExp(`emojiUsage must be one of: ${EMOJI_USAGE_OPTIONS.join(', ')}`));
    expect(validateProfileOverrides({ emojiUsage: 'heavy' })).toEqual({ errors: [], value: { emojiUsage: 'heavy' } });
    expect(validateProfileOverrides({ emojiUsage: '' })).toEqual({ errors: [], value: null });
    expect(validateProfileOverrides({ emojiUsage: null })).toEqual({ errors: [], value: null });
  });

  test('string fields (writingStyle etc.) are sanitized and type-checked', () => {
    expect(validateProfileOverrides({ writingStyle: 42 }).errors).toEqual(['writingStyle must be a string']);
    const { errors, value } = validateProfileOverrides({ writingStyle: '  casual and warm  ' });
    expect(errors).toEqual([]);
    expect(value).toEqual({ writingStyle: 'casual and warm' });
  });

  test('array fields (recurringEmojis etc.) are sanitized, capped, and type-checked', () => {
    expect(validateProfileOverrides({ colorPalette: 'not-an-array' }).errors)
      .toEqual(['colorPalette must be an array of strings']);
    const { errors, value } = validateProfileOverrides({ colorPalette: ['#fff', '#fff', ' #000 '] });
    expect(errors).toEqual([]);
    expect(value).toEqual({ colorPalette: ['#fff', '#000'] });
  });

  test('empty array after sanitization is omitted, not stored as []', () => {
    const { value } = validateProfileOverrides({ recurringEmojis: ['   ', ''] });
    expect(value).toBeNull();
  });

  test('unknown keys (e.g. hashtagStrategy, analyzedAt, sourceConnectionIds) are dropped silently', () => {
    const { errors, value } = validateProfileOverrides({
      writingStyle: 'casual',
      hashtagStrategy: { avgCount: 999 }, // analysis-only field — must never be client-settable
      analyzedAt: new Date().toISOString(),
      sourceConnectionIds: ['fake-connection-id']
    });
    expect(errors).toEqual([]);
    expect(value).toEqual({ writingStyle: 'casual' });
  });

  test('returns { errors: [], value: null } when the object has no recognized keys at all', () => {
    expect(validateProfileOverrides({ foo: 'bar' })).toEqual({ errors: [], value: null });
  });

  test('array item count over the limit produces a prefixed error and drops the field', () => {
    const tooMany = Array.from({ length: LIMITS.PROFILE_ARRAY_MAX_COUNT + 1 }, (_, i) => `x${i}`);
    const { errors, value } = validateProfileOverrides({ ctaStyle: tooMany });
    expect(errors[0]).toMatch(/^ctaStyle: maximum \d+ items allowed/);
    expect(value).toBeNull();
  });
});
