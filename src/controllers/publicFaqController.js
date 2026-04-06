const publicFaqService = require('../services/publicFaqService');

/**
 * GET /api/public/faqs — unauthenticated; seeds defaults if DB empty.
 */
exports.listFaqs = async (req, res, next) => {
  try {
    let data = await publicFaqService.listPublicDto();
    if (data.length === 0) {
      await publicFaqService.seedFromDefaults({ force: false });
      data = await publicFaqService.listPublicDto();
    }
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
