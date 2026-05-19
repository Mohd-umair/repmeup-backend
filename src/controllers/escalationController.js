/**
 * Escalation Controller
 * CRUD for escalation settings + analytics endpoints.
 * The escalation engine lives in services/escalationService.js (unchanged).
 */
const Organization = require('../models/Organization');
const Interaction = require('../models/Interaction');
const logger = require('../config/logger');

const DAY_MS = 24 * 60 * 60 * 1000;

// ── GET settings ──────────────────────────────────────────────────────────────
exports.getSettings = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.user.organization._id)
      .select('escalationSettings')
      .lean();
    return res.json({ success: true, data: org?.escalationSettings || {} });
  } catch (err) {
    next(err);
  }
};

// ── PUT settings ──────────────────────────────────────────────────────────────
exports.updateSettings = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const flatAllowed = [
      'enabled', 'maxAutoReplies', 'escalateOnNegative', 'negativeThreshold',
      'escalationKeywords', 'lowConfidenceThreshold', 'lowConfidenceCount',
      'assignmentMethod', 'autoAssign', 'notifyAgents', 'notificationChannels',
      'handoffMessageTemplate', 'businessHours', 'availableAgents'
    ];
    // Nested objects saved as full subdocument replacement
    const nestedAllowed = ['triggers', 'routing', 'notifications'];

    const update = {};

    // Accept handoffMessage as an alias for handoffMessageTemplate
    if (req.body.handoffMessage !== undefined && req.body.handoffMessageTemplate === undefined) {
      update['escalationSettings.handoffMessageTemplate'] = req.body.handoffMessage;
    }

    for (const key of flatAllowed) {
      if (req.body[key] !== undefined) {
        update[`escalationSettings.${key}`] = req.body[key];
      }
    }
    for (const key of nestedAllowed) {
      if (req.body[key] !== null && typeof req.body[key] === 'object' && !Array.isArray(req.body[key])) {
        update[`escalationSettings.${key}`] = req.body[key];
      }
    }
    const org = await Organization.findByIdAndUpdate(
      orgId,
      { $set: update },
      { new: true, runValidators: true }
    ).select('escalationSettings').lean();

    return res.json({ success: true, data: org?.escalationSettings });
  } catch (err) {
    logger.error('[escalationController] updateSettings error', { error: err.message });
    next(err);
  }
};

// ── GET stats (last 7 days) ──────────────────────────────────────────────────
exports.getStats = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const since = new Date(Date.now() - 7 * DAY_MS);
    const prevSince = new Date(Date.now() - 14 * DAY_MS);

    // Interaction uses requiresHumanResponse (not isEscalated)
    const [totalNow, totalPrev, resolvedNow, resolvedPrev] = await Promise.all([
      Interaction.countDocuments({ organization: orgId, requiresHumanResponse: true, createdAt: { $gte: since } }),
      Interaction.countDocuments({ organization: orgId, requiresHumanResponse: true, createdAt: { $gte: prevSince, $lt: since } }),
      Interaction.countDocuments({ organization: orgId, requiresHumanResponse: true, status: 'resolved', updatedAt: { $gte: since } }),
      Interaction.countDocuments({ organization: orgId, requiresHumanResponse: true, status: 'resolved', updatedAt: { $gte: prevSince, $lt: since } })
    ]);

    // Average response time from escalation to resolution (escalatedAt is top-level on Interaction)
    const avgResponsePipeline = await Interaction.aggregate([
      {
        $match: {
          organization: orgId,
          requiresHumanResponse: true,
          escalatedAt: { $gte: since },
          status: 'resolved'
        }
      },
      {
        $project: {
          responseMs: {
            $subtract: [{ $ifNull: ['$updatedAt', new Date()] }, { $ifNull: ['$escalatedAt', '$createdAt'] }]
          }
        }
      },
      { $group: { _id: null, avgMs: { $avg: '$responseMs' } } }
    ]).catch(() => []);

    const avgMs = avgResponsePipeline[0]?.avgMs ?? 0;
    const avgMinutes = Math.round(avgMs / 60000);
    const avgSeconds = Math.round((avgMs % 60000) / 1000);

    const slaMet = totalNow > 0 ? Math.round((resolvedNow / totalNow) * 100) : 0;

    return res.json({
      success: true,
      data: {
        totalEscalated: { value: totalNow, change: _pct(totalNow, totalPrev) },
        resolved: { value: resolvedNow, change: _pct(resolvedNow, resolvedPrev) },
        avgResponseTime: `${avgMinutes}m ${avgSeconds}s`,
        slaMet
      }
    });
  } catch (err) {
    next(err);
  }
};

// ── GET breakdown (by trigger reason) ─────────────────────────────────────────
exports.getBreakdown = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const since = new Date(Date.now() - 7 * DAY_MS);

    // escalationType matches Interaction model enum
    const breakdown = await Interaction.aggregate([
      { $match: { organization: orgId, requiresHumanResponse: true, createdAt: { $gte: since } } },
      { $group: { _id: '$escalationType', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).catch(() => []);

    const total = breakdown.reduce((s, r) => s + r.count, 0);

    const LABELS = {
      ai_confidence: 'Low AI Confidence',
      sentiment: 'Negative Sentiment',
      keyword: 'Keywords / Intent',
      reply_limit: 'Repeated Messages',
      intent_routing: 'Intent Routing',
      ai_unresolvable: 'AI Unable to Resolve',
      ai_no_kb_fallback: 'No Knowledge Base Match',
      manual: 'Manual Escalation',
      auto: 'Auto Escalation'
    };

    return res.json({
      success: true,
      data: {
        total,
        items: breakdown.map(r => ({
          reason: r._id || 'other',
          label: LABELS[r._id] || 'Others',
          count: r.count,
          pct: total > 0 ? Math.round((r.count / total) * 100) : 0
        }))
      }
    });
  } catch (err) {
    next(err);
  }
};

// ── GET top reasons ───────────────────────────────────────────────────────────
exports.getTopReasons = async (req, res, next) => {
  try {
    const orgId = req.user.organization._id;
    const since = new Date(Date.now() - 7 * DAY_MS);

    // Group by escalationType (actual schema field); map human-readable labels
    const top = await Interaction.aggregate([
      { $match: { organization: orgId, requiresHumanResponse: true, createdAt: { $gte: since } } },
      { $group: { _id: '$escalationType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]).catch(() => []);

    const total = top.reduce((s, r) => s + r.count, 0);

    return res.json({
      success: true,
      data: top.map((r, i) => ({
        rank: i + 1,
        label: r._id || 'Other',
        count: r.count,
        pct: total > 0 ? Math.round((r.count / total) * 100) : 0
      }))
    });
  } catch (err) {
    next(err);
  }
};

function _pct(now, prev) {
  if (!prev) return now > 0 ? 100 : 0;
  return Math.round(((now - prev) / prev) * 100);
}
