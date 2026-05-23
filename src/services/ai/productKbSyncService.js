'use strict';

/**
 * Product → Knowledge Base Sync Service
 *
 * Keeps a dedicated KB entry per product so AI replies can be grounded in
 * live catalog data without needing a separate retrieval layer.
 *
 * Each product is stored as a single KB entry with:
 *   category: 'product_info'
 *   title:    product name (+ SKU)
 *   content:  structured product details
 *   keywords: name tokens + sku + category-level tags
 *
 * The entry is idempotent — upserted by (organization, type, metadata.productId).
 *
 * Called from:
 *   productController.createProduct  → syncProductToKb
 *   productController.updateProduct  → syncProductToKb
 *   productController.deleteProduct  → removeProductFromKb
 */

const KnowledgeBase = require('../../models/KnowledgeBase');
const logger = require('../../config/logger');

/**
 * Upsert a KB entry for a product.
 * Non-fatal — errors are logged and swallowed so product CRUD is never blocked.
 *
 * @param {object} product  Mongoose Product document or plain object
 */
async function syncProductToKb(product) {
  if (!product?._id || !product?.organization) return;

  const createdBy = product.createdBy?._id || product.createdBy;
  if (!createdBy) {
    logger.warn('[productKbSync] Skipping KB sync — product has no createdBy', {
      productId: String(product._id)
    });
    return;
  }

  try {
    const orgId = String(product.organization._id || product.organization);
    const productId = String(product._id);

    const price = product.discountPercent
      ? `${product.currency} ${product.price} (${product.discountPercent}% off → ${(product.price * (1 - product.discountPercent / 100)).toFixed(2)})`
      : `${product.currency || 'AED'} ${product.price}`;

    const stock = product.stock == null
      ? 'unlimited stock'
      : product.stock > 0
      ? `${product.stock} units in stock`
      : 'currently out of stock';

    const parts = [
      `Price: ${price}`,
      `Stock: ${stock}`,
      product.description ? `Description: ${product.description}` : null,
      product.sizes?.length ? `Sizes: ${product.sizes.join(', ')}` : null,
      product.colors?.length ? `Colors: ${product.colors.join(', ')}` : null,
      product.sku ? `SKU: ${product.sku}` : null,
      product.paymentUrl ? `Order link: ${product.paymentUrl}` : null
    ].filter(Boolean);

    const content = parts.join('\n');

    const keywords = [
      ...String(product.name).toLowerCase().split(/\s+/).filter((w) => w.length >= 2),
      product.sku ? String(product.sku).toLowerCase() : null
    ].filter(Boolean);

    const title = product.sku
      ? `${product.name} [${product.sku}]`
      : product.name;

    await KnowledgeBase.findOneAndUpdate(
      { organization: orgId, type: 'product_info', 'metadata.productId': productId },
      {
        $set: {
          organization: orgId,
          title,
          content,
          type: 'product_info',
          keywords,
          source: 'manual',
          'metadata.productId': productId,
          'metadata.syncSource': 'product_catalog',
          isActive: Boolean(product.isActive !== false),
          isTrainingData: true,
          priority: 5,
          trainingWeight: 5,
          updatedBy: product.updatedBy || createdBy
        },
        $setOnInsert: {
          usageCount: 0,
          createdBy
        }
      },
      { upsert: true, new: true, runValidators: true }
    );

    logger.debug('[productKbSync] KB entry synced', { productId, orgId });
  } catch (err) {
    logger.warn('[productKbSync] KB sync failed (non-fatal)', {
      productId: String(product._id),
      error: err.message
    });
  }
}

/**
 * Deactivate (soft-delete) the KB entry for a product.
 * Non-fatal.
 *
 * @param {string|object} productId
 * @param {string|object} organizationId
 */
async function removeProductFromKb(productId, organizationId) {
  try {
    const orgId = String(organizationId?._id || organizationId);
    const pid = String(productId?._id || productId);

    await KnowledgeBase.updateOne(
      { organization: orgId, type: 'product_info', 'metadata.productId': pid },
      { $set: { isActive: false } }
    );

    logger.debug('[productKbSync] KB entry deactivated', { productId: pid, orgId });
  } catch (err) {
    logger.warn('[productKbSync] KB deactivate failed (non-fatal)', {
      productId: String(productId),
      error: err.message
    });
  }
}

module.exports = {
  syncProductToKb,
  removeProductFromKb
};
