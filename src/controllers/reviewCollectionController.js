/**
 * Review Collection Controller
 * Manage review request settings and statistics.
 */
const ReviewRequestSettings = require('../models/ReviewRequestSettings');
const ReviewRequest = require('../models/ReviewRequest');
const logger = require('../config/logger');

const DAY_MS = 24 * 60 * 60 * 1000;

exports.getSettings = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    let settings = await ReviewRequestSettings.findOne({ organization: orgId }).lean();
    if (!settings) {
      settings = {
        organization: orgId,
        platforms: [
          { key: 'google', active: false },
          { key: 'facebook', active: false },
          { key: 'custom', active: false }
        ],
        trigger: 'after_purchase',
        delayDays: 3,
        channels: ['whatsapp'],
        language: 'en',
        message: 'Hi {{customer_name}}! 😊 We hope you loved your experience. If you have a moment, we\'d really appreciate a quick review. {{review_link}}',
        sendReminders: false,
        reminderCount: 1,
        ignoreNegativeRating: true,
        excludeRecentReviewers: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00'
      };
    }
    return res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;

    const allowed = [
      'enabled', 'platforms', 'trigger', 'delayDays', 'channels',
      'language', 'message', 'sendReminders', 'reminderCount', 'reminderDelayDays',
      'ignoreNegativeRating', 'excludeRecentReviewers', 'recentReviewerDays',
      'quietHoursStart', 'quietHoursEnd', 'maxDailyRequests'
    ];
    const payload = { organization: orgId };
    for (const key of allowed) {
      if (req.body[key] !== undefined) payload[key] = req.body[key];
    }

    const settings = await ReviewRequestSettings.findOneAndUpdate(
      { organization: orgId },
      { $set: payload },
      { new: true, upsert: true, runValidators: true }
    ).lean();
    return res.json({ success: true, data: settings });
  } catch (err) {
    logger.error('[reviewCollectionController] updateSettings error', { error: err.message });
    next(err);
  }
};

exports.getStats = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const since = new Date(Date.now() - 7 * DAY_MS);
    const prevSince = new Date(Date.now() - 14 * DAY_MS);

    const [sentNow, sentPrev, receivedNow, receivedPrev, avgRatingAgg] = await Promise.all([
      ReviewRequest.countDocuments({ organization: orgId, sentAt: { $gte: since } }),
      ReviewRequest.countDocuments({ organization: orgId, sentAt: { $gte: prevSince, $lt: since } }),
      ReviewRequest.countDocuments({ organization: orgId, reviewSubmittedAt: { $gte: since } }),
      ReviewRequest.countDocuments({ organization: orgId, reviewSubmittedAt: { $gte: prevSince, $lt: since } }),
      ReviewRequest.aggregate([
        { $match: { organization: orgId, rating: { $exists: true, $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$rating' } } }
      ])
    ]);

    const convRate = sentNow > 0 ? Math.round((receivedNow / sentNow) * 100) : 0;
    const avgRaw = avgRatingAgg[0]?.avg;
    const avgRating = avgRaw != null ? Math.round(Number(avgRaw) * 10) / 10 : 0;

    return res.json({
      success: true,
      data: {
        requestsSent: { value: sentNow, change: _pct(sentNow, sentPrev) },
        reviewsReceived: { value: receivedNow, change: _pct(receivedNow, receivedPrev) },
        conversionRate: convRate,
        avgRating,
        totalReviews: await ReviewRequest.countDocuments({ organization: orgId, reviewSubmittedAt: { $exists: true } })
      }
    });
  } catch (err) {
    next(err);
  }
};

function _pct(now, prev) {
  if (!prev) return now > 0 ? 100 : 0;
  return Math.round(((now - prev) / prev) * 100);
}
