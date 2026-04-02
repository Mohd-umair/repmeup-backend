const IntentBucket = require('../models/IntentBucket');
const Interaction = require('../models/Interaction');
const { parsePagination, paginationMeta } = require('../utils/pagination');

const DEFAULT_BUCKETS = [
  { name: 'Hot Leads', color: '#EF4444', icon: 'fas fa-fire', order: 0, keywords: ['price', 'buy', 'purchase', 'deal', 'quote', 'order', 'interested', 'cost', 'pricing', 'rates'], aiPromptHint: 'Messages showing purchase intent, asking about pricing, deals, or expressing interest in buying', isDefault: false },
  { name: 'Complaints', color: '#F59E0B', icon: 'fas fa-exclamation-triangle', order: 1, keywords: ['broken', 'damaged', 'refund', 'worst', 'terrible', 'not working', 'disappointed', 'poor', 'bad experience', 'issue', 'problem'], aiPromptHint: 'Messages expressing dissatisfaction, reporting problems, or requesting refunds', isDefault: false },
  { name: 'Sales Opportunities', color: '#8B5CF6', icon: 'fas fa-dollar-sign', order: 2, keywords: ['discount', 'bulk', 'wholesale', 'partnership', 'reseller', 'collaborate', 'distributor', 'b2b'], aiPromptHint: 'Messages about business partnerships, bulk orders, wholesale inquiries, or collaboration opportunities', isDefault: false },
  { name: 'General Queries', color: '#3B82F6', icon: 'fas fa-comments', order: 3, keywords: [], aiPromptHint: 'General questions, information requests, or messages that do not fit other categories', isDefault: true }
];

/**
 * Seed default buckets for an organization if none exist.
 * Returns the list of buckets (existing or newly created).
 */
async function ensureDefaultBuckets(organizationId, userId) {
  const existing = await IntentBucket.find({ organization: organizationId }).lean();
  if (existing.length > 0) return existing;

  const docs = DEFAULT_BUCKETS.map(b => ({
    ...b,
    organization: organizationId,
    createdBy: userId
  }));
  const created = await IntentBucket.insertMany(docs);
  return created;
}

exports.getBuckets = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const { page, limit, skip } = parsePagination(req.query);

    // Ensure defaults exist before paginating
    const existingCount = await IntentBucket.countDocuments({ organization: orgId });
    if (existingCount === 0) {
      await ensureDefaultBuckets(orgId, req.user._id);
    }

    const [total, buckets] = await Promise.all([
      IntentBucket.countDocuments({ organization: orgId }),
      IntentBucket.find({ organization: orgId })
        .sort({ order: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    res.json({ success: true, data: buckets, pagination: paginationMeta(total, page, limit) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.createBucket = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const { name, color, icon, keywords, aiPromptHint, isDefault, replyEnabled, replyTone, replyLanguage, replyPrompt } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Bucket name is required' });
    }

    const maxOrder = await IntentBucket.findOne({ organization: orgId }).sort({ order: -1 }).select('order').lean();
    const nextOrder = (maxOrder?.order ?? -1) + 1;

    if (isDefault) {
      await IntentBucket.updateMany({ organization: orgId, isDefault: true }, { isDefault: false });
    }

    const bucket = await IntentBucket.create({
      organization: orgId,
      name: name.trim(),
      color: color || '#3B82F6',
      icon: icon || 'fas fa-tag',
      order: nextOrder,
      keywords: (keywords || []).map(k => k.trim().toLowerCase()).filter(Boolean),
      aiPromptHint: aiPromptHint || '',
      isDefault: !!isDefault,
      replyEnabled: replyEnabled !== false,
      replyTone: replyTone || null,
      replyLanguage: replyLanguage || 'auto',
      replyPrompt: replyPrompt || '',
      createdBy: req.user._id
    });

    res.status(201).json({ success: true, data: bucket });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'A bucket with this name already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateBucket = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const { name, color, icon, keywords, aiPromptHint, isDefault, isActive, replyEnabled, replyTone, replyLanguage, replyPrompt } = req.body;

    const bucket = await IntentBucket.findOne({ _id: req.params.id, organization: orgId });
    if (!bucket) {
      return res.status(404).json({ success: false, error: 'Bucket not found' });
    }

    if (name !== undefined) bucket.name = name.trim();
    if (color !== undefined) bucket.color = color;
    if (icon !== undefined) bucket.icon = icon;
    if (keywords !== undefined) bucket.keywords = keywords.map(k => k.trim().toLowerCase()).filter(Boolean);
    if (aiPromptHint !== undefined) bucket.aiPromptHint = aiPromptHint;
    if (isActive !== undefined) bucket.isActive = isActive;
    if (replyEnabled !== undefined) bucket.replyEnabled = replyEnabled;
    if (replyTone !== undefined) bucket.replyTone = replyTone || null;
    if (replyLanguage !== undefined) bucket.replyLanguage = replyLanguage;
    if (replyPrompt !== undefined) bucket.replyPrompt = replyPrompt;

    if (isDefault === true) {
      await IntentBucket.updateMany({ organization: orgId, isDefault: true, _id: { $ne: bucket._id } }, { isDefault: false });
      bucket.isDefault = true;
    }

    await bucket.save();
    res.json({ success: true, data: bucket });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'A bucket with this name already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteBucket = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const bucket = await IntentBucket.findOne({ _id: req.params.id, organization: orgId });
    if (!bucket) {
      return res.status(404).json({ success: false, error: 'Bucket not found' });
    }

    const defaultBucket = await IntentBucket.findOne({ organization: orgId, isDefault: true, _id: { $ne: bucket._id } });

    if (defaultBucket) {
      await Interaction.updateMany(
        { organization: orgId, intentBucket: bucket._id },
        { intentBucket: defaultBucket._id, bucketAssignedBy: 'manual' }
      );
    } else {
      await Interaction.updateMany(
        { organization: orgId, intentBucket: bucket._id },
        { $unset: { intentBucket: 1 }, bucketAssignedBy: 'manual' }
      );
    }

    await IntentBucket.deleteOne({ _id: bucket._id });
    res.json({ success: true, message: 'Bucket deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.reorderBuckets = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const { order } = req.body; // Array of { id, order }

    if (!Array.isArray(order)) {
      return res.status(400).json({ success: false, error: 'order must be an array of { id, order }' });
    }

    const bulkOps = order.map(item => ({
      updateOne: {
        filter: { _id: item.id, organization: orgId },
        update: { order: item.order }
      }
    }));

    await IntentBucket.bulkWrite(bulkOps);

    const buckets = await IntentBucket.find({ organization: orgId }).sort({ order: 1 }).lean();
    res.json({ success: true, data: buckets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.ensureDefaultBuckets = ensureDefaultBuckets;
