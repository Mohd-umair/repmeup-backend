'use strict';

/**
 * Product Search Service
 *
 * Resolves the most relevant products for an AI prompt, mirroring the pattern
 * of knowledgeBaseSearchService.js. Provides org-scoped product retrieval by
 * text query, category, or Instagram post ID so AI can suggest products in the
 * inbox without scanning the full catalog.
 *
 * Search strategy (in order):
 *   1. MongoDB $text search on name + description (fastest, most relevant)
 *   2. Keyword / name regex match — catches partial-word and multi-language queries
 *   3. Category filter fallback — returns active products sorted by price
 */

const Product = require('../../models/Product');
const logger = require('../../config/logger');
const { escapeRegex } = require('../../utils/sanitize');

const MAX_PRODUCT_CHARS = 400;

/**
 * Build a concise text snippet for a single product for use inside an AI prompt.
 * Includes image availability, colors, and sizes so the AI never has to guess.
 * Keeps token usage low by capping at MAX_PRODUCT_CHARS.
 *
 * @param {object} product
 * @returns {string}
 */
function formatProductForPrompt(product) {
  const price = product.discountPercent
    ? `${product.currency} ${product.price} (${product.discountPercent}% off → ${(product.price * (1 - product.discountPercent / 100)).toFixed(2)})`
    : `${product.currency} ${product.price}`;
  const stock = product.stock == null ? 'in stock' : product.stock > 0 ? `${product.stock} in stock` : 'out of stock';
  const sku = product.sku ? ` [SKU: ${product.sku}]` : '';
  const desc = product.description
    ? ` — ${product.description.substring(0, 120)}${product.description.length > 120 ? '…' : ''}`
    : '';

  // Image availability — explicit so the AI is never tempted to claim/deny an image
  const images = Array.isArray(product.images) ? product.images : [];
  const hasValidImage = images.some((img) => {
    const url = typeof img === 'string' ? img : img?.url || img?.src || '';
    return typeof url === 'string' && url.startsWith('https://');
  });
  const imageNote = hasValidImage ? 'image: available' : 'image: not available';

  // Colors and sizes — always ground the AI in real catalog facts
  const colors = Array.isArray(product.colors) && product.colors.length > 0
    ? `colors: ${product.colors.slice(0, 8).join(', ')}`
    : 'colors: not specified';
  const sizes = Array.isArray(product.sizes) && product.sizes.length > 0
    ? `sizes: ${product.sizes.slice(0, 8).join(', ')}`
    : 'sizes: not specified';

  return `${product.name}${sku}: ${price}, ${stock}, ${imageNote}, ${colors}, ${sizes}${desc}`.substring(0, MAX_PRODUCT_CHARS);
}

/**
 * Search the org's product catalog for items matching a free-text query.
 *
 * @param {string} organizationId
 * @param {string} query         - Customer message or topic
 * @param {object} [opts]
 * @param {number} [opts.limit=5]            - Max products to return
 * @param {string} [opts.instagramPostId]    - Filter to product(s) linked to this post
 * @returns {Promise<{ products: Array, fromFallback: boolean }>}
 */
async function searchProducts(organizationId, query, {
  limit = 5,
  instagramPostId = null
} = {}) {
  try {
    const base = { organization: organizationId, isActive: true };

    // If we know which post triggered the conversation, constrain to products for that post.
    if (instagramPostId) {
      base.instagramPostIds = instagramPostId;
    }

    const trimmed = (query && String(query).trim()) || '';

    // Fields that ground the AI: image availability, colors, sizes, plus commerce info
    const PRODUCT_FIELDS = 'name sku description price currency discountPercent stock images colors sizes paymentUrl';

    // 1. MongoDB text search
    if (trimmed) {
      let textResults = [];
      try {
        textResults = await Product.find({ ...base, $text: { $search: trimmed } })
          .select(PRODUCT_FIELDS)
          .sort({ score: { $meta: 'textScore' } })
          .limit(limit)
          .lean();
      } catch (textErr) {
        logger.warn('[productSearchService] Text search skipped (no index?)', { error: textErr.message });
      }

      if (textResults.length > 0) {
        return { products: textResults, fromFallback: false };
      }

      // 2. Regex match on name/description
      const queryWords = trimmed
        .split(/\s+/)
        .map((w) => w.normalize('NFC').replace(/[\p{P}\p{S}]+/gu, '').toLowerCase())
        .filter((w) => w.length >= 2)
        .slice(0, 8);

      if (queryWords.length > 0) {
        const escaped = queryWords.map((w) => escapeRegex(w));
        const regexResults = await Product.find({
          ...base,
          $or: [
            { name: { $regex: escaped.join('|'), $options: 'i' } },
            { description: { $regex: escaped.join('|'), $options: 'i' } },
            { sku: { $regex: escaped.join('|'), $options: 'i' } }
          ]
        })
          .select(PRODUCT_FIELDS)
          .sort({ price: 1 })
          .limit(limit)
          .lean();

        if (regexResults.length > 0) {
          return { products: regexResults, fromFallback: false };
        }
      }
    }

    // 3. Fallback — fromFallback:true signals to the caller that these are NOT a match for the query.
    // The caller should NOT present these to the customer as relevant results.
    const fallback = await Product.find(base)
      .select(PRODUCT_FIELDS)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return { products: fallback, fromFallback: true };
  } catch (err) {
    logger.error('[productSearchService] search error', { error: err.message });
    return { products: [], fromFallback: false };
  }
}

/**
 * Format a product array into a compact block for injection into an AI prompt.
 * Cap at `maxProducts` and `MAX_PRODUCT_CHARS` per item to stay under token budget.
 *
 * @param {Array}  products
 * @param {number} [maxProducts=3]
 * @returns {string}
 */
function buildProductPromptBlock(products, maxProducts = 3) {
  const slice = products.slice(0, maxProducts);
  if (slice.length === 0) return '';
  return slice.map(formatProductForPrompt).join('\n');
}

module.exports = {
  searchProducts,
  buildProductPromptBlock,
  formatProductForPrompt
};
