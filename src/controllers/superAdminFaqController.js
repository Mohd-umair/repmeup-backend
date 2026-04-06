const publicFaqService = require('../services/publicFaqService');
const FaqCategory = require('../models/FaqCategory');

exports.listFaqs = async (req, res, next) => {
  try {
    const data = await publicFaqService.listPublicDto();
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/super-admin/faqs
 * Body: { categories: [...] } — full replace by category id
 */
exports.syncFaqs = async (req, res, next) => {
  try {
    const { categories } = req.body || {};
    const data = await publicFaqService.syncCategories(categories);
    res.status(200).json({ success: true, data, message: 'FAQs updated' });
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next(err);
  }
};

/**
 * POST /api/super-admin/faqs/seed-defaults
 * Body: { force?: boolean } — if force, wipe and re-insert defaults; else only when empty
 */
exports.seedDefaults = async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    const count = await FaqCategory.countDocuments();
    if (count > 0 && !force) {
      return res.status(400).json({
        success: false,
        error: 'FAQs already exist. Pass { "force": true } to replace all with defaults.',
      });
    }
    await publicFaqService.seedFromDefaults({ force });
    const data = await publicFaqService.listPublicDto();
    res.status(200).json({
      success: true,
      data,
      message: count > 0 && force ? 'Replaced with default FAQ content' : 'Default FAQs seeded',
    });
  } catch (err) {
    next(err);
  }
};
