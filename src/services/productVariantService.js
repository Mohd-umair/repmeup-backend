'use strict';

/**
 * Product Variant Intelligence
 *
 * Pure, dependency-free helpers that make the Commerce Agent aware of a product's
 * variants (sizes + colors). No I/O — everything operates on a plain product-like
 * object ({ sizes: [], colors: [], stock }) and the customer's free-text message,
 * so it is fast in the webhook hot path and fully unit-testable.
 *
 * Responsibilities (single concern):
 *   - Which variant dimensions does a product actually have? (some, one, or none)
 *   - Parse a customer's message for a requested size/color (fuzzy + synonyms).
 *   - Distinguish "asked for something we HAVE" from "asked for something we DON'T".
 *   - Detect a pure availability question ("what colours do you have?").
 *   - Format the copy the agent sends back (availability, ask-for-missing, unavailable).
 *
 * The sales conversation agent (salesConversationService) composes these into the
 * funnel: it gates the payment step on a complete, in-stock variant selection and
 * re-prompts for whatever is missing or unavailable.
 */

// ── Normalisation ────────────────────────────────────────────────────────────

/** lowercase, strip emoji/punctuation to spaces, collapse whitespace. */
function normalize(str) {
  return String(str == null ? '' : str)
    .toLowerCase()
    .replace(/[^a-z0-9+#/\s-]/gi, ' ') // keep alnum + a few size-ish chars
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a normalised string into word tokens. */
function tokenize(str) {
  const n = normalize(str);
  return n ? n.split(' ') : [];
}

// ── Size canonicalisation ────────────────────────────────────────────────────
// Map the many ways a customer writes a size to one canonical code so "large",
// "lrg" and "L" all resolve to the same available size regardless of how the
// merchant typed it in the catalog.
const SIZE_ALIASES = new Map([
  ['xs', 'xs'], ['extra small', 'xs'], ['x small', 'xs'], ['xsmall', 'xs'],
  ['s', 's'], ['small', 's'], ['sm', 's'],
  ['m', 'm'], ['medium', 'm'], ['med', 'm'], ['mid', 'm'],
  ['l', 'l'], ['large', 'l'], ['lrg', 'l'], ['lg', 'l'],
  ['xl', 'xl'], ['extra large', 'xl'], ['x large', 'xl'], ['xlarge', 'xl'],
  ['xxl', 'xxl'], ['2xl', 'xxl'], ['xx large', 'xxl'], ['double xl', 'xxl'],
  ['xxxl', 'xxxl'], ['3xl', 'xxxl'], ['triple xl', 'xxxl'],
  ['free size', 'free'], ['freesize', 'free'], ['one size', 'free'], ['onesize', 'free']
]);

/** Canonical form of a size string (alias → code, else normalised raw). */
function canonicalSize(raw) {
  const n = normalize(raw);
  if (!n) return '';
  if (SIZE_ALIASES.has(n)) return SIZE_ALIASES.get(n);
  return n; // numeric ("32", "8") or custom sizes pass through
}

// ── Color canonicalisation ───────────────────────────────────────────────────
// A lexicon of common colour words lets us recognise that a customer asked for a
// colour AT ALL (so "do you have purple?" is answerable even when purple isn't
// stocked). Spelling variants collapse to one canonical value.
const COLOR_SYNONYMS = new Map([
  ['gray', 'grey'], ['grey', 'grey'],
  ['metallic', 'silver'],
  ['golden', 'gold'],
  ['off white', 'white'], ['offwhite', 'white'], ['cream', 'beige'],
  ['navy blue', 'navy'], ['sky blue', 'blue'],
  ['maroon', 'maroon'], ['wine', 'maroon'],
]);

const COLOR_LEXICON = new Set([
  'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'black', 'white',
  'grey', 'gray', 'brown', 'beige', 'cream', 'navy', 'teal', 'maroon', 'wine',
  'gold', 'golden', 'silver', 'metallic', 'olive', 'mustard', 'peach', 'lavender',
  'turquoise', 'magenta', 'violet', 'indigo', 'tan', 'khaki', 'rose', 'coral',
  'burgundy', 'charcoal', 'mint', 'lime', 'aqua', 'cyan', 'ivory'
]);

/** Canonical form of a colour string (synonym → base, else normalised raw). */
function canonicalColor(raw) {
  const n = normalize(raw);
  if (!n) return '';
  if (COLOR_SYNONYMS.has(n)) return COLOR_SYNONYMS.get(n);
  return n;
}

// ── Product introspection ────────────────────────────────────────────────────

/** Clean, de-duplicated list of a product's sizes (original casing preserved). */
function availableSizes(product) {
  return uniqueTrimmed(product?.sizes);
}

/** Clean, de-duplicated list of a product's colours (original casing preserved). */
function availableColors(product) {
  return uniqueTrimmed(product?.colors);
}

function uniqueTrimmed(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const s = String(v == null ? '' : v).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Which variant dimensions this product actually requires the customer to choose.
 * A product may have both, one, or none.
 * @returns {{ needsSize: boolean, needsColor: boolean, hasVariants: boolean }}
 */
function variantDimensions(product) {
  const needsSize = availableSizes(product).length > 0;
  const needsColor = availableColors(product).length > 0;
  return { needsSize, needsColor, hasVariants: needsSize || needsColor };
}

/** True when the product is explicitly out of stock (stock === 0). null = unlimited. */
function isOutOfStock(product) {
  return product && product.stock != null && Number(product.stock) <= 0;
}

// ── Matching customer text → variants ────────────────────────────────────────

/**
 * Find which available size the message refers to, and whether the customer named
 * a size we DON'T carry.
 * @returns {{ matched: string|null, requestedUnavailable: string|null }}
 *   matched = the available size string (original casing) the customer wants.
 *   requestedUnavailable = a size-like token the customer asked for that we lack.
 */
function matchSize(text, sizes) {
  const list = uniqueTrimmed(sizes);
  if (!list.length) return { matched: null, requestedUnavailable: null };

  const canonToOriginal = new Map();
  for (const s of list) canonToOriginal.set(canonicalSize(s), s);

  const tokens = tokenize(text);
  // Two-word phrases first so "extra large" resolves to XL before the bare
  // token "large" can grab L.
  const phrases = twoWordPhrases(tokens).concat(tokens);

  let matched = null;
  let requestedUnavailable = null;

  for (const phrase of phrases) {
    const canon = canonicalSize(phrase);
    if (!canon) continue;
    const isKnownSizeWord = SIZE_ALIASES.has(normalize(phrase)) || /^\d{1,3}$/.test(canon);
    if (canonToOriginal.has(canon)) {
      matched = canonToOriginal.get(canon);
      break; // an in-stock match wins outright
    }
    // Only treat a token as an "unavailable size request" when it is clearly a
    // size word/number — never a random word from the sentence.
    if (isKnownSizeWord && !requestedUnavailable) {
      requestedUnavailable = phrase;
    }
  }

  return { matched, requestedUnavailable };
}

/**
 * Find which available colour the message refers to, and whether the customer
 * named a colour we DON'T carry.
 * @returns {{ matched: string|null, requestedUnavailable: string|null }}
 */
function matchColor(text, colors) {
  const list = uniqueTrimmed(colors);
  if (!list.length) return { matched: null, requestedUnavailable: null };

  const norm = normalize(text);
  const canonToOriginal = new Map();
  for (const c of list) canonToOriginal.set(canonicalColor(c), c);

  // 1) Direct / synonym match against an available colour (supports multi-word).
  for (const [canon, original] of canonToOriginal) {
    if (canon && containsPhrase(norm, canon)) {
      return { matched: original, requestedUnavailable: null };
    }
  }
  // Synonyms in the message that map onto an available colour (e.g. "gray" → grey).
  for (const token of tokenize(text)) {
    const canon = canonicalColor(token);
    if (canon && canonToOriginal.has(canon)) {
      return { matched: canonToOriginal.get(canon), requestedUnavailable: null };
    }
  }

  // 2) Customer named a known colour we simply don't stock.
  for (const token of tokenize(text)) {
    if (COLOR_LEXICON.has(token)) {
      return { matched: null, requestedUnavailable: canonicalColor(token) };
    }
  }

  return { matched: null, requestedUnavailable: null };
}

/** Whole-word / phrase containment ("navy" matches "navy blue jacket", not "navynne"). */
function containsPhrase(normalizedText, phrase) {
  if (!phrase) return false;
  const re = new RegExp(`(^|\\s)${escapeRegExp(phrase)}(\\s|$)`);
  return re.test(normalizedText);
}

function twoWordPhrases(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Intent: pure availability question ───────────────────────────────────────

const AVAILABILITY_CUES = /\b(what|which|any|available|avail|have|having|got|do you|options?|list|show|kaun|konsi|kaunse)\b/;
const VARIANT_NOUNS = /\b(size|sizes|colou?r|colou?rs|variant|variants|option|options|shade|shades)\b/;

/** True when the message is asking what variants exist (not stating a choice). */
function isAvailabilityQuery(text) {
  const norm = normalize(text);
  if (!norm) return false;
  return VARIANT_NOUNS.test(norm) && AVAILABILITY_CUES.test(norm);
}

// ── Copy builders ────────────────────────────────────────────────────────────

/** "Sizes: S, M, L" / "Colours: Red, Blue" — only for dimensions that exist. */
function buildAvailabilityText(product) {
  const sizes = availableSizes(product);
  const colors = availableColors(product);
  const parts = [];
  if (sizes.length) parts.push(`📦 Sizes: ${sizes.join(', ')}`);
  if (colors.length) parts.push(`🎨 Colours: ${colors.join(', ')}`);

  if (!parts.length) {
    return 'This product comes in one standard option. 😊';
  }
  if (isOutOfStock(product)) {
    return `Here's what this comes in:\n${parts.join('\n')}\n\n⚠️ It's currently out of stock — reply "notify" and we'll message you when it's back. 🙏`;
  }
  return `Here's what's available:\n${parts.join('\n')}\n\nWhich one would you like? 😊`;
}

/**
 * Ask the customer for whatever variant dimension(s) are still missing, echoing
 * the choices. `missing` is a subset of ['size','color'].
 */
function buildAskVariantText(product, missing, partial = {}) {
  const asks = [];
  if (missing.includes('size')) {
    const sizes = availableSizes(product);
    if (sizes.length) asks.push(`size (${sizes.join(', ')})`);
  }
  if (missing.includes('color')) {
    const colors = availableColors(product);
    if (colors.length) asks.push(`colour (${colors.join(', ')})`);
  }
  if (!asks.length) return null;

  const chosen = summarizeVariant(partial);
  const lead = chosen ? `Got it — ${chosen}. ` : '';
  const list = asks.length === 1 ? asks[0] : `${asks.slice(0, -1).join(', ')} and ${asks[asks.length - 1]}`;
  return `${lead}Which ${list} would you like? Reply with your choice and I'll get your order ready. 🛍️`;
}

/**
 * Tell the customer the exact size/colour they asked for isn't available, and
 * list what is. `req` is { size?, color? } of the unavailable requests.
 */
function buildUnavailableText(product, req = {}) {
  const lines = [];
  if (req.size) {
    const sizes = availableSizes(product);
    lines.push(sizes.length
      ? `Sorry, size "${req.size}" isn't available. We have: ${sizes.join(', ')}.`
      : `Sorry, this product doesn't come in different sizes.`);
  }
  if (req.color) {
    const colors = availableColors(product);
    lines.push(colors.length
      ? `Sorry, "${req.color}" isn't available. We have: ${colors.join(', ')}.`
      : `Sorry, this product doesn't come in different colours.`);
  }
  lines.push('');
  lines.push('Which of these would you like? 😊');
  return lines.join('\n');
}

/** "size M / Red" — human summary of a selection (only present fields). */
function summarizeVariant(variant) {
  if (!variant) return '';
  const parts = [];
  if (variant.size) parts.push(`size ${variant.size}`);
  if (variant.color) parts.push(variant.color);
  return parts.join(' / ');
}

// ── Orchestrator used by the agent ───────────────────────────────────────────

/**
 * Given the product, any variant already captured on the conversation state, and
 * the customer's latest message, decide what the agent should do next before it
 * can take payment.
 *
 * @param {object} product   product-like ({ sizes, colors, stock })
 * @param {object} prior     previously captured selection { size, color } (may be empty)
 * @param {string} text      customer's latest message
 * @returns {{
 *   status: 'complete'|'incomplete'|'unavailable'|'out_of_stock',
 *   variant: { size: string|null, color: string|null },
 *   missing: string[],
 *   message: string|null
 * }}
 *   - complete     → variant is fully chosen + in stock; proceed to payment.
 *   - incomplete   → ask for `missing` dimensions (message set).
 *   - unavailable  → customer asked for something we don't carry (message set).
 *   - out_of_stock → product is out of stock (message set).
 */
function resolveVariantForPayment(product, prior, text) {
  const { needsSize, needsColor, hasVariants } = variantDimensions(product);

  // No variant dimensions at all → nothing to choose.
  if (!hasVariants) {
    if (isOutOfStock(product)) {
      return {
        status: 'out_of_stock',
        variant: { size: null, color: null },
        missing: [],
        message: `Sorry, this product is currently out of stock. Reply "notify" and we'll let you know the moment it's back! 🙏`
      };
    }
    return { status: 'complete', variant: { size: null, color: null }, missing: [], message: null };
  }

  const priorSel = prior || {};
  const sizeMatch = needsSize ? matchSize(text, product.sizes) : { matched: null, requestedUnavailable: null };
  const colorMatch = needsColor ? matchColor(text, product.colors) : { matched: null, requestedUnavailable: null };

  // Customer explicitly requested a variant we don't carry → correct them first.
  const badReq = {};
  if (needsSize && sizeMatch.requestedUnavailable && !sizeMatch.matched) badReq.size = sizeMatch.requestedUnavailable;
  if (needsColor && colorMatch.requestedUnavailable && !colorMatch.matched) badReq.color = colorMatch.requestedUnavailable;
  if (badReq.size || badReq.color) {
    return {
      status: 'unavailable',
      variant: mergedVariant(priorSel, sizeMatch, colorMatch),
      missing: [],
      message: buildUnavailableText(product, badReq)
    };
  }

  const variant = mergedVariant(priorSel, sizeMatch, colorMatch);

  if (isOutOfStock(product)) {
    return {
      status: 'out_of_stock',
      variant,
      missing: [],
      message: `Sorry, ${summarizeVariant(variant) || 'this product'} is currently out of stock. Reply "notify" and we'll message you when it's back! 🙏`
    };
  }

  const missing = [];
  if (needsSize && !variant.size) missing.push('size');
  if (needsColor && !variant.color) missing.push('color');

  if (missing.length) {
    return {
      status: 'incomplete',
      variant,
      missing,
      message: buildAskVariantText(product, missing, variant)
    };
  }

  return { status: 'complete', variant, missing: [], message: null };
}

/** Merge prior selection with fresh matches (fresh message wins). */
function mergedVariant(prior, sizeMatch, colorMatch) {
  return {
    size: (sizeMatch && sizeMatch.matched) || prior.size || null,
    color: (colorMatch && colorMatch.matched) || prior.color || null
  };
}

/** Append chosen variant to a payment URL as query params (safe, encoded). */
function appendVariantToUrl(url, variant) {
  if (!url || !variant) return url;
  const params = [];
  if (variant.size) params.push(`size=${encodeURIComponent(variant.size)}`);
  if (variant.color) params.push(`color=${encodeURIComponent(variant.color)}`);
  if (!params.length) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${params.join('&')}`;
}

module.exports = {
  // introspection
  variantDimensions,
  availableSizes,
  availableColors,
  isOutOfStock,
  // matching
  matchSize,
  matchColor,
  canonicalSize,
  canonicalColor,
  isAvailabilityQuery,
  // orchestration
  resolveVariantForPayment,
  // copy
  buildAvailabilityText,
  buildAskVariantText,
  buildUnavailableText,
  summarizeVariant,
  appendVariantToUrl,
  // low-level (exported for tests)
  normalize
};
