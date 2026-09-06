/**
 * Perceptual clustering for hex colors extracted by AI vision analysis
 * across MULTIPLE images (Brand Profile visual analysis, reference-image
 * style aggregation).
 *
 * PROBLEM this fixes: both `brandReferenceImageController._aggregateVisualStyle`
 * and `brandContextService.getVisualStyleContext` used to pick a "top colors"
 * list by counting EXACT hex-string matches across images. AI vision returns
 * a slightly different hex per image even for a visually near-identical tone
 * (e.g. "#1A1A2E" vs "#1B1B2D" — basically the same near-black navy) — so
 * almost nothing exact-matches across many images, and a naive "top N by
 * frequency" degenerates into whichever few colors *happened* to
 * coincidentally repeat byte-for-byte (usually generic studio-background
 * neutrals), while genuinely recurring deep/accent tones never accumulate a
 * count and silently disappear. This is why "detailed/deep colors" kept
 * showing up as the same handful of muted, generic swatches even after
 * improving the per-image vision prompt/resolution.
 *
 * FIX: bucket colors that are visually close (Euclidean RGB distance below a
 * threshold) into one cluster, sum their occurrence counts, and represent
 * each cluster by whichever exact hex was seen most often within it.
 */

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  if (h.length !== 6 && h.length !== 3) return null;
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return null;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * @param {Record<string, number>} colorCounts - hex → occurrence count
 * @param {object} [options]
 * @param {number} [options.threshold=42] - RGB Euclidean distance (0-441)
 *   below which two colors are merged into the same cluster. ~42 groups
 *   near-identical shades (anti-aliasing / per-image vision noise) without
 *   merging genuinely distinct hues.
 * @param {number} [options.limit=5] - max clusters to return
 * @returns {string[]} representative hex color per cluster, most-visually-
 *   present first. Invalid/unparseable hex values are skipped.
 */
function topClusteredColors(colorCounts, { threshold = 42, limit = 5 } = {}) {
  const clusters = [];
  for (const [value, count] of Object.entries(colorCounts || {})) {
    const rgb = hexToRgb(value);
    if (!rgb) {
      // Not parseable as a hex color (unexpected/legacy input) — fall back
      // to exact-string clustering instead of silently dropping the value.
      const existing = clusters.find((c) => c.rgb === null && c.rep === value);
      if (existing) existing.weight += count;
      else clusters.push({ rep: value, rgb: null, weight: count, bestCount: count });
      continue;
    }
    const bucket = clusters.find((c) => c.rgb && rgbDistance(c.rgb, rgb) <= threshold);
    if (bucket) {
      bucket.weight += count;
      // Representative = the exact hex seen most often within this visual
      // cluster (more faithful than "first seen", which could be an outlier).
      if (count > bucket.bestCount) {
        bucket.rep = value;
        bucket.bestCount = count;
        bucket.rgb = rgb;
      }
    } else {
      clusters.push({ rep: value, rgb, weight: count, bestCount: count });
    }
  }
  return clusters
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((c) => c.rep);
}

module.exports = { hexToRgb, rgbDistance, topClusteredColors };
