/**
 * Tests for colorClustering — fixes the bug where aggregating AI-detected
 * colors across multiple images (Brand Profile "Aggregated Visual Style",
 * reference-image style summary) collapsed down to a handful of generic
 * muted tones because exact-hex-string frequency counting almost never lets
 * visually-similar-but-not-identical shades accumulate a real count.
 */
const { hexToRgb, rgbDistance, topClusteredColors } = require('../../../src/utils/colorClustering');

describe('hexToRgb', () => {
  test('parses 6-digit hex', () => {
    expect(hexToRgb('#1A2B3C')).toEqual({ r: 26, g: 43, b: 60 });
  });

  test('parses without leading #', () => {
    expect(hexToRgb('1A2B3C')).toEqual({ r: 26, g: 43, b: 60 });
  });

  test('expands 3-digit shorthand hex', () => {
    expect(hexToRgb('#f0a')).toEqual({ r: 255, g: 0, b: 170 });
  });

  test('returns null for invalid input', () => {
    expect(hexToRgb('red')).toBeNull();
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb(null)).toBeNull();
    expect(hexToRgb('#zzzzzz')).toBeNull();
    expect(hexToRgb('#12345')).toBeNull();
  });
});

describe('rgbDistance', () => {
  test('is zero for identical colors', () => {
    expect(rgbDistance({ r: 10, g: 20, b: 30 }, { r: 10, g: 20, b: 30 })).toBe(0);
  });

  test('computes Euclidean distance', () => {
    expect(rgbDistance({ r: 0, g: 0, b: 0 }, { r: 3, g: 4, b: 0 })).toBe(5);
  });
});

describe('topClusteredColors', () => {
  test('empty/missing input → empty array', () => {
    expect(topClusteredColors({})).toEqual([]);
    expect(topClusteredColors(undefined)).toEqual([]);
  });

  test('THE BUG: near-identical hex values that never exact-match are merged into one cluster, not lost', () => {
    // Simulates 5 images each producing a slightly different near-black hex —
    // under the old exact-string-frequency algorithm every one of these is a
    // distinct count=1 entry, so a genuinely dominant near-black tone never
    // rises to the top and instead loses to arbitrary tie-breaking.
    const colorCounts = {
      '#1A1A2E': 1, '#1B1B2D': 1, '#191928': 1, '#1C1C30': 1, '#181826': 1,
      // one clearly distinct accent color that only appears once
      '#E94560': 1
    };
    const top = topClusteredColors(colorCounts, { limit: 5 });
    // The 5 near-black variants must merge into ONE cluster (weight 5),
    // ranked above the single-occurrence accent color (weight 1).
    expect(top.length).toBe(2);
    expect(['#1A1A2E', '#1B1B2D', '#191928', '#1C1C30', '#181826']).toContain(top[0]);
    expect(top[1]).toBe('#E94560');
  });

  test('represents each cluster by its most-frequently-seen exact member', () => {
    const colorCounts = { '#101010': 5, '#111111': 1, '#0F0F0F': 2 };
    const top = topClusteredColors(colorCounts, { limit: 5 });
    expect(top).toEqual(['#101010']); // merged into 1 cluster, weight 8, rep = highest individual count
  });

  test('keeps visually distinct colors in separate clusters', () => {
    const colorCounts = { '#FF0000': 3, '#0000FF': 3, '#00FF00': 3 };
    const top = topClusteredColors(colorCounts, { limit: 5 });
    expect(top.sort()).toEqual(['#0000FF', '#00FF00', '#FF0000']);
  });

  test('respects the limit and sorts by cluster weight descending', () => {
    const colorCounts = { '#000000': 1, '#FFFFFF': 5, '#FF0000': 3, '#00FF00': 2, '#0000FF': 4, '#FFFF00': 1 };
    const top = topClusteredColors(colorCounts, { limit: 3 });
    expect(top).toEqual(['#FFFFFF', '#0000FF', '#FF0000']);
  });

  test('honors a custom threshold — tighter threshold keeps similar shades separate', () => {
    const colorCounts = { '#100000': 1, '#200000': 1 }; // distance ~16
    expect(topClusteredColors(colorCounts, { threshold: 5 }).length).toBe(2);
    expect(topClusteredColors(colorCounts, { threshold: 50 }).length).toBe(1);
  });

  test('non-hex values fall back to exact-string clustering instead of being dropped', () => {
    // Legacy/unexpected non-hex input (e.g. a named color) must not silently
    // disappear from the result.
    const colorCounts = { red: 3, blue: 1, green: 1 };
    const top = topClusteredColors(colorCounts, { limit: 5 });
    expect(top[0]).toBe('red');
    expect(top).toEqual(expect.arrayContaining(['red', 'blue', 'green']));
  });

  test('invalid hex entries mixed with valid ones only drop the invalid ones', () => {
    const colorCounts = { '#FF0000': 2, 'not-a-color-!!': 1, '#00FF00': 1 };
    const top = topClusteredColors(colorCounts, { limit: 5 });
    expect(top).toEqual(expect.arrayContaining(['#FF0000', '#00FF00', 'not-a-color-!!']));
  });
});
