const Product = require('../models/Product');
const Organization = require('../models/Organization');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');
const xlsx = require('xlsx');
const axios = require('axios');
const { syncProductToKb, removeProductFromKb } = require('../services/ai/productKbSyncService');

/**
 * Auto-sync a product to the org's WhatsApp catalog if connected.
 * Returns sync outcome so create/update APIs can surface Meta failures to the UI.
 */
async function _autoSyncToMeta(product, orgId) {
  try {
    const whatsappCatalogService = require('../integrations/whatsapp/whatsappCatalogService');
    const conn = await PlatformConnection.findOne({
      organization: orgId,
      platform: 'whatsapp',
      status: 'connected',
      isActive: true
    }).lean();
    if (!conn) {
      return { attempted: false, synced: false, skippedReason: 'no_whatsapp_connection' };
    }

    const resolved = await whatsappCatalogService.resolveCatalogIdForSync(conn);
    if (!resolved.catalogId) {
      return { attempted: false, synced: false, skippedReason: 'no_catalog_id' };
    }

    const check = await whatsappCatalogService.verifyCatalogAccess(conn, resolved.catalogId);
    if (!check.valid) {
      const error = check.error || 'Catalog is not linked on Meta.';
      await Product.updateOne(
        { _id: product._id },
        { $set: { 'whatsapp.syncStatus': 'failed', 'whatsapp.syncError': error } }
      ).catch(() => {});
      logger.warn('[productController] Auto-sync skipped — catalog not linked in Meta', {
        productId: String(product._id),
        error
      });
      return { attempted: true, synced: false, error };
    }

    const catalogId = check.id || resolved.catalogId;
    const { id: itemId } = await whatsappCatalogService.upsertProduct(conn, catalogId, product);
    if (itemId) {
      await Product.updateOne(
        { _id: product._id },
        { $set: { 'whatsapp.catalogItemId': itemId, 'whatsapp.syncStatus': 'synced', 'whatsapp.syncedAt': new Date(), 'whatsapp.syncError': null } }
      );
      logger.info('[productController] Auto-synced to WA catalog', { productId: String(product._id), itemId });
      return { attempted: true, synced: true };
    }

    const error = 'Meta did not return a catalog item ID.';
    await Product.updateOne(
      { _id: product._id },
      { $set: { 'whatsapp.syncStatus': 'failed', 'whatsapp.syncError': error } }
    ).catch(() => {});
    return { attempted: true, synced: false, error };
  } catch (err) {
    logger.warn('[productController] Auto-sync to WA catalog failed (non-fatal)', {
      productId: String(product._id),
      error: err.message
    });
    await Product.updateOne(
      { _id: product._id },
      { $set: { 'whatsapp.syncStatus': 'failed', 'whatsapp.syncError': err.message } }
    ).catch(() => {});
    return { attempted: true, synced: false, error: err.message };
  }
}

/**
 * Fire-and-forget: remove a product from the org's WA catalog when it is deactivated.
 */
async function _autoDeleteFromMeta(product, orgId) {
  try {
    const catalogItemId = product.whatsapp?.catalogItemId;
    if (!catalogItemId) return;
    const whatsappCatalogService = require('../integrations/whatsapp/whatsappCatalogService');
    const conn = await PlatformConnection.findOne({ organization: orgId, platform: 'whatsapp', isActive: true }).lean();
    if (!conn) return;
    await whatsappCatalogService.deleteProduct(conn, catalogItemId);
    await Product.updateOne(
      { _id: product._id },
      { $set: { 'whatsapp.syncStatus': 'not_synced', 'whatsapp.catalogItemId': null } }
    );
    logger.info('[productController] Removed product from WA catalog on deactivate', { productId: String(product._id) });
  } catch (err) {
    logger.warn('[productController] Auto-delete from WA catalog failed (non-fatal)', {
      productId: String(product._id),
      error: err.message
    });
  }
}

// Default settings returned when the org's commentToDmSettings subdocument is missing or empty
const DEFAULT_COMMENT_TO_DM_SETTINGS = {
  enabled: false,
  triggerKeywords: ['price', 'buy', 'cost', 'order', 'purchase', 'how much', 'interested', 'want this', 'where to buy', 'link'],
  publicReplyTemplate: "Hi {{username}}! 👋 We've sent you the details in DM. 😊",
  dmTemplate: "Hi {{username}}! 👋 Thanks for your interest.\n\n🛍️ *{{product_name}}*\n💵 Price: {{currency}} {{price}}\n📦 Sizes: {{sizes}}\n\n👉 Order here: {{payment_url}}\n\nFeel free to DM us if you have questions! 😊",
  confirmationTemplate: "Hi {{username}}! 🎉 Your order for *{{product_name}}* has been confirmed! We'll be in touch with shipping details soon. Thank you! 🙏",
  deduplicateDms: true,
  maxDmsPerDay: 200,
  defaultProductId: null
};

const DEFAULT_COMMENT_FOLLOW_INVITE_SETTINGS = {
  enabled: false,
  title: 'Thanks for your comment!',
  subtitle: 'Tap below to follow us for more updates.',
  imageUrl: '',
  buttonTitle: 'Follow us',
  buttonUrl: '',
  publicReplyTemplate: '',
  postPublicReply: false,
  deduplicateDms: true,
  maxDmsPerDay: 50,
  skipIfProductDmSent: false
};

const DEFAULT_SALES_FLOW_SETTINGS = {
  enabled: false,
  ctaTitle: 'Check this out! 🛍️',
  ctaSubtitle: 'Tap a button below for more details.',
  ctaImageUrl: '',
  ctaButtons: [
    { label: 'Product Details', type: 'postback', payload: 'details' },
    { label: 'Pay Now',         type: 'postback', payload: 'payment' },
    { label: 'Maybe later',     type: 'postback', payload: 'hesitant' }
  ],
  hesitancyKeywords: ['no', 'nahi', 'not interested', 'later', 'abhi nahi', 'nope', 'not now', 'maybe later'],
  whatsappCaptureMessage: "No problem! Would you like us to reach you on WhatsApp? Just share your number and we'll be in touch. 😊",
  whatsappCaptureConfirmation: "Thank you! We'll contact you on WhatsApp soon. 🙏"
};

// ─────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────
exports.getProducts = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const { search, isActive, page = 1, limit = 50 } = req.query;

    const filter = { organization: orgId };
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Product.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: { products, total, page: Number(page), limit: Number(limit) }
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET BY ID
// ─────────────────────────────────────────────
exports.getProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    }).lean();

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────
exports.createProduct = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const { name, description, price, currency, discountPercent, images, paymentUrl, sizes, colors, stock } = req.body;

    if (!name || price === undefined || price === null) {
      return res.status(400).json({ success: false, error: 'name and price are required' });
    }

    const product = await Product.create({
      organization: orgId,
      name,
      description,
      price: Number(price),
      currency: currency || 'AED',
      discountPercent: Number(discountPercent || 0),
      images: images || [],
      paymentUrl: paymentUrl || '',
      sizes: sizes || [],
      colors: colors || [],
      stock: stock != null ? Number(stock) : null,
      createdBy: req.user._id
    });

    // KB sync stays non-blocking; WA sync is awaited so the UI can show Meta errors.
    syncProductToKb(product).catch(() => {});
    const whatsappSync = await _autoSyncToMeta(product, orgId);

    const freshProduct = await Product.findById(product._id).lean();
    res.status(201).json({ success: true, data: freshProduct, whatsappSync });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────
exports.updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({
      _id: req.params.id,
      organization: req.user.organization._id
    });

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

    const allowedFields = ['name', 'description', 'price', 'currency', 'discountPercent', 'images', 'paymentUrl', 'sizes', 'colors', 'stock', 'isActive'];
    const wasActive = product.isActive;
    allowedFields.forEach(f => {
      if (req.body[f] !== undefined) product[f] = req.body[f];
    });

    await product.save();

    // Fire-and-forget KB sync; await WA sync so Meta failures reach the UI.
    syncProductToKb(product).catch(() => {});
    let whatsappSync = { attempted: false, synced: false };
    if (product.isActive) {
      whatsappSync = await _autoSyncToMeta(product, req.user.organization._id);
    } else if (wasActive && !product.isActive) {
      _autoDeleteFromMeta(product, req.user.organization._id).catch(() => {});
      removeProductFromKb(product._id, req.user.organization._id).catch(() => {});
    }

    const freshProduct = await Product.findById(product._id).lean();
    res.json({ success: true, data: freshProduct, whatsappSync });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// DELETE (soft)
// ─────────────────────────────────────────────
exports.deleteProduct = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, organization: orgId },
      { isActive: false },
      { new: true }
    );

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

    // Fire-and-forget cleanup
    _autoDeleteFromMeta(product, orgId).catch(() => {});
    removeProductFromKb(product._id, orgId).catch(() => {});

    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// PER-PRODUCT DM CONFIG
// ─────────────────────────────────────────────

exports.getProductDmConfig = async (req, res, next) => {
  try {
    const product = await Product.findOne(
      { _id: req.params.id, organization: req.user.organization._id },
      { dmConfig: 1 }
    ).lean();
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, data: product.dmConfig || {} });
  } catch (err) {
    next(err);
  }
};

const ALLOWED_BUTTON_TYPES = ['postback', 'web_url'];
const ALLOWED_PAYLOADS     = ['details', 'payment', 'hesitant'];

exports.updateProductDmConfig = async (req, res, next) => {
  try {
    const {
      ctaTitle, ctaSubtitle, ctaImageUrl,
      ctaButtons,
      triggerKeywords, publicReplyTemplate,
      hesitancyKeywords,
      whatsappCaptureMessage, whatsappCaptureConfirmation
    } = req.body;

    // ── Validate ctaButtons if provided ───────────────────────────────
    if (ctaButtons !== undefined) {
      if (!Array.isArray(ctaButtons)) {
        return res.status(400).json({ success: false, error: 'ctaButtons must be an array' });
      }
      if (ctaButtons.length > 3) {
        return res.status(400).json({ success: false, error: 'Instagram Generic Template supports a maximum of 3 CTA buttons' });
      }
      for (const btn of ctaButtons) {
        if (!btn || typeof btn.label !== 'string' || !btn.label.trim()) {
          return res.status(400).json({ success: false, error: 'Each CTA button must have a non-empty label' });
        }
        if (btn.label.length > 20) {
          return res.status(400).json({ success: false, error: `Button label "${btn.label}" exceeds the 20-character limit` });
        }
        const type = btn.type || 'postback';
        if (!ALLOWED_BUTTON_TYPES.includes(type)) {
          return res.status(400).json({ success: false, error: `Invalid button type "${type}"` });
        }
        btn.type = type;
        if (type === 'web_url') {
          if (!/^https:\/\//i.test(String(btn.url || ''))) {
            return res.status(400).json({ success: false, error: `Button "${btn.label}" of type web_url must have an https:// URL` });
          }
        } else {
          const payload = String(btn.payload || '').trim();
          if (!payload) {
            return res.status(400).json({ success: false, error: `Button "${btn.label}" of type postback must have a payload` });
          }
          btn.payload = ALLOWED_PAYLOADS.includes(payload.toLowerCase()) ? payload.toLowerCase() : payload.slice(0, 64);
        }
      }
    }

    // ── Build the $set path ────────────────────────────────────────────
    const dmConfig = {};
    if (ctaTitle             !== undefined) dmConfig.ctaTitle             = ctaTitle;
    if (ctaSubtitle          !== undefined) dmConfig.ctaSubtitle          = ctaSubtitle;
    if (ctaImageUrl          !== undefined) dmConfig.ctaImageUrl          = ctaImageUrl;
    if (ctaButtons           !== undefined) dmConfig.ctaButtons           = ctaButtons;
    if (triggerKeywords      !== undefined) dmConfig.triggerKeywords      = triggerKeywords;
    if (publicReplyTemplate  !== undefined) dmConfig.publicReplyTemplate  = publicReplyTemplate;
    if (hesitancyKeywords    !== undefined) dmConfig.hesitancyKeywords    = hesitancyKeywords;
    if (whatsappCaptureMessage       !== undefined) dmConfig.whatsappCaptureMessage       = whatsappCaptureMessage;
    if (whatsappCaptureConfirmation  !== undefined) dmConfig.whatsappCaptureConfirmation  = whatsappCaptureConfirmation;

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { $set: { dmConfig } },
      { new: true, select: 'dmConfig' }
    ).lean();

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, data: product.dmConfig || {} });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// LINK / UNLINK INSTAGRAM POST
// ─────────────────────────────────────────────

/**
 * Extract shortcode from a full Instagram URL or a plain shortcode string.
 * Returns the shortcode, or the original string if it is already numeric.
 */
function extractShortcode(input) {
  // Handles both instagram.com/p/SHORTCODE and instagram.com/username/p/SHORTCODE
  const urlMatch = (input || '').match(/instagram\.com\/(?:[^/?#]+\/)?p\/([A-Za-z0-9_-]+)/);
  return urlMatch ? urlMatch[1] : (input || '').trim();
}

/**
 * Resolve the Instagram numeric media ID for a given shortcode using the
 * connected Instagram business account's media list.
 * Returns { numericId, shortcode } or null.
 */
async function resolvePostIds(orgId, rawInput) {
  const shortcode = extractShortcode(rawInput);

  // Already a numeric ID — nothing to resolve
  if (/^\d+$/.test(shortcode)) {
    return { numericId: shortcode, shortcode: null };
  }

  const conn = await PlatformConnection.findOne({
    organization: orgId,
    platform: 'instagram',
    isActive: true,
    status: { $in: ['connected', 'available'] }
  }).sort({ updatedAt: -1 }).select('accessToken platformUserId metadata').lean();

  if (!conn?.accessToken) return null;

  // IGAA tokens (Instagram Login) are valid only for the ISUID (igLoginScopedId),
  // not the global IG business account ID stored in platformUserId.
  const apiUserId = conn.metadata?.igLoginScopedId || conn.platformUserId;
  if (!apiUserId) return null;

  return instagramService.resolveShortcodeToMediaId(apiUserId, conn.accessToken, shortcode);
}

exports.linkPost = async (req, res, next) => {
  try {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ success: false, error: 'postId is required' });

    const orgId = req.user.organization._id;
    const shortcode = extractShortcode(postId);

    // Values to add — always add the raw/shortcode form; also add numeric ID if resolvable
    const idsToAdd = new Set([shortcode]);

    const resolved = await resolvePostIds(orgId, postId);
    if (resolved?.numericId) {
      idsToAdd.add(resolved.numericId);
    }

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, organization: orgId },
      { $addToSet: { instagramPostIds: { $each: [...idsToAdd] } } },
      { new: true }
    );

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

    res.json({
      success: true,
      data: product,
      resolved: resolved ? { shortcode: resolved.shortcode || shortcode, numericId: resolved.numericId } : null
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// RESOLVE POST ID (helper endpoint — returns the numeric media ID for a URL/shortcode)
// ─────────────────────────────────────────────
exports.resolvePostId = async (req, res, next) => {
  try {
    const { postId } = req.query;
    if (!postId) return res.status(400).json({ success: false, error: 'postId query param is required' });

    const orgId = req.user.organization._id;
    const shortcode = extractShortcode(postId);

    // Already numeric
    if (/^\d+$/.test(shortcode)) {
      return res.json({ success: true, data: { numericId: shortcode, shortcode: null, alreadyNumeric: true } });
    }

    const resolved = await resolvePostIds(orgId, postId);
    if (!resolved?.numericId) {
      return res.json({
        success: false,
        error: 'Could not resolve this shortcode to a numeric media ID. Make sure RepMeUp is connected to the Instagram account that owns this post.',
        data: { shortcode }
      });
    }

    res.json({ success: true, data: { shortcode, numericId: resolved.numericId } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// LIST INSTAGRAM MEDIA (for post picker in product wizard step 2)
// ─────────────────────────────────────────────
/**
 * Fetches the last N media items from the connected Instagram account so the
 * user can pick posts from a visual grid rather than manually pasting URLs.
 *
 * Returns an array of: { id, shortcode, mediaType, thumbnailUrl, mediaUrl, caption, timestamp }
 */
exports.getInstagramMedia = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const limit = Math.min(Number(req.query.limit) || 24, 50);

    const conn = await PlatformConnection.findOne({
      organization: orgId,
      platform: 'instagram',
      isActive: true,
      status: { $in: ['connected', 'available'] }
    }).sort({ updatedAt: -1 }).select('accessToken platformUserId platformData metadata').lean();

    if (!conn?.accessToken) {
      return res.status(400).json({
        success: false,
        error: 'No active Instagram connection found. Connect Instagram in Settings → Integrations.'
      });
    }

    // Delegate to instagramService which already knows:
    //   - Instagram Login (IGAA token) → graph.instagram.com/vXX/me/media
    //   - Facebook Login (EAA token)   → graph.facebook.com/vXX/{businessAccountId}/media
    //
    // Previously we always called graph.facebook.com/me/media — that fails for
    // Instagram Login tokens because the correct host is graph.instagram.com.
    const connType    = instagramService._connectionType(conn);
    const apiBase     = instagramService._getApiBase(connType);
    const isIgLogin   = connType === 'instagram_login';
    const businessId  = instagramService._getBusinessAccountId(conn);

    const mediaEndpoint = isIgLogin
      ? `${apiBase}/me/media`
      : `${apiBase}/${businessId}/media`;

    if (!isIgLogin && !businessId) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine Instagram Business Account ID for this connection.'
      });
    }

    const resp = await axios.get(mediaEndpoint, {
      params: {
        fields: 'id,shortcode,media_type,thumbnail_url,media_url,caption,timestamp',
        limit,
        access_token: conn.accessToken
      },
      timeout: 10000
    });

    const raw = resp.data?.data || [];
    const media = raw.map(m => ({
      id:           m.id,
      shortcode:    m.shortcode || null,
      mediaType:    m.media_type,
      thumbnailUrl: m.thumbnail_url || m.media_url || null,
      mediaUrl:     m.media_url || null,
      caption:      (m.caption || '').slice(0, 120),
      timestamp:    m.timestamp
    }));

    res.json({ success: true, data: media });
  } catch (err) {
    const apiErr = err.response?.data?.error;
    if (apiErr) {
      return res.status(400).json({
        success: false,
        error: `Instagram API error: ${apiErr.message || apiErr.code}`,
        details: apiErr
      });
    }
    next(err);
  }
};

exports.unlinkPost = async (req, res, next) => {
  try {
    // Accept postId from body (POST /unlink) or params (DELETE /:postId legacy)
    const postId = req.body?.postId || req.params.postId;

    if (!postId) return res.status(400).json({ success: false, error: 'postId is required' });

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { $pull: { instagramPostIds: String(postId) } },
      { new: true }
    );

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET PRODUCTS BY INSTAGRAM POST ID
// ─────────────────────────────────────────────
exports.getProductsByPost = async (req, res, next) => {
  try {
    const { postId } = req.params;
    const orgId = req.user.organization._id;

    const products = await Product.find({
      organization: orgId,
      instagramPostIds: String(postId),
      isActive: true
    }).lean();

    res.json({ success: true, data: products });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// BACKFILL NUMERIC POST IDS
// POST /products/backfill-post-ids
// Re-resolves all shortcode-only instagramPostIds to also store numeric IDs.
// Safe to run multiple times (uses $addToSet). Useful after reconnecting Instagram.
// ─────────────────────────────────────────────

exports.backfillPostNumericIds = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;

    // Sort by updatedAt desc so the most recently reconnected (freshest token) is used first.
    const conn = await PlatformConnection.findOne({
      organization: orgId,
      platform: 'instagram',
      isActive: true,
      status: { $in: ['connected', 'available'] }
    }).sort({ updatedAt: -1 }).select('accessToken platformUserId metadata').lean();

    if (!conn?.accessToken) {
      return res.status(400).json({
        success: false,
        error: 'No active Instagram connection found. Please reconnect Instagram in Settings → Integrations first.'
      });
    }

    // IGAA tokens (Instagram Login) must be used with the ISUID (igLoginScopedId),
    // NOT the global Instagram business account ID (platformUserId).
    const apiUserId = conn.metadata?.igLoginScopedId || conn.platformUserId;
    if (!apiUserId) {
      return res.status(400).json({
        success: false,
        error: 'Instagram connection is missing the user ID required for API calls. Please reconnect.'
      });
    }

    const products = await Product.find({
      organization: orgId,
      isActive: true,
      instagramPostIds: { $exists: true, $ne: [] }
    }).select('_id name instagramPostIds').lean();

    let resolved = 0;
    let skipped = 0;
    let failed = 0;
    const details = [];

    for (const product of products) {
      const shortcodes = (product.instagramPostIds || []).filter(id => !/^\d+$/.test(String(id)));

      for (const shortcode of shortcodes) {
        try {
          const result = await instagramService.resolveShortcodeToMediaId(
            apiUserId, conn.accessToken, shortcode
          );
          if (result?.numericId) {
            await Product.updateOne(
              { _id: product._id },
              { $addToSet: { instagramPostIds: String(result.numericId) } }
            );
            resolved++;
            details.push({ product: product.name, shortcode, numericId: result.numericId });
          } else {
            skipped++;
          }
        } catch (err) {
          failed++;
          logger.warn('[backfillPostNumericIds] Could not resolve shortcode', {
            shortcode, productId: product._id, err: err.message
          });
        }
      }
    }

    res.json({
      success: true,
      data: { resolved, skipped, failed, details }
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET / UPDATE COMMENT-TO-DM SETTINGS
// ─────────────────────────────────────────────

exports.getCommentToDmSettings = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.user.organization._id)
      .select('commentToDmSettings')
      .lean();

    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    // Merge with defaults so the UI always gets a complete, valid settings object
    // even for orgs that existed before this feature was added.
    const merged = { ...DEFAULT_COMMENT_TO_DM_SETTINGS, ...(org.commentToDmSettings || {}) };
    res.json({ success: true, data: merged });
  } catch (err) {
    next(err);
  }
};

exports.updateCommentToDmSettings = async (req, res, next) => {
  try {
    const allowed = [
      'enabled', 'triggerKeywords', 'publicReplyTemplate', 'dmTemplate',
      'confirmationTemplate', 'deduplicateDms', 'maxDmsPerDay', 'defaultProductId'
    ];
    const update = {};
    allowed.forEach(f => {
      if (req.body[f] !== undefined) update[`commentToDmSettings.${f}`] = req.body[f];
    });

    const org = await Organization.findByIdAndUpdate(
      req.user.organization._id,
      { $set: update },
      { new: true, select: 'commentToDmSettings' }
    );

    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const merged = { ...DEFAULT_COMMENT_TO_DM_SETTINGS, ...(org.commentToDmSettings || {}) };
    res.json({ success: true, data: merged });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET / UPDATE COMMENT → FOLLOW INVITE (Instagram)
// ─────────────────────────────────────────────

exports.getCommentFollowInviteSettings = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.user.organization._id)
      .select('commentFollowInviteSettings')
      .lean();

    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const merged = {
      ...DEFAULT_COMMENT_FOLLOW_INVITE_SETTINGS,
      ...(org.commentFollowInviteSettings || {})
    };
    res.json({ success: true, data: merged });
  } catch (err) {
    next(err);
  }
};

exports.updateCommentFollowInviteSettings = async (req, res, next) => {
  try {
    const allowed = [
      'enabled',
      'title',
      'subtitle',
      'imageUrl',
      'buttonTitle',
      'buttonUrl',
      'publicReplyTemplate',
      'postPublicReply',
      'deduplicateDms',
      'maxDmsPerDay',
      'skipIfProductDmSent',
      'filterNegativeSentiment',
      'filterSalesIntent'
    ];
    const update = {};
    allowed.forEach((f) => {
      if (req.body[f] !== undefined) update[`commentFollowInviteSettings.${f}`] = req.body[f];
    });

    if (req.body.maxDmsPerDay != null) {
      const n = Number(req.body.maxDmsPerDay);
      if (!Number.isFinite(n) || n < 1 || n > 10000) {
        return res.status(400).json({ success: false, error: 'maxDmsPerDay must be between 1 and 10000' });
      }
    }

    const org = await Organization.findByIdAndUpdate(
      req.user.organization._id,
      { $set: update },
      { new: true, select: 'commentFollowInviteSettings' }
    );

    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const merged = {
      ...DEFAULT_COMMENT_FOLLOW_INVITE_SETTINGS,
      ...(org.commentFollowInviteSettings || {})
    };
    res.json({ success: true, data: merged });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// SALES FLOW SETTINGS (Instagram Comment → CTA DM + WhatsApp retargeting)
// ─────────────────────────────────────────────

exports.getSalesFlowSettings = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.user.organization._id)
      .select('salesFlowSettings')
      .lean();

    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const merged = { ...DEFAULT_SALES_FLOW_SETTINGS, ...(org.salesFlowSettings || {}) };
    res.json({ success: true, data: merged });
  } catch (err) {
    next(err);
  }
};

exports.updateSalesFlowSettings = async (req, res, next) => {
  try {
    const allowed = [
      'enabled',
      'ctaTitle',
      'ctaSubtitle',
      'ctaImageUrl',
      'ctaButtons',
      'hesitancyKeywords',
      'whatsappCaptureMessage',
      'whatsappCaptureConfirmation'
    ];

    const update = {};
    allowed.forEach((f) => {
      if (req.body[f] !== undefined) update[`salesFlowSettings.${f}`] = req.body[f];
    });

    // Validate ctaButtons array (max 3 — Instagram Generic Template limit)
    if (req.body.ctaButtons !== undefined) {
      if (!Array.isArray(req.body.ctaButtons)) {
        return res.status(400).json({ success: false, error: 'ctaButtons must be an array' });
      }
      if (req.body.ctaButtons.length > 3) {
        return res.status(400).json({ success: false, error: 'Instagram Generic Template supports a maximum of 3 CTA buttons' });
      }
      const ALLOWED_TYPES = ['postback', 'web_url'];
      const ALLOWED_PAYLOADS = ['details', 'payment', 'hesitant'];
      for (const btn of req.body.ctaButtons) {
        if (!btn || typeof btn.label !== 'string' || !btn.label.trim()) {
          return res.status(400).json({ success: false, error: 'Each CTA button must have a non-empty label' });
        }
        if (String(btn.label).length > 20) {
          return res.status(400).json({ success: false, error: `Button label "${btn.label}" exceeds the 20-character Instagram limit` });
        }

        const type = btn.type || 'postback';
        if (!ALLOWED_TYPES.includes(type)) {
          return res.status(400).json({ success: false, error: `Button type "${type}" is invalid. Use one of: ${ALLOWED_TYPES.join(', ')}` });
        }
        btn.type = type;

        if (type === 'web_url') {
          const url = String(btn.url || '').trim();
          if (!/^https:\/\//i.test(url)) {
            return res.status(400).json({ success: false, error: `Button "${btn.label}" of type web_url must have a URL starting with https://` });
          }
        } else {
          // postback — payload required; canonicalize known actions to lowercase
          const payload = String(btn.payload || '').trim();
          if (!payload) {
            return res.status(400).json({ success: false, error: `Button "${btn.label}" of type postback must have an action payload` });
          }
          // Recognized payloads are normalized; free-form payloads are echoed as text
          const lower = payload.toLowerCase();
          btn.payload = ALLOWED_PAYLOADS.includes(lower) ? lower : payload.slice(0, 64);
        }
      }
    }

    // Validate hesitancyKeywords is an array of strings
    if (req.body.hesitancyKeywords !== undefined) {
      if (!Array.isArray(req.body.hesitancyKeywords)) {
        return res.status(400).json({ success: false, error: 'hesitancyKeywords must be an array' });
      }
    }

    const org = await Organization.findByIdAndUpdate(
      req.user.organization._id,
      { $set: update },
      { new: true, select: 'salesFlowSettings' }
    );

    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const merged = { ...DEFAULT_SALES_FLOW_SETTINGS, ...(org.salesFlowSettings || {}) };
    res.json({ success: true, data: merged });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// IMPORT EXCEL/CSV PRODUCTS
// ─────────────────────────────────────────────
exports.importProducts = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const orgId = req.user.organization._id;
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ success: false, error: 'Empty or invalid file' });
    }

    const bulkOps = [];
    let processedCount = 0;

    for (const row of data) {
      const sku = row['SKU'] ? String(row['SKU']).trim() : null;
      const name = row['Name'] ? String(row['Name']).trim() : null;
      
      if (!name) continue; // Name is required

      const price = Number(row['Price']) || 0;
      const currency = row['Currency'] ? String(row['Currency']).trim() : 'AED';
      const description = row['Description'] ? String(row['Description']).trim() : '';
      const discountPercent = Number(row['Discount']) || 0;
      const stock = row['Stock'] != null && row['Stock'] !== '' ? Number(row['Stock']) : null;
      const paymentUrl = row['Payment URL'] ? String(row['Payment URL']).trim() : '';
      
      const images = row['Images'] ? String(row['Images']).split(',').map(s => s.trim()).filter(Boolean) : [];
      const sizes = row['Sizes'] ? String(row['Sizes']).split(',').map(s => s.trim()).filter(Boolean) : [];
      const colors = row['Colors'] ? String(row['Colors']).split(',').map(s => s.trim()).filter(Boolean) : [];

      const productData = {
        organization: orgId,
        name,
        description,
        price,
        currency,
        discountPercent,
        stock,
        paymentUrl,
        images,
        sizes,
        colors,
        isActive: true,
        createdBy: req.user._id
      };

      if (sku) {
        productData.sku = sku;
        bulkOps.push({
          updateOne: {
            filter: { organization: orgId, sku },
            update: { $set: productData },
            upsert: true
          }
        });
      } else {
        // Fallback to name if no SKU provided
        bulkOps.push({
          updateOne: {
            filter: { organization: orgId, name },
            update: { $set: productData },
            upsert: true
          }
        });
      }

      processedCount++;
    }

    if (bulkOps.length > 0) {
      const result = await Product.bulkWrite(bulkOps);
      res.json({
        success: true,
        data: {
          upsertedCount: result.upsertedCount,
          modifiedCount: result.modifiedCount,
          matchedCount: result.matchedCount,
          totalProcessed: processedCount
        }
      });
    } else {
      res.json({ success: true, data: { upsertedCount: 0, modifiedCount: 0, matchedCount: 0, totalProcessed: 0 } });
    }

  } catch (err) {
    logger.error(`[importProducts] Error: ${err.message}`);
    next(err);
  }
};

// ─────────────────────────────────────────────
// SHARED BULK-WRITE HELPER
// ─────────────────────────────────────────────

/**
 * Build a bulkWrite ops array from a normalised product list and execute it.
 * Each item must have at least { name }. Optional: { sku, price, currency,
 * description, discountPercent, stock, paymentUrl, images, sizes, colors }.
 */
async function runBulkUpsert(items, orgId, userId) {
  const bulkOps = [];
  let processedCount = 0;

  for (const item of items) {
    const name = item.name ? String(item.name).trim() : null;
    if (!name) continue;

    const productData = {
      organization: orgId,
      name,
      description: item.description ? String(item.description).trim() : '',
      price: Number(item.price) || 0,
      currency: item.currency ? String(item.currency).trim() : 'USD',
      discountPercent: Number(item.discountPercent) || 0,
      stock: item.stock != null && item.stock !== '' ? Number(item.stock) : null,
      paymentUrl: item.paymentUrl ? String(item.paymentUrl).trim() : '',
      images: Array.isArray(item.images) ? item.images.filter(Boolean) : [],
      sizes: Array.isArray(item.sizes) ? item.sizes.filter(Boolean) : [],
      colors: Array.isArray(item.colors) ? item.colors.filter(Boolean) : [],
      isActive: true,
      createdBy: userId
    };

    const sku = item.sku ? String(item.sku).trim() : null;
    if (sku) productData.sku = sku;

    bulkOps.push({
      updateOne: {
        filter: sku ? { organization: orgId, sku } : { organization: orgId, name },
        update: { $set: productData },
        upsert: true
      }
    });
    processedCount++;
  }

  if (bulkOps.length === 0) {
    return { upsertedCount: 0, modifiedCount: 0, matchedCount: 0, totalProcessed: 0 };
  }

  const result = await Product.bulkWrite(bulkOps);
  return {
    upsertedCount: result.upsertedCount,
    modifiedCount: result.modifiedCount,
    matchedCount: result.matchedCount,
    totalProcessed: processedCount
  };
}

// ─────────────────────────────────────────────
// IMPORT FROM WOOCOMMERCE
// ─────────────────────────────────────────────
exports.importFromWooCommerce = async (req, res, next) => {
  try {
    const { storeUrl, consumerKey, consumerSecret } = req.body;
    if (!storeUrl || !consumerKey || !consumerSecret) {
      return res.status(400).json({ success: false, error: 'storeUrl, consumerKey and consumerSecret are required' });
    }

    const orgId = req.user.organization._id;
    const base = storeUrl.replace(/\/$/, '');
    const allProducts = [];
    let page = 1;
    const perPage = 100;

    // Paginate through all products
    while (true) {
      const response = await axios.get(`${base}/wp-json/wc/v3/products`, {
        params: { per_page: perPage, page, status: 'publish' },
        auth: { username: consumerKey, password: consumerSecret },
        timeout: 20000
      });

      const batch = response.data;
      if (!Array.isArray(batch) || batch.length === 0) break;
      allProducts.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }

    if (allProducts.length === 0) {
      return res.json({ success: true, data: { upsertedCount: 0, modifiedCount: 0, matchedCount: 0, totalProcessed: 0 } });
    }

    // Normalise WooCommerce → our schema
    const items = allProducts.map(p => ({
      sku: p.sku || null,
      name: p.name || '',
      description: p.short_description
        ? p.short_description.replace(/<[^>]*>/g, '').trim()
        : (p.description ? p.description.replace(/<[^>]*>/g, '').trim() : ''),
      price: parseFloat(p.price) || parseFloat(p.regular_price) || 0,
      currency: 'USD', // WooCommerce doesn't return currency per product
      discountPercent: 0,
      stock: p.manage_stock ? (p.stock_quantity ?? null) : null,
      paymentUrl: p.permalink || '',
      images: (p.images || []).map(img => img.src).filter(Boolean),
      sizes: (p.attributes || [])
        .filter(a => /size/i.test(a.name))
        .flatMap(a => a.options || []),
      colors: (p.attributes || [])
        .filter(a => /colou?r/i.test(a.name))
        .flatMap(a => a.options || [])
    }));

    const summary = await runBulkUpsert(items, orgId, req.user._id);
    res.json({ success: true, data: summary });

  } catch (err) {
    logger.error(`[importFromWooCommerce] Error: ${err.message}`);
    if (err.response) {
      return res.status(502).json({ success: false, error: `WooCommerce API error: ${err.response.status} — ${err.response.data?.message || 'unexpected response'}` });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────
// IMPORT FROM SHOPIFY
// ─────────────────────────────────────────────
exports.importFromShopify = async (req, res, next) => {
  try {
    const { storeDomain, accessToken } = req.body;
    if (!storeDomain || !accessToken) {
      return res.status(400).json({ success: false, error: 'storeDomain and accessToken are required' });
    }

    const orgId = req.user.organization._id;
    const domain = storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const allProducts = [];
    let pageInfo = null;

    // Shopify cursor-based pagination
    while (true) {
      const params = { limit: 250, status: 'active', fields: 'id,title,body_html,variants,images' };
      if (pageInfo) params.page_info = pageInfo;

      const response = await axios.get(`https://${domain}/admin/api/2024-01/products.json`, {
        params,
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 20000
      });

      const batch = response.data.products || [];
      allProducts.push(...batch);

      // Extract next page cursor from Link header
      const linkHeader = response.headers['link'] || '';
      const nextMatch = linkHeader.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
      } else {
        break;
      }
    }

    if (allProducts.length === 0) {
      return res.json({ success: true, data: { upsertedCount: 0, modifiedCount: 0, matchedCount: 0, totalProcessed: 0 } });
    }

    // Normalise Shopify → our schema
    const items = allProducts.map(p => {
      const variant = (p.variants || [])[0] || {};
      return {
        sku: variant.sku || null,
        name: p.title || '',
        description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').trim() : '',
        price: parseFloat(variant.price) || 0,
        currency: 'USD',
        discountPercent: variant.compare_at_price && parseFloat(variant.compare_at_price) > parseFloat(variant.price)
          ? Math.round((1 - parseFloat(variant.price) / parseFloat(variant.compare_at_price)) * 100)
          : 0,
        stock: variant.inventory_quantity != null ? variant.inventory_quantity : null,
        paymentUrl: '',
        images: (p.images || []).map(img => img.src).filter(Boolean),
        sizes: (p.variants || [])
          .map(v => v.option1)
          .filter(v => v && !/^\d/.test(v)), // crude: skip pure-numeric variant options (prices)
        colors: []
      };
    });

    const summary = await runBulkUpsert(items, orgId, req.user._id);
    res.json({ success: true, data: summary });

  } catch (err) {
    logger.error(`[importFromShopify] Error: ${err.message}`);
    if (err.response) {
      return res.status(502).json({ success: false, error: `Shopify API error: ${err.response.status} — ${err.response.data?.errors || 'unexpected response'}` });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────
// IMPORT FROM CUSTOM API URL
// ─────────────────────────────────────────────
exports.importFromUrl = async (req, res, next) => {
  try {
    const { url, authHeader } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'url is required' });
    }

    const orgId = req.user.organization._id;

    const headers = { Accept: 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    const response = await axios.get(url, { headers, timeout: 20000 });
    let raw = response.data;

    // Unwrap common envelope shapes: { data: [...] }, { products: [...] }, { items: [...] }
    if (!Array.isArray(raw)) {
      raw = raw.data || raw.products || raw.items || raw.results || Object.values(raw).find(Array.isArray) || [];
    }

    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(422).json({ success: false, error: 'Could not find a product array in the API response. Make sure the endpoint returns an array of products (or wraps it in a "data", "products", or "items" key).' });
    }

    // Best-effort field mapping — accepts both snake_case and camelCase keys
    const items = raw.map(p => ({
      sku: p.sku || p.SKU || null,
      name: p.name || p.title || p.product_name || '',
      description: p.description || p.body_html || p.short_description || '',
      price: parseFloat(p.price || p.sale_price || p.regular_price || 0) || 0,
      currency: p.currency || p.currency_code || 'USD',
      discountPercent: Number(p.discountPercent || p.discount_percent || p.discount || 0) || 0,
      stock: p.stock != null ? Number(p.stock) : (p.stock_quantity != null ? Number(p.stock_quantity) : null),
      paymentUrl: p.paymentUrl || p.payment_url || p.permalink || p.url || '',
      images: Array.isArray(p.images) ? p.images.map(img => (typeof img === 'string' ? img : img.src || img.url || '')).filter(Boolean)
        : (p.image ? [p.image] : []),
      sizes: Array.isArray(p.sizes) ? p.sizes : (p.sizes ? String(p.sizes).split(',').map(s => s.trim()).filter(Boolean) : []),
      colors: Array.isArray(p.colors) ? p.colors : (p.colors ? String(p.colors).split(',').map(s => s.trim()).filter(Boolean) : [])
    }));

    const summary = await runBulkUpsert(items, orgId, req.user._id);
    res.json({ success: true, data: summary });

  } catch (err) {
    logger.error(`[importFromUrl] Error: ${err.message}`);
    if (err.response) {
      return res.status(502).json({ success: false, error: `Remote API error: ${err.response.status} — ${err.response.statusText}` });
    }
    next(err);
  }
};

