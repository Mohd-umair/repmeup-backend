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

/**
 * Convert our internal price (e.g. 49.99) to the Meta format string "4999 AED"
 * Meta expects price as an integer string "AMOUNT CURRENCY" where AMOUNT is in
 * the smallest currency unit for currencies with sub-units (e.g. fils/cents),
 * or just the integer for zero-decimal currencies.
 * We always multiply by 100 and round to handle standard 2-decimal currencies.
 */
function _formatMetaPrice(price, currency = 'AED') {
  const cents = Math.round(Number(price) * 100);
  return `${cents} ${currency.toUpperCase()}`;
}

/**
 * Build the product payload Meta expects for catalog items.
 * retailer_id is our product's _id (or sku when present).
 */
function _buildMetaProductPayload(product) {
  const retailerId = product.sku || product._id.toString();
  const price = _formatMetaPrice(product.price || 0, product.currency || 'AED');
  return {
    retailer_id: retailerId,
    name: product.name,
    description: product.description || product.name,
    price,
    currency: (product.currency || 'AED').toUpperCase(),
    url: product.paymentUrl || 'https://example.com',
    image_url: (product.images && product.images[0]) || '',
    availability: (product.stock === 0 ? 'out of stock' : 'in stock'),
    condition: 'new'
  };
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
 * Create or update a single product in the Meta catalog.
 * Uses retailer_id as the idempotency key — Meta updates the item if it already exists.
 * @param {object} connection
 * @param {string} catalogId
 * @param {object} product  Mongoose Product document or plain object
 * @returns {Promise<{ id: string }>} Meta product item id
 */
async function upsertProduct(connection, catalogId, product) {
  const payload = _buildMetaProductPayload(product);
  try {
    const res = await axios.post(
      `${BASE_URL}/${catalogId}/products`,
      payload,
      { headers: _jsonHeaders(connection), timeout: 30000 }
    );
    const itemId = res.data?.id;
    if (!itemId) {
      throw new Error(res.data?.error?.message || 'No product item id returned');
    }
    return { id: itemId };
  } catch (err) {
    logger.error('[whatsappCatalogService] upsertProduct failed', {
      retailerId: product.sku || product._id,
      error: err.response?.data?.error?.message || err.message
    });
    throw new Error(err.response?.data?.error?.message || 'Failed to sync product to WhatsApp catalog');
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

  const CHUNK = 1000;
  const allResults = [];

  for (let i = 0; i < products.length; i += CHUNK) {
    const chunk = products.slice(i, i + CHUNK);
    const requests = chunk.map(p => ({
      method: 'UPDATE',
      retailer_id: p.sku || p._id.toString(),
      data: _buildMetaProductPayload(p)
    }));

    try {
      const res = await axios.post(
        `${BASE_URL}/${catalogId}/items_batch`,
        { allow_upsert: true, requests },
        { headers: _jsonHeaders(connection), timeout: 120000 }
      );

      const handles = res.data?.handles || [];
      chunk.forEach((p, idx) => {
        allResults.push({
          retailerId: p.sku || p._id.toString(),
          productId: p._id.toString(),
          success: true,
          handle: handles[idx] || null
        });
      });
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      logger.error('[whatsappCatalogService] batchSync chunk failed', { error: errMsg });
      chunk.forEach(p => {
        allResults.push({
          retailerId: p.sku || p._id.toString(),
          productId: p._id.toString(),
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
  upsertProduct,
  deleteProduct,
  batchSync,
  sendProductMessage,
  sendProductListMessage
};
