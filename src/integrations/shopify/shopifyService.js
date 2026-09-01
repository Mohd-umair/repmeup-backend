'use strict';

/**
 * Shopify Admin REST API client.
 *
 * Covers:
 *  - Token verification
 *  - Webhook registration / unregistration
 *  - Cursor-paginated product, customer, and order fetching
 *  - Field mappers: Shopify → RepMeUp canonical models
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../config/logger');
const { coerceCommerceFields, DEFAULT_CURRENCY } = require('../../utils/productCommerceFields');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shopifyBase(shopDomain) {
  const domain = shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${domain}/admin/api/${API_VERSION}`;
}

function shopifyHeaders(accessToken) {
  return { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' };
}

/**
 * Extract the next-page cursor from Shopify's Link header.
 * Returns null when there is no next page.
 */
function extractNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+page_info=([^&>\s]+)[^>]*>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Generic paginated GET over a Shopify list endpoint.
 * @param {string} url            Full URL
 * @param {object} headers        Auth headers
 * @param {object} params         Initial query params
 * @param {string} dataKey        Root key in response (e.g. 'products', 'customers', 'orders')
 * @returns {Promise<Array>}      All items across all pages
 */
async function fetchAllPages(url, headers, params, dataKey) {
  const results = [];
  let pageInfo = null;

  while (true) {
    const query = { limit: 250, ...params };
    if (pageInfo) {
      // page_info is mutually exclusive with most other filters
      delete query.status;
      delete query.fields;
      query.page_info = pageInfo;
    }

    const res = await axios.get(url, { params: query, headers, timeout: 30000 });
    const batch = res.data[dataKey] || [];
    results.push(...batch);

    pageInfo = extractNextPageInfo(res.headers['link']);
    if (!pageInfo || batch.length === 0) break;
  }

  return results;
}

// ─── Token verification ───────────────────────────────────────────────────────

/**
 * Validate a Shopify Admin API access token by fetching basic shop info.
 * Returns { shopId, shopName, shopDomain, currency } on success.
 * Throws on invalid token / unreachable store.
 */
async function verifyToken(shopDomain, accessToken) {
  const url = `${shopifyBase(shopDomain)}/shop.json`;
  const res = await axios.get(url, {
    headers: shopifyHeaders(accessToken),
    timeout: 15000
  });
  const shop = res.data?.shop || {};
  return {
    shopId: String(shop.id),
    shopName: shop.name,
    shopDomain: shop.myshopify_domain || shopDomain,
    currency: shop.currency || 'INR'
  };
}

// ─── Webhook management ───────────────────────────────────────────────────────

const WEBHOOK_TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
  'customers/create',
  'customers/update',
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/cancelled',
  'app/uninstalled'
];

/**
 * Register all RepMeUp webhooks for a Shopify store.
 * Shopify deduplicates registrations on (topic, address), so calling this
 * multiple times is safe.
 */
async function registerWebhooks(shopDomain, accessToken, callbackBaseUrl) {
  const base = `${shopifyBase(shopDomain)}/webhooks.json`;
  const headers = shopifyHeaders(accessToken);
  const address = `${callbackBaseUrl.replace(/\/$/, '')}/api/webhooks/shopify`;
  const registered = [];

  for (const topic of WEBHOOK_TOPICS) {
    try {
      const res = await axios.post(
        base,
        { webhook: { topic, address, format: 'json' } },
        { headers, timeout: 15000 }
      );
      registered.push({ topic, id: res.data?.webhook?.id });
      logger.info(`[shopifyService] Registered webhook: ${topic}`);
    } catch (err) {
      const status = err.response?.status;
      const errors = err.response?.data?.errors;
      // 422 = already registered — not an error
      if (status === 422) {
        logger.info(`[shopifyService] Webhook already registered: ${topic}`);
        registered.push({ topic, alreadyExisted: true });
      } else {
        logger.warn(`[shopifyService] Failed to register webhook ${topic}`, { status, errors });
      }
    }
  }

  return registered;
}

/**
 * Delete all RepMeUp webhooks for a store (called on disconnect).
 */
async function unregisterWebhooks(shopDomain, accessToken, callbackBaseUrl) {
  const address = `${callbackBaseUrl.replace(/\/$/, '')}/api/webhooks/shopify`;
  const headers = shopifyHeaders(accessToken);
  let cursor = null;
  const allHooks = [];

  // Fetch all registered webhooks (paginated)
  while (true) {
    const query = { limit: 250 };
    if (cursor) query.page_info = cursor;
    const res = await axios.get(`${shopifyBase(shopDomain)}/webhooks.json`, { params: query, headers, timeout: 15000 });
    const batch = res.data?.webhooks || [];
    allHooks.push(...batch);
    cursor = extractNextPageInfo(res.headers['link']);
    if (!cursor || batch.length === 0) break;
  }

  const ours = allHooks.filter(h => h.address === address);
  for (const hook of ours) {
    try {
      await axios.delete(`${shopifyBase(shopDomain)}/webhooks/${hook.id}.json`, { headers, timeout: 10000 });
      logger.info(`[shopifyService] Deleted webhook ${hook.topic} (id=${hook.id})`);
    } catch (err) {
      logger.warn(`[shopifyService] Failed to delete webhook ${hook.id}`, { error: err.message });
    }
  }

  return { deleted: ours.length };
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchAllProducts(connection) {
  const { accessToken, platformData } = connection;
  const shopDomain = platformData?.shopDomain;
  return fetchAllPages(
    `${shopifyBase(shopDomain)}/products.json`,
    shopifyHeaders(accessToken),
    { status: 'active', fields: 'id,title,body_html,variants,images,vendor,product_type,handle' },
    'products'
  );
}

async function fetchAllCustomers(connection) {
  const { accessToken, platformData } = connection;
  const shopDomain = platformData?.shopDomain;
  return fetchAllPages(
    `${shopifyBase(shopDomain)}/customers.json`,
    shopifyHeaders(accessToken),
    { fields: 'id,email,first_name,last_name,phone,tags,addresses,accepts_marketing,orders_count,total_spent,note' },
    'customers'
  );
}

async function fetchAllOrders(connection, { sinceId } = {}) {
  const { accessToken, platformData } = connection;
  const shopDomain = platformData?.shopDomain;
  const params = {
    status: 'any',
    fields: 'id,name,email,phone,financial_status,fulfillment_status,total_price,currency,line_items,customer,shipping_address,billing_address,note,created_at,updated_at,cancelled_at,tags'
  };
  if (sinceId) params.since_id = sinceId;
  return fetchAllPages(
    `${shopifyBase(shopDomain)}/orders.json`,
    shopifyHeaders(accessToken),
    params,
    'orders'
  );
}

// ─── HMAC verification ────────────────────────────────────────────────────────

/**
 * Verify an incoming Shopify webhook POST.
 * Shopify sends: X-Shopify-Hmac-Sha256: base64(HMAC-SHA256(rawBody, sharedSecret))
 * Returns true if valid, false otherwise.
 */
function verifyWebhookHmac(rawBody, signatureBase64) {
  if (!SHOPIFY_WEBHOOK_SECRET || !signatureBase64) return false;
  try {
    const computed = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('base64');
    const sigBuf = Buffer.from(signatureBase64, 'utf8');
    const expBuf = Buffer.from(computed, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// ─── Field mappers ────────────────────────────────────────────────────────────

/**
 * Map a single Shopify product (first variant) to a RepMeUp Product payload.
 * For multi-variant products, call mapShopifyVariantToProduct for each variant.
 */
function mapShopifyProductToRepmeup(shopifyProduct, shopDomain) {
  const p = shopifyProduct;
  const variant = (p.variants || [])[0] || {};
  return _buildProductPayload(p, variant, shopDomain);
}

/**
 * Expand a Shopify product into one payload per variant.
 */
function mapShopifyProductVariants(shopifyProduct, shopDomain) {
  const p = shopifyProduct;
  const variants = p.variants && p.variants.length > 0 ? p.variants : [{}];
  return variants.map(variant => _buildProductPayload(p, variant, shopDomain));
}

function _buildProductPayload(p, variant, shopDomain) {
  const domain = shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const variantId = variant.id ? String(variant.id) : null;
  const variantTitle = variant.title && variant.title !== 'Default Title' ? variant.title : null;

  const { commerce } = coerceCommerceFields({
    brand: p.vendor,
    productType: p.product_type,
    gtin: variant.barcode,
    shippingWeight: variant.weight
      ? { value: Number(variant.weight), unit: String(variant.weight_unit || 'kg').toLowerCase() }
      : undefined
  }, { lenient: true });

  return {
    sku: variant.sku || null,
    name: variantTitle ? `${p.title || ''} — ${variantTitle}` : (p.title || ''),
    description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').trim() : '',
    price: parseFloat(variant.price) || 0,
    currency: DEFAULT_CURRENCY,
    discountPercent:
      variant.compare_at_price && parseFloat(variant.compare_at_price) > parseFloat(variant.price)
        ? Math.round((1 - parseFloat(variant.price) / parseFloat(variant.compare_at_price)) * 100)
        : 0,
    stock: variant.inventory_quantity != null ? variant.inventory_quantity : null,
    paymentUrl: '',
    websiteUrl: p.handle ? `https://${domain}/products/${p.handle}` : '',
    images: (p.images || []).map(img => img.src).filter(Boolean),
    sizes: (p.variants || []).map(v => v.option1).filter(v => v && !/^\d/.test(v)),
    colors: [],
    source: 'shopify',
    commerce,
    shopify: {
      productId: p.id ? `gid://shopify/Product/${p.id}` : null,
      variantId: variantId ? `gid://shopify/ProductVariant/${variantId}` : null,
      syncedAt: new Date()
    }
  };
}

/**
 * Map a Shopify customer to a RepMeUp contact resolve payload
 * (format expected by contactService.resolveContact).
 */
function mapShopifyCustomerToContactPayload(customer) {
  const addr = (customer.addresses || [])[0] || {};
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'Shopify Customer';
  return {
    platform: 'shopify',
    platformUserId: String(customer.id),
    phone: customer.phone || addr.phone || null,
    email: customer.email || null,
    username: customer.email || null,
    name,
    rawData: {
      shopifyCustomerId: customer.id,
      ordersCount: customer.orders_count,
      totalSpent: customer.total_spent,
      tags: customer.tags,
      note: customer.note,
      address: addr
    }
  };
}

/**
 * Map a Shopify order to a RepMeUp CommerceOrder payload.
 */
function mapShopifyOrderToCommerceOrder(shopifyOrder, organizationId, contactId) {
  const o = shopifyOrder;
  const addr = o.shipping_address || o.billing_address || {};

  const lineItems = (o.line_items || []).map(li => ({
    retailerId: li.sku || String(li.product_id),
    name: li.name || li.title,
    qty: li.quantity,
    unitPrice: parseFloat(li.price) || 0,
    currency: o.currency || 'INR'
  }));

  const statusMap = {
    pending: 'pending',
    authorized: 'payment_pending',
    partially_paid: 'payment_pending',
    paid: 'paid',
    refunded: 'refunded',
    voided: 'cancelled',
    partially_refunded: 'paid'
  };

  const orderStatus = statusMap[o.financial_status] || 'pending';

  return {
    organization: organizationId,
    channel: 'shopify',
    status: orderStatus,
    lineItems,
    totalAmount: parseFloat(o.total_price) || 0,
    currency: o.currency || 'INR',
    shopifyOrderId: String(o.id),
    externalOrderNumber: o.name,
    contact: contactId || undefined,
    buyerName: addr.name || [o.shipping_address?.first_name, o.shipping_address?.last_name].filter(Boolean).join(' ') || null,
    buyerPhone: addr.phone || o.phone || null,
    shippingAddress: [addr.address1, addr.address2, addr.city, addr.province, addr.country].filter(Boolean).join(', ') || null,
    shipping: addr.address1 ? {
      name: addr.name,
      phone: addr.phone,
      line1: addr.address1,
      line2: addr.address2 || '',
      city: addr.city,
      state: addr.province,
      pincode: addr.zip,
      country: addr.country
    } : undefined,
    notes: o.note || '',
    statusHistory: [{ status: orderStatus, at: new Date(o.created_at || Date.now()), note: `Synced from Shopify (${o.name})` }]
  };
}

module.exports = {
  verifyToken,
  registerWebhooks,
  unregisterWebhooks,
  fetchAllProducts,
  fetchAllCustomers,
  fetchAllOrders,
  verifyWebhookHmac,
  mapShopifyProductToRepmeup,
  mapShopifyProductVariants,
  mapShopifyCustomerToContactPayload,
  mapShopifyOrderToCommerceOrder,
  WEBHOOK_TOPICS,
  API_VERSION
};
