/**
 * Growth Intelligence Routes — Phase 2 (authenticated)
 *
 * Mounted at: /api/growth-intelligence
 * Auth:       JWT required (protect middleware)
 *
 * GET  /dashboard           — full live dashboard payload
 * GET  /trends              — historical daily snapshots (30/60/90 days)
 * POST /snapshot            — manually trigger today's snapshot save
 */

const express  = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middlewares/auth');
const { getDashboard, saveSnapshot, getTrends } = require('../services/growthIntelligence/liveMetricsService');
const logger = require('../config/logger');

const router = express.Router();

// Rate limit: 30 requests / 5 minutes per org (prevents accidental hammering)
const dashboardLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: req => String(req.user?.organization || req.ip),
  handler: (req, res) => res.status(429).json({ success: false, error: 'Too many requests. Please wait.' })
});

router.use(protect);

// ── GET /dashboard ────────────────────────────────────────────────────────────
router.get('/dashboard', dashboardLimiter, async (req, res) => {
  try {
    // Normalize: req.user.organization may be an ObjectId, string, or populated object
    const orgId        = req.user.organization?._id || req.user.organization;
    const days         = Math.min(parseInt(req.query.days) || 30, 90);
    const industry     = req.query.industry || req.user?.industryHint || 'general';
    const avgOrderValue = parseFloat(req.query.avgOrderValue) || 0;
    const withAI       = req.query.withAI === 'true';

    const dashboard = await getDashboard(orgId, { days, industry, avgOrderValue, withAI });

    // Persist today's snapshot in the background (non-blocking)
    saveSnapshot(orgId, dashboard).catch(e =>
      logger.warn('[GrowthIntelligence] background snapshot failed', { error: e.message })
    );

    return res.json({ success: true, dashboard });
  } catch (err) {
    logger.error('[GrowthIntelligence] dashboard error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load dashboard data.' });
  }
});

// ── GET /trends ───────────────────────────────────────────────────────────────
router.get('/trends', async (req, res) => {
  try {
    const orgId = req.user.organization?._id || req.user.organization;
    const days  = Math.min(parseInt(req.query.days) || 30, 90);
    const trend = await getTrends(orgId, days);
    return res.json({ success: true, trend });
  } catch (err) {
    logger.error('[GrowthIntelligence] trends error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load trend data.' });
  }
});

// ── POST /snapshot ────────────────────────────────────────────────────────────
router.post('/snapshot', async (req, res) => {
  try {
    const orgId     = req.user.organization?._id || req.user.organization;
    const industry  = req.body.industry || 'general';
    const avgOrderValue = parseFloat(req.body.avgOrderValue) || 0;
    const dashboard = await getDashboard(orgId, { days: 1, industry, avgOrderValue });
    await saveSnapshot(orgId, dashboard);
    return res.json({ success: true, message: 'Snapshot saved.' });
  } catch (err) {
    logger.error('[GrowthIntelligence] snapshot error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to save snapshot.' });
  }
});

module.exports = router;
