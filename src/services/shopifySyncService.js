'use strict';

/**
 * shopifySyncService
 *
 * Handles all Shopify data synchronisation:
 *  - Full backfill (runFullSync)        — called once on connect, then every 6h as a safety net
 *  - Webhook-driven topic upserts       — via handleWebhookTopic
 *
 * Exposes individual upsert helpers so the webhook processor can call them directly.
 */

const logger = require('../config/logger');
const Product = require('../models/Product');
const CommerceOrder = require('../models/CommerceOrder');
const PlatformConnection = require('../models/PlatformConnection');
const { resolveContact } = require('./contactService');
const {
  fetchAllProducts,
  fetchAllCustomers,
  fetchAllOrders,
  verifyAccessScopes,
  formatMissingScopesError,
  isForbiddenError,
  mapShopifyProductVariants,
  mapShopifyCustomerToContactPayload,
  mapShopifyOrderToCommerceOrder
} = require('../integrations/shopify/shopifyService');

// ─── Product upserts ──────────────────────────────────────────────────────────

/**
 * Upsert a single Shopify product (all its variants) into the Product collection.
 * Uses the sparse unique index on { organization, shopify.productId, shopify.variantId }.
 */
async function upsertProductFromShopify(shopifyProduct, organizationId, shopDomain) {
  const variants = mapShopifyProductVariants(shopifyProduct, shopDomain);

  const bulkOps = variants.map(payload => {
    const filter = payload.shopify?.productId && payload.shopify?.variantId
      ? { organization: organizationId, 'shopify.productId': payload.shopify.productId, 'shopify.variantId': payload.shopify.variantId }
      : payload.sku
        ? { organization: organizationId, sku: payload.sku }
        : { organization: organizationId, name: payload.name };

    const update = {
      $set: {
        name: payload.name,
        description: payload.description,
        price: payload.price,
        currency: payload.currency,
        discountPercent: payload.discountPercent,
        stock: payload.stock,
        paymentUrl: payload.paymentUrl,
        websiteUrl: payload.websiteUrl,
        images: payload.images,
        sizes: payload.sizes,
        colors: payload.colors,
        source: 'shopify',
        isActive: true,
        shopify: payload.shopify
      }
    };

    if (payload.sku) update.$set.sku = payload.sku;
    if (payload.commerce && typeof payload.commerce === 'object') {
      for (const [key, value] of Object.entries(payload.commerce)) {
        if (value !== undefined && value !== null && value !== '') {
          update.$set[`commerce.${key}`] = value;
        }
      }
    }

    return { updateOne: { filter, update, upsert: true } };
  });

  if (bulkOps.length === 0) return;
  await Product.bulkWrite(bulkOps, { ordered: false });
}

/**
 * Remove all product records for a Shopify product GID.
 */
async function deleteProductByShopifyId(shopifyProductId, organizationId) {
  const gid = shopifyProductId.startsWith('gid://')
    ? shopifyProductId
    : `gid://shopify/Product/${shopifyProductId}`;

  const result = await Product.deleteMany({ organization: organizationId, 'shopify.productId': gid });
  logger.info(`[shopifySyncService] Deleted ${result.deletedCount} product(s) for shopifyProductId=${gid}`);
  return result;
}

// ─── Contact upserts ──────────────────────────────────────────────────────────

/**
 * Resolve (create or update) a contact from a Shopify customer object.
 * Delegates dedup logic (phone → email → channel) to contactService.resolveContact.
 */
async function upsertContactFromShopifyCustomer(shopifyCustomer, organizationId) {
  const payload = mapShopifyCustomerToContactPayload(shopifyCustomer);
  try {
    const contact = await resolveContact(payload, organizationId, { enforce: 'soft' });
    return contact;
  } catch (err) {
    logger.warn('[shopifySyncService] resolveContact failed for Shopify customer', {
      customerId: shopifyCustomer.id,
      error: err.message
    });
    return null;
  }
}

// ─── Order upserts ────────────────────────────────────────────────────────────

/**
 * Idempotently upsert a Shopify order into CommerceOrder.
 * Keyed on { organization, shopifyOrderId }.
 */
async function upsertOrderFromShopifyOrder(shopifyOrder, organizationId) {
  // Resolve or create the contact first (best-effort)
  let contactId = null;
  if (shopifyOrder.customer?.id) {
    const contact = await upsertContactFromShopifyCustomer(shopifyOrder.customer, organizationId);
    contactId = contact?._id || null;
  }

  const payload = mapShopifyOrderToCommerceOrder(shopifyOrder, organizationId, contactId);

  const result = await CommerceOrder.findOneAndUpdate(
    { organization: organizationId, shopifyOrderId: payload.shopifyOrderId },
    { $set: payload, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, new: true }
  );
  if (result?.contact) {
    const { onOrderUpserted } = require('./commerceMetricsService');
    onOrderUpserted(organizationId, result).catch(() => null);
  }
  return result;
}

// ─── Full backfill ────────────────────────────────────────────────────────────

/**
 * Full sync for one PlatformConnection.
 * Pages through all products, customers, and orders from Shopify and upserts each.
 * Stamps `metadata.lastFullSyncAt` on the connection when done.
 */
async function runFullSync(connection) {
  const connId = connection._id;
  const orgId = connection.organization;
  const shopDomain = connection.platformData?.shopDomain;

  logger.info(`[shopifySyncService] Starting full sync for connection ${connId} (${shopDomain})`);

  const stats = { products: 0, customers: 0, orders: 0, errors: 0 };
  let scopeError = null;

  try {
    const { missing } = await verifyAccessScopes(shopDomain, connection.accessToken);
    if (missing.length > 0) {
      scopeError = formatMissingScopesError(missing);
      throw new Error(scopeError);
    }
  } catch (e) {
    if (scopeError) throw e;
    if (isForbiddenError(e)) {
      scopeError = formatMissingScopesError(['read_products', 'read_customers', 'read_orders']);
      throw new Error(scopeError);
    }
    logger.warn('[shopifySyncService] Could not verify scopes before sync; continuing', { error: e.message });
  }

  // ── Products ────────────────────────────────────────────────────────────────
  try {
    const products = await fetchAllProducts(connection);
    for (const p of products) {
      try {
        await upsertProductFromShopify(p, orgId, shopDomain);
        stats.products++;
      } catch (e) {
        stats.errors++;
        logger.warn(`[shopifySyncService] Product upsert failed (id=${p.id})`, { error: e.message });
      }
    }
  } catch (e) {
    logger.error(`[shopifySyncService] Failed to fetch products`, {
      error: e.message,
      status: e.response?.status
    });
    stats.errors++;
    if (isForbiddenError(e)) scopeError = formatMissingScopesError(['read_products']);
  }

  // ── Customers ───────────────────────────────────────────────────────────────
  try {
    const customers = await fetchAllCustomers(connection);
    for (const c of customers) {
      try {
        await upsertContactFromShopifyCustomer(c, orgId);
        stats.customers++;
      } catch (e) {
        stats.errors++;
        logger.warn(`[shopifySyncService] Customer upsert failed (id=${c.id})`, { error: e.message });
      }
    }
  } catch (e) {
    logger.error(`[shopifySyncService] Failed to fetch customers`, {
      error: e.message,
      status: e.response?.status
    });
    stats.errors++;
    if (isForbiddenError(e)) scopeError = formatMissingScopesError(['read_customers']);
  }

  // ── Orders ──────────────────────────────────────────────────────────────────
  try {
    const orders = await fetchAllOrders(connection);
    for (const o of orders) {
      try {
        await upsertOrderFromShopifyOrder(o, orgId);
        stats.orders++;
      } catch (e) {
        stats.errors++;
        logger.warn(`[shopifySyncService] Order upsert failed (id=${o.id})`, { error: e.message });
      }
    }
  } catch (e) {
    logger.error(`[shopifySyncService] Failed to fetch orders`, {
      error: e.message,
      status: e.response?.status
    });
    stats.errors++;
    if (isForbiddenError(e)) scopeError = formatMissingScopesError(['read_orders']);
  }

  if (
    scopeError &&
    stats.products === 0 &&
    stats.customers === 0 &&
    stats.orders === 0
  ) {
    await PlatformConnection.findByIdAndUpdate(connId, {
      lastError: { message: scopeError, code: 'SHOPIFY_MISSING_SCOPES', timestamp: new Date() }
    });
    throw new Error(scopeError);
  }

  // Stamp last sync time (lastSyncAt drives the Connected Accounts UI)
  const syncedAt = new Date();
  await PlatformConnection.findByIdAndUpdate(connId, {
    lastSyncAt: syncedAt,
    'metadata.lastFullSyncAt': syncedAt,
    'metadata.lastSyncStats': stats,
    lastError: null
  });

  logger.info(`[shopifySyncService] Full sync complete for ${shopDomain}`, stats);
  return stats;
}

// ─── Webhook topic dispatcher ─────────────────────────────────────────────────

/**
 * Handle an incoming Shopify webhook topic.
 * Called by both the webhook job processor and the periodic safety-net sync.
 *
 * @param {Object} connection  PlatformConnection document (or plain object with _id, organization, platformData)
 * @param {string} topic       Shopify webhook topic, e.g. 'products/create'
 * @param {Object} payload     Parsed JSON payload from Shopify
 */
async function handleWebhookTopic(connection, topic, payload) {
  const orgId = connection.organization;
  const shopDomain = connection.platformData?.shopDomain;

  logger.info(`[shopifySyncService] handleWebhookTopic: ${topic}`, { orgId });

  switch (topic) {
    case 'products/create':
    case 'products/update':
      await upsertProductFromShopify(payload, orgId, shopDomain);
      break;

    case 'products/delete':
      if (payload?.id) {
        await deleteProductByShopifyId(String(payload.id), orgId);
      }
      break;

    case 'customers/create':
    case 'customers/update':
      await upsertContactFromShopifyCustomer(payload, orgId);
      break;

    case 'orders/create':
    case 'orders/updated':
    case 'orders/paid':
    case 'orders/cancelled':
      await upsertOrderFromShopifyOrder(payload, orgId);
      break;

    case 'app/uninstalled':
      // Mark the connection as disconnected; let admin reconnect manually
      await PlatformConnection.findByIdAndUpdate(connection._id, {
        isActive: false,
        status: 'disconnected',
        disconnectedAt: new Date(),
        'metadata.uninstalledAt': new Date()
      });
      logger.info(`[shopifySyncService] Store uninstalled app — connection deactivated (${connection._id})`);
      break;

    default:
      logger.info(`[shopifySyncService] Unhandled topic: ${topic}`);
  }
}

module.exports = {
  runFullSync,
  handleWebhookTopic,
  upsertProductFromShopify,
  upsertContactFromShopifyCustomer,
  upsertOrderFromShopifyOrder,
  deleteProductByShopifyId
};
