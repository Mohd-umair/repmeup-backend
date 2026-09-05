/**
 * WhatsApp Catalog Controller
 *
 * Handles all WhatsApp Commerce Catalog operations:
 *   - Catalog settings (link a Meta Catalog ID to the WABA phone number)
 *   - Per-product and bulk sync to Meta Catalog API
 *   - CSV import with immediate catalog sync
 *   - Sending interactive product / product-list messages from the inbox
 *
 * Routes: /api/whatsapp-catalog/*
 */

const Product = require('../models/Product');
const PlatformConnection = require('../models/PlatformConnection');
const Interaction = require('../models/Interaction');
const { DEFAULT_CURRENCY, coerceCommerceFields } = require('../utils/productCommerceFields');
const whatsappCatalogService = require('../integrations/whatsapp/whatsappCatalogService');
const logger = require('../config/logger');
const xlsx = require('xlsx');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the active WhatsApp PlatformConnection for an org.
 * Returns null if none is found.
 */
async function _getWaConnection(orgId) {
  return PlatformConnection.findOne({
    organization: orgId,
    platform: 'whatsapp',
    status: 'connected',
    isActive: true
  }).lean();
}

/**
 * Validate that a catalog ID is configured, otherwise return a 422.
 */
function _requireCatalogId(catalogId, res) {
  if (!catalogId) {
    res.status(422).json({
      success: false,
      error:
        'No WhatsApp Catalog ID configured. Go to the WhatsApp Catalog settings tab, enter your Meta Commerce Catalog ID, and save.'
    });
    return false;
  }
  return true;
}

/**
 * Resolve Meta-linked catalog id and verify commerce settings before sync.
 * Returns { catalogId } or sends 422 and returns null.
 */
async function _resolveCatalogForSync(connection, res) {
  const resolved = await whatsappCatalogService.resolveCatalogIdForSync(connection);
  if (!resolved.catalogId) {
    res.status(422).json({
      success: false,
      error: resolved.error || 'No catalog configured',
      hint: resolved.hint
    });
    return null;
  }

  const check = await whatsappCatalogService.verifyCatalogAccess(connection, resolved.catalogId);
  if (!check.valid) {
    res.status(422).json({
      success: false,
      error: check.error || 'Catalog is not linked to your WhatsApp number.',
      hint: check.hint || 'Save your Catalog ID in WhatsApp Catalog settings, then sync again.'
    });
    return null;
  }

  // Prefer catalog id confirmed by Meta commerce settings
  return check.id || resolved.catalogId;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET CATALOG SETTINGS
// GET /api/whatsapp-catalog/settings
// ─────────────────────────────────────────────────────────────────────────────
exports.getCatalogSettings = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const connection = await _getWaConnection(orgId);

    if (!connection) {
      return res.json({
        success: true,
        data: {
          connected: false,
          catalogId: null,
          phoneNumberId: null,
          displayPhoneNumber: null,
          isCatalogVisible: false,
          isCartEnabled: false,
          syncedCount: 0,
          failedCount: 0,
          notSyncedCount: 0
        }
      });
    }

    const catalogId = connection.platformData?.catalogId || null;

    // Sync stats — run in parallel
    const [syncedCount, failedCount, notSyncedCount] = await Promise.all([
      Product.countDocuments({ organization: orgId, isActive: true, 'whatsapp.syncStatus': 'synced' }),
      Product.countDocuments({ organization: orgId, isActive: true, 'whatsapp.syncStatus': 'failed' }),
      Product.countDocuments({ organization: orgId, isActive: true, 'whatsapp.syncStatus': { $in: ['not_synced', 'pending'] } })
    ]);

    let storedId = catalogId ? String(catalogId).trim() : null;

    let assessment = {
      metaCatalogId: null,
      catalogLinkStatus: 'not_linked',
      catalogLinkVerified: false,
      wabaCatalogIds: [],
      isCatalogVisible: false,
      isCartEnabled: false
    };

    if (storedId) {
      try {
        assessment = await whatsappCatalogService.assessCatalogLink(connection, storedId);
      } catch (_e) {
        // non-fatal
      }
    }

    // Heal stored ID when Meta reports a single WABA catalog different from local typo
    if (assessment.metaCatalogId && storedId && assessment.metaCatalogId !== storedId && assessment.catalogLinkStatus === 'mismatch') {
      // keep storedId — user must fix mismatch deliberately
    } else if (assessment.metaCatalogId && storedId && assessment.metaCatalogId !== storedId && assessment.catalogLinkVerified) {
      await PlatformConnection.updateOne(
        { _id: connection._id },
        { $set: { 'platformData.catalogId': assessment.metaCatalogId } }
      );
      storedId = assessment.metaCatalogId;
    }

    const isVerifiedLink = Boolean(assessment.catalogLinkVerified);
    const responseCatalogId = storedId || assessment.metaCatalogId;

    return res.json({
      success: true,
      data: {
        connected: true,
        catalogId: responseCatalogId,
        metaCatalogId: assessment.metaCatalogId,
        catalogLinkStatus: assessment.catalogLinkStatus,
        catalogLinkVerified: isVerifiedLink,
        phoneNumberId: connection.platformData?.phoneNumberId || null,
        displayPhoneNumber: connection.platformData?.displayPhoneNumber || null,
        isCatalogVisible: assessment.isCatalogVisible,
        isCartEnabled: assessment.isCartEnabled,
        wabaCatalogIds: assessment.wabaCatalogIds,
        syncedCount,
        failedCount,
        notSyncedCount
      }
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE CATALOG SETTINGS
// PUT /api/whatsapp-catalog/settings
// body: { catalogId }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateCatalogSettings = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const { catalogId } = req.body;

    if (!catalogId || !String(catalogId).trim()) {
      return res.status(400).json({ success: false, error: 'catalogId is required' });
    }

    const connection = await PlatformConnection.findOne({
      organization: orgId,
      platform: 'whatsapp',
      status: 'connected',
      isActive: true
    });

    if (!connection) {
      return res.status(422).json({
        success: false,
        error: 'No active WhatsApp connection found. Connect your WhatsApp account in Settings → Platforms first.'
      });
    }

    const trimmedCatalogId = String(catalogId).trim();

    // Try to link catalog to WABA and save catalog ID locally.
    // updateCommerceSettings is non-fatal for the WABA link step
    // (may fail without catalog_management until App Review approves it).
    let metaResult = null;
    try {
      metaResult = await whatsappCatalogService.updateCommerceSettings(connection, trimmedCatalogId);
    } catch (metaErr) {
      logger.warn('[whatsappCatalogController] updateCommerceSettings failed', {
        error: metaErr.message,
        catalogId: trimmedCatalogId,
        metaCode: metaErr.metaCode
      });
      const isInvalidId = metaErr.isInvalidCatalogId || metaErr.metaCode === 100;
      return res.status(422).json({
        success: false,
        error: metaErr.message || 'Meta rejected this request.',
        hint: isInvalidId
          ? 'Open Meta Commerce Manager → Catalogs → select your catalog → Settings. Copy the numeric Catalog ID from there.'
          : 'Ensure your WhatsApp connection is active and try again.'
      });
    }

    // Always persist the catalog ID the user entered
    connection.platformData = connection.platformData || {};
    connection.platformData.catalogId = trimmedCatalogId;
    connection.markModified('platformData');
    await connection.save();

    return res.json({
      success: true,
      data: {
        catalogId: trimmedCatalogId,
        metaCatalogId: trimmedCatalogId,
        catalogLinkStatus: 'saved',
        catalogLinkVerified: true,
        isCatalogVisible: metaResult.settings?.isCatalogVisible ?? false,
        isCartEnabled: metaResult.settings?.isCartEnabled ?? false,
        metaSynced: true
      }
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNC ONE PRODUCT
// POST /api/whatsapp-catalog/products/:productId/sync
// ─────────────────────────────────────────────────────────────────────────────
exports.syncOneProduct = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const { productId } = req.params;

    const [product, connection] = await Promise.all([
      Product.findOne({ _id: productId, organization: orgId }),
      _getWaConnection(orgId)
    ]);

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (!connection) {
      return res.status(422).json({ success: false, error: 'No active WhatsApp connection found.' });
    }

    const catalogId = await _resolveCatalogForSync(connection, res);
    if (!catalogId) return;

    // Mark as pending
    product.whatsapp = product.whatsapp || {};
    product.whatsapp.syncStatus = 'pending';
    await product.save();

    try {
      const { id: catalogItemId } = await whatsappCatalogService.upsertProduct(connection, catalogId, product);

      product.whatsapp.catalogItemId = catalogItemId;
      product.whatsapp.syncStatus = 'synced';
      product.whatsapp.syncedAt = new Date();
      product.whatsapp.syncError = undefined;
      await product.save();

      logger.info('[whatsappCatalogController] Product synced', { productId: product._id, catalogItemId });

      return res.json({ success: true, data: product.toObject() });
    } catch (syncErr) {
      product.whatsapp.syncStatus = 'failed';
      product.whatsapp.syncError = syncErr.message;
      await product.save();

      return res.status(502).json({ success: false, error: syncErr.message, data: product.toObject() });
    }
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNC ALL ACTIVE PRODUCTS
// POST /api/whatsapp-catalog/sync-all
// ─────────────────────────────────────────────────────────────────────────────
exports.syncAllProducts = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const connection = await _getWaConnection(orgId);
    if (!connection) {
      return res.status(422).json({ success: false, error: 'No active WhatsApp connection found.' });
    }

    const catalogId = await _resolveCatalogForSync(connection, res);
    if (!catalogId) return;

    const products = await Product.find({ organization: orgId, isActive: true }).lean();
    if (products.length === 0) {
      return res.json({ success: true, data: { synced: 0, failed: 0, total: 0 } });
    }

    // Bulk-mark as pending
    await Product.updateMany(
      { organization: orgId, isActive: true },
      { $set: { 'whatsapp.syncStatus': 'pending' } }
    );

    // Use individual upsertProduct (not batch) so we get catalogItemId per product.
    // Batch API returns async handles only — we cannot reliably map them back to item IDs.
    const CONCURRENCY = 5;
    const results = [];
    for (let i = 0; i < products.length; i += CONCURRENCY) {
      const chunk = products.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((p) => whatsappCatalogService.upsertProduct(connection, catalogId, p))
      );
      settled.forEach((outcome, idx) => {
        const p = chunk[idx];
        if (outcome.status === 'fulfilled') {
          results.push({ productId: p._id.toString(), success: true, catalogItemId: outcome.value?.id });
        } else {
          results.push({ productId: p._id.toString(), success: false, error: outcome.reason?.message });
        }
      });
    }

    const bulkOps = results.map(r => ({
      updateOne: {
        filter: { _id: r.productId },
        update: r.success
          ? {
              $set: {
                'whatsapp.syncStatus': 'synced',
                'whatsapp.syncedAt': new Date(),
                'whatsapp.syncError': null,
                ...(r.catalogItemId ? { 'whatsapp.catalogItemId': r.catalogItemId } : {})
              }
            }
          : { $set: { 'whatsapp.syncStatus': 'failed', 'whatsapp.syncError': r.error || 'Sync failed' } }
      }
    }));

    if (bulkOps.length > 0) {
      await Product.bulkWrite(bulkOps);
    }

    const synced = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const failedDetails = results
      .filter((r) => !r.success)
      .slice(0, 10)
      .map((r) => {
        const p = products.find((prod) => String(prod._id) === r.productId);
        return {
          productId: r.productId,
          productName: p?.name,
          error: r.error || 'Sync failed'
        };
      });

    logger.info('[whatsappCatalogController] syncAll complete', { orgId, total: results.length, synced, failed });

    return res.json({
      success: true,
      data: { synced, failed, total: results.length, errors: failedDetails.length ? failedDetails : undefined }
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT CSV
// POST /api/whatsapp-catalog/import/csv
// multipart/form-data — file field: "file"
//
// Expected CSV columns (case-insensitive):
//   name (required), description, price, currency, image_url, additional_image_link,
//   payment_url, website_url (alias: link), sku, stock
// Meta commerce columns (all optional; invalid values dropped with a warning):
//   brand, condition, availability, gtin, mpn, google_product_category,
//   fb_product_category, product_type, item_group_id, color, size, gender,
//   age_group, material, pattern, origin_country, importer_name,
//   manufacturer_info, wa_compliance_category, shipping_weight
// ─────────────────────────────────────────────────────────────────────────────
exports.importCsv = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const orgId = req.user.organization._id;
    const connection = await _getWaConnection(orgId);
    const catalogId = connection?.platformData?.catalogId;

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'The file is empty or could not be parsed.' });
    }

    // Normalise column names to lowercase with underscores
    const normalise = row => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        const key = String(k).trim().toLowerCase().replace(/\s+/g, '_');
        out[key] = v;
      }
      return out;
    };

    const bulkOps = [];
    const importErrors = [];
    const importWarnings = [];
    let rowIndex = 0;

    for (const rawRow of rows) {
      rowIndex++;
      const row = normalise(rawRow);

      const name = row.name ? String(row.name).trim() : null;
      if (!name) {
        importErrors.push({ row: rowIndex, error: 'Missing required field: name' });
        continue;
      }

      const sku = row.sku ? String(row.sku).trim() : null;
      const price = parseFloat(row.price) || 0;
      const currency = row.currency ? String(row.currency).trim().toUpperCase() : DEFAULT_CURRENCY;
      const description = row.description ? String(row.description).trim() : '';
      const imageUrl = row.image_url ? String(row.image_url).trim() : '';
      const paymentUrl = row.payment_url ? String(row.payment_url).trim() : '';
      const websiteUrl = (row.website_url || row.link) ? String(row.website_url || row.link).trim() : '';
      const stock = row.stock !== '' && row.stock != null ? Number(row.stock) : null;

      // additional_image_link: comma/semicolon/pipe separated → appended after image_url
      const additionalImages = row.additional_image_link
        ? String(row.additional_image_link).split(/[,;|]/).map(s => s.trim()).filter(Boolean)
        : [];
      const images = [...(imageUrl ? [imageUrl] : []), ...additionalImages];

      // Meta commerce fields — lenient: invalid values dropped with a warning.
      const { commerce, warnings: rowWarnings } = coerceCommerceFields(row, { lenient: true });
      for (const w of rowWarnings) importWarnings.push({ row: rowIndex, warning: w });

      const productData = {
        organization: orgId,
        name,
        description,
        price,
        currency,
        images,
        paymentUrl,
        stock,
        isActive: true,
        createdBy: req.user._id,
        'whatsapp.syncStatus': 'pending'
      };
      if (websiteUrl) productData.websiteUrl = websiteUrl;
      if (commerce) {
        for (const [key, value] of Object.entries(commerce)) {
          productData[`commerce.${key}`] = value;
        }
      }
      if (sku) productData.sku = sku;

      const filter = sku
        ? { organization: orgId, sku }
        : { organization: orgId, name };

      bulkOps.push({
        updateOne: {
          filter,
          update: { $set: productData },
          upsert: true
        }
      });
    }

    let upsertedCount = 0;
    let modifiedCount = 0;

    if (bulkOps.length > 0) {
      const result = await Product.bulkWrite(bulkOps);
      upsertedCount = result.upsertedCount || 0;
      modifiedCount = result.modifiedCount || 0;
    }

    // Sync to Meta catalog if catalogId is configured
    let syncResult = null;
    if (catalogId && connection) {
      const productsToSync = await Product.find({
        organization: orgId,
        isActive: true,
        'whatsapp.syncStatus': 'pending'
      }).lean();

      if (productsToSync.length > 0) {
        const { results } = await whatsappCatalogService.batchSync(connection, catalogId, productsToSync);
        const syncOps = results.map(r => ({
          updateOne: {
            filter: { _id: r.productId },
            update: r.success
              ? { $set: { 'whatsapp.syncStatus': 'synced', 'whatsapp.syncedAt': new Date(), 'whatsapp.syncError': null } }
              : { $set: { 'whatsapp.syncStatus': 'failed', 'whatsapp.syncError': r.error || 'Sync failed' } }
          }
        }));
        if (syncOps.length > 0) await Product.bulkWrite(syncOps);
        syncResult = {
          synced: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length
        };
      }
    }

    return res.json({
      success: true,
      data: {
        created: upsertedCount,
        updated: modifiedCount,
        failed: importErrors,
        warnings: importWarnings,
        sync: syncResult,
        totalRows: rowIndex
      }
    });
  } catch (err) {
    logger.error('[whatsappCatalogController] importCsv error', { error: err.message });
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SEND PRODUCT MESSAGE (from inbox)
// POST /api/whatsapp-catalog/send-product
// body: { interactionId, productId, bodyText?, sendMode? }
// sendMode: 'product' (single, default) | 'product_list'
// ─────────────────────────────────────────────────────────────────────────────
exports.sendProductMessage = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const { interactionId, productId, bodyText = '', sendMode = 'product' } = req.body;

    if (!interactionId || !productId) {
      return res.status(400).json({ success: false, error: 'interactionId and productId are required' });
    }

    const [interaction, product, connection] = await Promise.all([
      Interaction.findOne({ _id: interactionId, organization: orgId }).lean(),
      Product.findOne({ _id: productId, organization: orgId }).lean(),
      _getWaConnection(orgId)
    ]);

    if (!interaction) return res.status(404).json({ success: false, error: 'Interaction not found' });
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (interaction.platform !== 'whatsapp') {
      return res.status(400).json({ success: false, error: 'Product messages can only be sent for WhatsApp conversations.' });
    }
    if (!connection) {
      return res.status(422).json({ success: false, error: 'No active WhatsApp connection found.' });
    }

    const catalogId = connection.platformData?.catalogId;
    if (!_requireCatalogId(catalogId, res)) return;

    const to = interaction.author?.platformId;
    if (!to) return res.status(422).json({ success: false, error: 'Cannot resolve recipient phone number.' });

    const retailerId = product.sku || product._id.toString();
    let result;

    if (sendMode === 'product_list') {
      result = await whatsappCatalogService.sendProductListMessage(
        connection,
        to,
        catalogId,
        [{ title: 'Our Products', productRetailerIds: [retailerId] }],
        '',
        bodyText || 'Check out this product'
      );
    } else {
      result = await whatsappCatalogService.sendProductMessage(
        connection,
        to,
        catalogId,
        retailerId,
        bodyText
      );
    }

    if (!result.success || !result.messageId) {
      return res.status(502).json({ success: false, error: 'Failed to send product message via WhatsApp.' });
    }

    // Persist reply entry so it appears in inbox timeline, with a rich product
    // preview (image + price) so the inbox can render a product card.
    const fullInteraction = await Interaction.findById(interactionId);
    if (fullInteraction) {
      const replyContent = bodyText || `[Product: ${product.name}]`;
      const productPreview = {
        productId: product._id.toString(),
        name: product.name,
        image: Array.isArray(product.images) && product.images.length ? product.images[0] : null,
        price: product.price ?? null,
        currency: product.currency || 'INR',
        sku: product.sku || null
      };
      await fullInteraction.addReply(
        replyContent, req.user._id, result.messageId, false,
        null, null, null, null, null, null, productPreview
      );
    }

    return res.json({ success: true, data: { messageId: result.messageId } });
  } catch (err) {
    logger.error('[whatsappCatalogController] sendProductMessage error', { error: err.message });
    next(err);
  }
};
