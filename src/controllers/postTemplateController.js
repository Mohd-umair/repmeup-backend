const PostTemplate = require('../models/PostTemplate');
const defaultTemplates = require('../config/defaultPostTemplates');

async function ensureDefaults() {
  const count = await PostTemplate.countDocuments({ isGlobal: true });
  if (count === 0) {
    await PostTemplate.insertMany(defaultTemplates);
    console.log(`[PostTemplate] Seeded ${defaultTemplates.length} default templates`);
  }
}

exports.list = async (req, res) => {
  try {
    await ensureDefaults();
    const orgId = req.user.organization?._id || req.user.organization;
    const templates = await PostTemplate.find({
      $or: [{ isGlobal: true }, { organization: orgId }]
    }).sort({ isGlobal: -1, category: 1, createdAt: -1 }).lean();
    res.json({ success: true, data: templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const template = await PostTemplate.findOne({
      _id: req.params.id,
      $or: [{ isGlobal: true }, { organization: orgId }]
    }).lean();
    if (!template) return res.status(404).json({ success: false, error: 'Template not found' });
    res.json({ success: true, data: template });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const { name, category, description, aspectRatio, canvasState, thumbnailUrl } = req.body;
    const template = await PostTemplate.create({
      name, category, description, aspectRatio, canvasState, thumbnailUrl,
      organization: orgId,
      isGlobal: false
    });
    res.status(201).json({ success: true, data: template });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const doc = await PostTemplate.findOneAndDelete({
      _id: req.params.id,
      organization: orgId,
      isGlobal: false
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Template not found or is a global template' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
