const Product = require('../models/Product');
const Organization = require('../models/Organization');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');

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

    res.status(201).json({ success: true, data: product });
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
    allowedFields.forEach(f => {
      if (req.body[f] !== undefined) product[f] = req.body[f];
    });

    await product.save();
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// DELETE (soft)
// ─────────────────────────────────────────────
exports.deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, organization: req.user.organization._id },
      { isActive: false },
      { new: true }
    );

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, message: 'Product deleted' });
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
  const urlMatch = (input || '').match(/instagram\.com\/p\/([A-Za-z0-9_-]+)/);
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
    isConnected: true
  }).select('accessToken platformUserId').lean();

  if (!conn?.accessToken || !conn?.platformUserId) return null;

  return instagramService.resolveShortcodeToMediaId(conn.platformUserId, conn.accessToken, shortcode);
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

exports.unlinkPost = async (req, res, next) => {
  try {
    const { postId } = req.params;

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
// DIAGNOSTIC: DRY-RUN TEST AUTOMATION
// ─────────────────────────────────────────────

/**
 * @desc    Runs a dry-run of the comment-to-DM automation and returns a step-by-step checklist.
 *          Does NOT send any real DMs. Helps users diagnose why automation isn't firing.
 * @route   POST /api/products/debug/test-automation
 * @access  Private
 */
exports.testAutomation = async (req, res, next) => {
  try {
    const { postId, commentText = 'price' } = req.body;
    const organizationId = req.user.organization._id.toString();

    const { dryRunDiagnostic } = require('../services/commentToDmService');
    const result = await dryRunDiagnostic(organizationId, postId, commentText);

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};
