const {
  validateShootConfig,
  normalizeFidelityMode,
  validateStyleReferenceIds,
  FIDELITY_MODES,
  MAX_STYLE_REFS
} = require('../../../src/utils/productShootValidation');

describe('validateShootConfig', () => {
  test('empty/missing config → defaults to preset "custom", no errors', () => {
    const { value, errors } = validateShootConfig(undefined);
    expect(errors).toEqual([]);
    expect(value.preset).toBe('custom');
    expect(value.includePeople).toBe(false);
    expect(value.textSafeZone).toBe(false);
  });

  test('accepts every valid enum field', () => {
    const { value, errors } = validateShootConfig({
      preset: 'luxury-editorial',
      background: 'gradient',
      lighting: 'dramatic',
      cameraAngle: 'top-down',
      placement: 'in-hand',
      aspectRatio: '9:16',
      includePeople: true,
      textSafeZone: true
    });
    expect(errors).toEqual([]);
    expect(value).toEqual(expect.objectContaining({
      preset: 'luxury-editorial',
      background: 'gradient',
      lighting: 'dramatic',
      cameraAngle: 'top-down',
      placement: 'in-hand',
      aspectRatio: '9:16',
      includePeople: true,
      textSafeZone: true
    }));
  });

  test('rejects an invalid background/lighting/cameraAngle/placement/aspectRatio', () => {
    expect(validateShootConfig({ background: 'invalid' }).errors.length).toBe(1);
    expect(validateShootConfig({ lighting: 'invalid' }).errors.length).toBe(1);
    expect(validateShootConfig({ cameraAngle: 'invalid' }).errors.length).toBe(1);
    expect(validateShootConfig({ placement: 'invalid' }).errors.length).toBe(1);
    expect(validateShootConfig({ aspectRatio: '21:9' }).errors.length).toBe(1);
  });

  test('unrecognized preset silently falls back to "custom" rather than erroring', () => {
    const { value, errors } = validateShootConfig({ preset: 'not-a-real-preset' });
    expect(errors).toEqual([]);
    expect(value.preset).toBe('custom');
  });

  test('sanitizes customInstructions: strips newlines/backticks/braces, collapses whitespace', () => {
    const { value, errors } = validateShootConfig({
      customInstructions: 'Add a `{{malicious}}` prompt\ninjection\r\nattempt   here'
    });
    expect(errors).toEqual([]);
    expect(value.customInstructions).not.toMatch(/[\n\r`{}]/);
    expect(value.customInstructions).toBe('Add a malicious prompt injection attempt here');
  });

  test('rejects customInstructions over the max length', () => {
    const { errors } = validateShootConfig({ customInstructions: 'x'.repeat(301) });
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/at most 300 characters/);
  });

  test('non-object input behaves like an empty config', () => {
    expect(validateShootConfig('not-an-object').value.preset).toBe('custom');
    expect(validateShootConfig(null).value.preset).toBe('custom');
  });
});

describe('normalizeFidelityMode', () => {
  test('passes through valid modes', () => {
    for (const mode of FIDELITY_MODES) {
      expect(normalizeFidelityMode(mode)).toBe(mode);
    }
  });

  test('defaults to the safest mode ("strict") on invalid/missing input', () => {
    expect(normalizeFidelityMode('yolo')).toBe('strict');
    expect(normalizeFidelityMode(undefined)).toBe('strict');
    expect(normalizeFidelityMode(null)).toBe('strict');
  });
});

describe('validateStyleReferenceIds', () => {
  test('undefined/null → empty array, no errors', () => {
    expect(validateStyleReferenceIds(undefined)).toEqual({ value: [], errors: [] });
    expect(validateStyleReferenceIds(null)).toEqual({ value: [], errors: [] });
  });

  test('non-array input is rejected', () => {
    const { value, errors } = validateStyleReferenceIds('not-an-array');
    expect(value).toEqual([]);
    expect(errors.length).toBe(1);
  });

  test(`accepts up to ${MAX_STYLE_REFS} ids, deduplicated`, () => {
    const { value, errors } = validateStyleReferenceIds(['a', 'b', 'a', 'c']);
    expect(errors).toEqual([]);
    expect(value).toEqual(['a', 'b', 'c']);
  });

  test(`rejects more than ${MAX_STYLE_REFS} unique ids`, () => {
    const { errors } = validateStyleReferenceIds(['a', 'b', 'c', 'd']);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/at most 3/);
  });

  test('drops falsy/empty entries', () => {
    const { value } = validateStyleReferenceIds(['a', '', null, undefined, 'b']);
    expect(value).toEqual(['a', 'b']);
  });
});
