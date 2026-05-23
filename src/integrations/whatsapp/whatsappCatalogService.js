/**
 * WhatsApp Commerce Catalog Service
 *
 * Wraps Meta Graph API endpoints for:
 *   - Reading / updating WhatsApp Commerce Settings (catalog link)
 *   - CRUD on individual catalog product items
 *   - Batch sync via items_batch (up to 1000 items per call)
 *   - Sending interactive product / product-list messages from the inbox
 *
 * All methods accept a `connection` (PlatformConnection document or lean object)
 * so credentials are per-tenant, not from env.
 *
 * Meta Catalog API docs:
 *   https://developers.facebook.com/docs/marketing-api/catalog/
 * WhatsApp Commerce docs:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sell-products-and-services
 */

const axios = require('axios');
const logger = require('../../config/logger');

const API_VERSION = 'v23.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// ── Internal helpers ──────────────────────────────────────────────────────────

function _token(connection) {
  return connection?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
}

function _phoneNumberId(connection) {
  return (
    connection?.platformData?.phoneNumberId ||
    connection?.platformUserId ||
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

function _authHeader(connection) {
  return { Authorization: `Bearer ${_token(connection)}` };
}

function _jsonHeaders(connection) {
  return {
    Authorization: `Bearer ${_token(connection)}`,
    'Content-Type': 'application/json'
  };
}

/** Currencies without fractional units — Meta price is whole units, not ×100. */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF']);

/**
 * Resolve retailer_id — always a plain string (sku preferred, else Mongo _id).
 */
function _resolveRetailerId(product) {
  if (product.sku && String(product.sku).trim()) {
    return String(product.sku).trim();
  }
  const id = product._id;
  if (!id) return '';
  if (typeof id === 'string') return id;
  if (typeof id.toString === 'function') return id.toString();
  return String(id);
}

/** Effective sell price after discountPercent, if any. */
function _effectivePrice(product) {
  const base = Number(product.price);
  if (!Number.isFinite(base) || base < 0) return 0;
  const discount = Number(product.discountPercent || 0);
  if (discount > 0 && discount <= 100) {
    return +(base * (1 - discount / 100)).toFixed(2);
  }
  return base;
}

/**
 * POST /{catalog-id}/products expects `price` as a number in the currency's
 * smallest unit (e.g. 49.99 AED → 4999). NOT a string like "4999 AED".
 */
function _priceMinorUnits(amount, currency = 'AED') {
  const cur = (currency || 'AED').toUpperCase();
  const num = Number(amount);
  if (!Number.isFinite(num) || num < 0) return 0;
  if (ZERO_DECIMAL_CURRENCIES.has(cur)) return Math.round(num);
  return Math.round(num * 100);
}

/**
 * items_batch expects price as "amount CURRENCY" string, e.g. "49.99 AED".
 */
function _formatBatchPriceString(amount, currency = 'AED') {
  const cur = (currency || 'AED').toUpperCase();
  const num = Number(amount);
  const safe = Number.isFinite(num) && num >= 0 ? num : 0;
  return `${safe.toFixed(2)} ${cur}`;
}

function _productLink(product) {
  const url = product.paymentUrl && String(product.paymentUrl).trim();
  if (url && /^https:\/\//i.test(url)) return url;
  return 'https://example.com';
}

function _productImageUrl(product) {
  const url = product.images?.[0] && String(product.images[0]).trim();
  if (url && /^https:\/\//i.test(url)) return url;
  return '';
}

/**
 * Payload for POST /{catalog-id}/products (single-item upsert).
 */
function _buildMetaProductPayload(product) {
  const retailerId = _resolveRetailerId(product);
  const currency = (product.currency || 'AED').toUpperCase();
  const priceAmount = _effectivePrice(product);

  const payload = {
    retailer_id: retailerId,
    name: String(product.name || 'Product').substring(0, 200),
    description: String(product.description || product.name || 'Product').substring(0, 5000),
    price: _priceMinorUnits(priceAmount, currency),
    currency,
    url: _productLink(product),
    availability: product.stock === 0 ? 'out of stock' : 'in stock',
    condition: 'new'
  };

  const imageUrl = _productImageUrl(product);
  if (imageUrl) payload.image_url = imageUrl;

  return payload;
}

/**
 * Data block for items_batch (batch sync). Field names differ from /products.
 */
function _buildBatchProductData(product) {
  const id = _resolveRetailerId(product);
  const currency = (product.currency || 'AED').toUpperCase();
  const priceAmount = _effectivePrice(product);

  const data = {
    id,
    title: String(product.name || 'Product').substring(0, 200),
    description: String(product.description || product.name || 'Product').substring(0, 5000),
    price: _formatBatchPriceString(priceAmount, currency),
    availability: product.stock === 0 ? 'out of stock' : 'in stock',
    condition: 'new',
    link: _productLink(product)
  };

  const imageUrl = _productImageUrl(product);
  if (imageUrl) data.image_link = imageUrl;

  return data;
}

/**
 * Read the catalog ID Meta has linked to this WhatsApp phone number.
 * This is the authoritative source — more reliable than GET /{catalog-id}.
 */
async function getLinkedCatalogId(connection) {
  const settings = await getCommerceSettings(connection);
  return settings.catalogId ? String(settings.catalogId) : null;
}

/**
 * Resolve which catalog ID to use for sync.
 * Prefers Meta's whatsapp_commerce_settings.catalog_id over locally stored value.
 */
async function resolveCatalogIdForSync(connection) {
  const stored = connection?.platformData?.catalogId
    ? String(connection.platformData.catalogId).trim()
    : null;

  let metaCatalogId = null;
  try {
    metaCatalogId = await getLinkedCatalogId(connection);
  } catch (err) {
    logger.warn('[whatsappCatalogService] Could not read commerce settings', {
      error: err.message
    });
  }

  const catalogId = metaCatalogId || stored;
  if (!catalogId) {
    return {
      catalogId: null,
      error: 'No catalog linked to this WhatsApp number. Enter your Catalog ID in WhatsApp Catalog settings and save.',
      hint: 'Meta Commerce Manager → Catalogs → copy Catalog ID → paste in RepMeUp → Save.'
    };
  }

  if (metaCatalogId && stored && metaCatalogId !== stored) {
    logger.info('[whatsappCatalogService] Using Meta-linked catalog id over stored value', {
      metaCatalogId,
      stored
    });
  }

  return { catalogId, metaCatalogId, stored };
}

/**
 * Verify catalog is ready for product sync.
 * Uses whatsapp_commerce_settings (works with WhatsApp Cloud API tokens).
 * Does NOT GET /{catalog-id} — that endpoint often returns "Unsupported get request"
 * for WhatsApp system-user tokens even when sync works fine.
 */
async function verifyCatalogAccess(connection, catalogId) {
  if (!catalogId) {
    return { valid: false, error: 'Catalog ID is not configured' };
  }

  try {
    const settings = await getCommerceSettings(connection);
    const linkedId = settings.catalogId ? String(settings.catalogId) : null;

    if (linkedId) {
      return {
        valid: true,
        id: linkedId,
        isCatalogVisible: settings.isCatalogVisible,
        isCartEnabled: settings.isCartEnabled,
        source: 'commerce_settings'
      };
    }

    // Commerce settings readable but no catalog linked yet — user must save settings
    return {
      valid: false,
      error: 'Catalog is not linked to your WhatsApp number in Meta yet.',
      hint: 'Go to Catalog → WhatsApp Catalog, enter your Catalog ID, click Save, then sync again.'
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    // If we cannot read commerce settings, allow sync attempt with stored catalog id
    // (updateCommerceSettings may have succeeded earlier).
    logger.warn('[whatsappCatalogService] verifyCatalogAccess fallback to stored catalogId', {
      catalogId,
      error: msg
    });
    return {
      valid: true,
      id: String(catalogId),
      source: 'stored_fallback',
      warning: msg
    };
  }
}

// ── Commerce Settings ─────────────────────────────────────────────────────────

/**
 * Retrieve current WhatsApp Commerce settings for the phone number.
 * @param {object} connection
 * @returns {Promise<{ catalogId, isCatalogVisible, isCartEnabled }>}
 */
async function getCommerceSettings(connection) {
  const phoneNumberId = _phoneNumberId(connection);
  try {
    const res = await axios.get(
      `${BASE_URL}/${phoneNumberId}/whatsapp_commerce_settings`,
      { headers: _authHeader(connection), timeout: 15000 }
    );
    const data = res.data?.data?.[0] || res.data || {};
    return {
      catalogId: data.catalog_id || null,
      isCatalogVisible: data.is_catalog_visible ?? false,
      isCartEnabled: data.is_cart_enabled ?? false
    };
  } catch (err) {
    logger.error('[whatsappCatalogService] getCommerceSettings failed', {
      error: err.response?.data?.error?.message || err.message
    });
    throw new Error(err.response?.data?.error?.message || 'Failed to get WhatsApp commerce settings');
  }
}

/**
 * Link a Meta Catalog to this WhatsApp phone number and make it visible.
 * @param {object} connection
 * @param {string} catalogId  Meta Commerce Catalog ID
 */
async function updateCommerceSettings(connection, catalogId) {
  const phoneNumberId = _phoneNumberId(connection);
  try {
    const res = await axios.post(
      `${BASE_URL}/${phoneNumberId}/whatsapp_commerce_settings`,
      { catalog_id: catalogId, is_catalog_visible: true, is_cart_enabled: true },
      { headers: _jsonHeaders(connection), timeout: 15000 }
    );
    return { success: true, data: res.data };
  } catch (err) {
    logger.error('[whatsappCatalogService] updateCommerceSettings failed', {
      error: err.response?.data?.error?.message || err.message
    });
    throw new Error(err.response?.data?.error?.message || 'Failed to update WhatsApp commerce settings');
  }
}

// ── Catalog Product Item CRUD ─────────────────────────────────────────────────

/**
 * Create or update a single product in the Meta catalog via items_batch.
 * Uses retailer_id as the idempotency key — Meta updates the item if it already exists.
 *
 * Note: WhatsApp Cloud API tokens often reject POST /{catalog-id}/products and
 * GET /{catalog-id}. items_batch + whatsapp_commerce_settings are the supported paths.
 *
 * @param {object} connection
 * @param {string} catalogId
 * @param {object} product  Mongoose Product document or plain object
 * @returns {Promise<{ id: string, batchHandle?: string }>}
 */
async function upsertProduct(connection, catalogId, product) {
  const retailerId = _resolveRetailerId(product);
  const data = _buildBatchProductData(product);

  if (!retailerId) {
    throw new Error('Product must have a sku or _id to use as retailer_id');
  }
  const amount = _effectivePrice(product);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Product price is invalid — set a numeric price before syncing');
  }

  try {
    const res = await axios.post(
      `${BASE_URL}/${catalogId}/items_batch`,
      {
        allow_upsert: true,
        item_type: 'PRODUCT_ITEM',
        requests: [{ method: 'UPDATE', data }]
      },
      { headers: _jsonHeaders(connection), timeout: 60000 }
    );

    const validation = res.data?.validation_status || [];
    const entry = validation.find((v) => v.retailer_id === retailerId) || validation[0];
    const errors = entry?.errors || [];
    if (errors.length > 0) {
      const errMsg = errors.map((e) => e.message).join('; ');
      throw new Error(errMsg);
    }

    // WhatsApp send uses retailer_id — Meta batch returns handles, not always item ids
    return { id: retailerId, batchHandle: res.data?.handles?.[0] || null };
  } catch (err) {
    const apiMsg = err.response?.data?.error?.message || err.message;
    logger.error('[whatsappCatalogService] upsertProduct failed', {
      retailerId,
      catalogId,
      price: data.price,
      error: apiMsg
    });
    throw new Error(apiMsg || 'Failed to sync product to WhatsApp catalog');
  }
}

/**
 * Delete a product item from Meta catalog.
 * @param {object} connection
 * @param {string} catalogItemId  Meta product item id (from whatsapp.catalogItemId)
 */
async function deleteProduct(connection, catalogItemId) {
  try {
    await axios.delete(
      `${BASE_URL}/${catalogItemId}`,
      { headers: _authHeader(connection), timeout: 15000 }
    );
    return { success: true };
  } catch (err) {
    logger.error('[whatsappCatalogService] deleteProduct failed', {
      catalogItemId,
      error: err.response?.data?.error?.message || err.message
    });
    throw new Error(err.response?.data?.error?.message || 'Failed to delete product from WhatsApp catalog');
  }
}

// ── Batch Sync ────────────────────────────────────────────────────────────────

/**
 * Batch-sync up to 1000 products to Meta catalog using items_batch API.
 * Returns per-item results so the caller can update sync statuses in bulk.
 *
 * @param {object} connection
 * @param {string} catalogId
 * @param {Array}  products   Array of Mongoose Product documents or plain objects
 * @returns {Promise<{ results: Array<{ retailerId, success, id?, error? }> }>}
 */
async function batchSync(connection, catalogId, products) {
  if (!products || products.length === 0) return { results: [] };

  const CHUNK = 500;
  const allResults = [];

  for (let i = 0; i < products.length; i += CHUNK) {
    const chunk = products.slice(i, i + CHUNK);
    const requests = chunk.map((p) => ({
      method: 'UPDATE',
      data: _buildBatchProductData(p)
    }));

    try {
      const res = await axios.post(
        `${BASE_URL}/${catalogId}/items_batch`,
        {
          allow_upsert: true,
          item_type: 'PRODUCT_ITEM',
          requests
        },
        { headers: _jsonHeaders(connection), timeout: 120000 }
      );

      const validation = res.data?.validation_status || [];
      const validationByRetailer = {};
      validation.forEach((v) => {
        if (v.retailer_id) validationByRetailer[v.retailer_id] = v;
      });

      chunk.forEach((p) => {
        const retailerId = _resolveRetailerId(p);
        const productId = p._id != null ? String(p._id) : '';
        const v = validationByRetailer[retailerId];
        const errors = v?.errors || [];
        if (errors.length > 0) {
          allResults.push({
            retailerId,
            productId,
            success: false,
            error: errors.map((e) => e.message).join('; ')
          });
        } else {
          allResults.push({
            retailerId,
            productId,
            success: true,
            handle: res.data?.handles?.[0] || null
          });
        }
      });
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      logger.error('[whatsappCatalogService] batchSync chunk failed', { error: errMsg, catalogId });
      chunk.forEach((p) => {
        allResults.push({
          retailerId: _resolveRetailerId(p),
          productId: p._id?.toString?.() || String(p._id),
          success: false,
          error: errMsg
        });
      });
    }
  }

  return { results: allResults };
}

// ── Inbox: Send Product Messages ──────────────────────────────────────────────

/**
 * Send a single product interactive message.
 * The recipient sees a product card from the linked catalog.
 *
 * @param {object} connection
 * @param {string} to          Recipient phone (E.164)
 * @param {string} catalogId
 * @param {string} retailerId  product.sku or product._id.toString()
 * @param {string} [bodyText]  Optional message body shown above the product card
 */
async function sendProductMessage(connection, to, catalogId, retailerId, bodyText = '') {
  const phoneNumberId = _phoneNumberId(connection);
  try {
    const interactive = {
      type: 'product',
      body: bodyText ? { text: bodyText } : undefined,
      action: {
        catalog_id: catalogId,
        product_retailer_id: retailerId
      }
    };
    if (!interactive.body) delete interactive.body;

    const res = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive
      },
      { headers: _jsonHeaders(connection), timeout: 15000 }
    );
    return { success: true, messageId: res.data?.messages?.[0]?.id };
  } catch (err) {
    logger.error('[whatsappCatalogService] sendProductMessage failed', {
      error: err.response?.data?.error?.message || err.message
    });
    throw new Error(err.response?.data?.error?.message || 'Failed to send WhatsApp product message');
  }
}

/**
 * Send a product list (multi-product) interactive message.
 * Supports up to 30 products grouped into sections.
 *
 * @param {object} connection
 * @param {string} to
 * @param {string} catalogId
 * @param {Array}  sections   [{ title: string, productRetailerIds: string[] }]
 * @param {string} [headerText]
 * @param {string} [bodyText]
 * @param {string} [footerText]
 */
async function sendProductListMessage(
  connection,
  to,
  catalogId,
  sections,
  headerText = '',
  bodyText = 'Check out our products',
  footerText = ''
) {
  const phoneNumberId = _phoneNumberId(connection);
  try {
    const interactive = {
      type: 'product_list',
      header: headerText ? { type: 'text', text: headerText } : undefined,
      body: { text: bodyText },
      footer: footerText ? { text: footerText } : undefined,
      action: {
        catalog_id: catalogId,
        sections: sections.map(s => ({
          title: s.title || 'Products',
          product_items: (s.productRetailerIds || []).map(id => ({
            product_retailer_id: id
          }))
        }))
      }
    };
    if (!interactive.header) delete interactive.header;
    if (!interactive.footer) delete interactive.footer;

    const res = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive
      },
      { headers: _jsonHeaders(connection), timeout: 15000 }
    );
    return { success: true, messageId: res.data?.messages?.[0]?.id };
  } catch (err) {
    logger.error('[whatsappCatalogService] sendProductListMessage failed', {
      error: err.response?.data?.error?.message || err.message
    });
    throw new Error(err.response?.data?.error?.message || 'Failed to send WhatsApp product list message');
  }
}

module.exports = {
  getCommerceSettings,
  updateCommerceSettings,
  getLinkedCatalogId,
  resolveCatalogIdForSync,
  verifyCatalogAccess,
  upsertProduct,
  deleteProduct,
  batchSync,
  sendProductMessage,
  sendProductListMessage,
  // exported for unit tests
  _buildMetaProductPayload,
  _buildBatchProductData,
  _resolveRetailerId,
  _priceMinorUnits
};
