/**
 * Growth Intelligence Audit — public routes (no JWT required).
 *
 * Mounted at /api/public/growth-audit in app.js.
 *
 * Rate limiting: 5 audit-create requests per IP per hour (dedicated limiter).
 * Lead capture and polling are on a looser limiter (30/hour).
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');

const GrowthAudit = require('../models/GrowthAudit');
const { publicAuditQueue, queueConfig } = require('../config/queue');
const { listIndustries } = require('../services/audit/industryBenchmarks');
const leadCaptureService = require('../services/crm/leadCaptureService');
const logger = require('../config/logger');

const router = express.Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => req.ip,
  message: { success: false, error: 'Too many audit requests from this IP. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development'
});

const genericLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development'
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex').slice(0, 16);
}

/**
 * Shape the audit doc for API response.
 * fullAccess = lead has been captured — expose all modules.
 * Otherwise expose only score, grade, revenueLeak number + blurred teasers.
 */
function formatAudit(audit, fullAccess = false) {
  const base = {
    id:          String(audit._id),
    status:      audit.status,
    score:       audit.score,
    grade:       audit.grade,
    businessName:audit.businessName,
    industry:    audit.industry,
    igHandle:    audit.igHandle,
    fbPageUrl:   audit.fbPageUrl,
    googleQuery: audit.googleQuery,
    errorMessage:audit.errorMessage,
    leadCaptured:audit.leadCaptured,
    createdAt:   audit.createdAt
  };

  if (audit.status === 'done' || audit.status === 'partial') {
    // Always show the top-line numbers (the "slap") — revenue leak and social teaser
    base.revenueLeak = audit.modules?.revenueLeak?.number || 0;
    base.revenueLeakFormula = audit.modules?.revenueLeak?.formula || '';
    base.unansweredBuying = audit.modules?.revenueLeak?.unansweredBuying || 0;

    // Teaser metrics visible before lead capture (only for audited platforms)
    base.teaser = {};
    if (audit.igHandle) {
      base.teaser.igReplyRate = audit.modules?.socialPresence?.igReplyRate;
      base.teaser.buyingIntentCount = audit.modules?.socialPresence?.igBuyingIntentCount;
    }
    if (audit.googleQuery) {
      base.teaser.googleRating = audit.modules?.reputation?.google?.rating;
      base.teaser.googleReviews = audit.modules?.reputation?.google?.totalReviews;
      base.teaser.googleReplyRate = audit.modules?.reputation?.google?.ownerReplyRate;
    }

    if (fullAccess) {
      base.modules         = audit.modules;
      base.benchmarks      = audit.benchmarks;
      base.shareToken      = audit.shareToken;
    }
  }

  return base;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /industries
 * Return available industry options for the landing form dropdown.
 */
router.get('/industries', genericLimiter, (req, res) => {
  res.json({ success: true, industries: listIndustries() });
});

/**
 * POST /
 * Create a new audit and enqueue it.
 * Deduplicates by igHandle + industry within 48h to prevent redundant provider calls.
 */
router.post('/', createLimiter, async (req, res) => {
  try {
    const {
      igHandle,
      fbPageUrl,
      googleQuery,
      businessName,
      industry,
      avgOrderValue
    } = req.body;

    if (!igHandle?.trim() && !fbPageUrl?.trim() && !googleQuery?.trim()) {
      return res.status(400).json({
        success: false,
        error: 'At least one platform is required (Instagram, Facebook, or Google).'
      });
    }

    const normalizedHandle = (igHandle || '').replace(/^@/, '').trim().toLowerCase();
    const normalizedFbUrl = (fbPageUrl || '').trim();
    const normalizedGoogleQuery = (googleQuery || '').trim();
    const normalizedIndustry = (industry || 'general').toLowerCase();

    // Deduplicate: return cached audit if a completed one exists for same handle in last 48h
    if (normalizedHandle) {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const existing = await GrowthAudit.findOne({
        igHandle: normalizedHandle,
        industry: normalizedIndustry,
        status: { $in: ['done', 'partial'] },
        createdAt: { $gte: cutoff }
      }).select('_id status score grade leadCaptured modules.revenueLeak.number errorMessage businessName industry igHandle createdAt').lean();

      if (existing) {
        logger.info('[GrowthAudit] returning cached result', { auditId: String(existing._id) });
        return res.json({ success: true, auditId: String(existing._id), cached: true });
      }
    }

    const auditDoc = new GrowthAudit({
      igHandle:      normalizedHandle || undefined,
      fbPageUrl:     normalizedFbUrl || undefined,
      googleQuery:   normalizedGoogleQuery || undefined,
      businessName:  businessName?.trim() || normalizedHandle || 'Your Business',
      industry:      normalizedIndustry,
      avgOrderValue: parseFloat(avgOrderValue) || 0,
      ipHash:        hashIp(req.ip),
      expiresAt:     new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days TTL
    });

    await auditDoc.save();

    await publicAuditQueue.add(
      { auditId: String(auditDoc._id) },
      { ...queueConfig, attempts: 2 }
    );

    logger.info('[GrowthAudit] enqueued', {
      auditId: String(auditDoc._id),
      igHandle: normalizedHandle,
      industry: normalizedIndustry
    });

    res.json({ success: true, auditId: String(auditDoc._id), cached: false });
  } catch (err) {
    logger.error('[GrowthAudit] create error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to start audit. Please try again.' });
  }
});

/**
 * GET /:id
 * Poll audit status. Returns teaser data pre-lead, full data post-lead.
 */
router.get('/:id', genericLimiter, async (req, res) => {
  try {
    const audit = await GrowthAudit.findById(req.params.id).lean();
    if (!audit) return res.status(404).json({ success: false, error: 'Audit not found.' });

    const full = !!audit.leadCaptured;
    return res.json({ success: true, audit: formatAudit(audit, full) });
  } catch (err) {
    logger.error('[GrowthAudit] poll error', { id: req.params.id, error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch audit.' });
  }
});

/**
 * POST /:id/lead
 * Capture lead details and unlock the full report.
 */
router.post('/:id/lead', genericLimiter, async (req, res) => {
  try {
    const { name, email, phone, business } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' });
    }

    const audit = await GrowthAudit.findById(req.params.id);
    if (!audit) return res.status(404).json({ success: false, error: 'Audit not found.' });

    if (audit.status === 'queued' || audit.status === 'processing') {
      return res.status(202).json({ success: false, error: 'Audit is still processing. Please wait.' });
    }

    // Idempotent: if already captured, just return the full report
    if (!audit.leadCaptured) {
      audit.lead = {
        name:     name?.trim(),
        email:    email?.trim().toLowerCase(),
        phone:    phone?.trim(),
        business: business?.trim() || audit.businessName
      };
      audit.leadCaptured = true;
      audit.shareToken   = uuidv4();
      await audit.save();

      logger.info('[GrowthAudit] lead captured', {
        auditId: String(audit._id),
        email: audit.lead.email
      });

      // Fire-and-forget: the public audit unlock must never fail on CRM issues
      leadCaptureService.captureFromGrowthAudit(audit).catch((err) => {
        logger.error('[GrowthAudit] CRM lead capture failed', {
          auditId: String(audit._id),
          error: err?.message || err
        });
      });
    }

    const auditObj = audit.toObject ? audit.toObject() : audit;
    return res.json({ success: true, audit: formatAudit(auditObj, true) });
  } catch (err) {
    logger.error('[GrowthAudit] lead capture error', { id: req.params.id, error: err.message });
    res.status(500).json({ success: false, error: 'Failed to capture lead.' });
  }
});

/**
 * GET /:id/share/:token
 * Public read-only shareable report (no lead form required).
 * Used for outbound sales emails from the RepMeUp team.
 */
router.get('/:id/share/:token', genericLimiter, async (req, res) => {
  try {
    const audit = await GrowthAudit.findOne({
      _id: req.params.id,
      shareToken: req.params.token
    }).lean();

    if (!audit) {
      return res.status(404).json({ success: false, error: 'Report not found or link has expired.' });
    }

    return res.json({ success: true, audit: formatAudit(audit, true) });
  } catch (err) {
    logger.error('[GrowthAudit] share error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch shared report.' });
  }
});

/**
 * GET /:id/pdf
 * Generate a PDF version of the audit report using PDFKit.
 * Requires a valid shareToken query param OR that the audit has a lead captured.
 */
router.get('/:id/pdf', genericLimiter, async (req, res) => {
  try {
    const { token } = req.query;
    const query = token
      ? { _id: req.params.id, shareToken: token }
      : { _id: req.params.id, leadCaptured: true };

    const audit = await GrowthAudit.findOne(query).lean();
    if (!audit) {
      return res.status(404).json({ success: false, error: 'Report not found.' });
    }
    if (audit.status !== 'done' && audit.status !== 'partial') {
      return res.status(202).json({ success: false, error: 'Report not ready yet.' });
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="RepMeUp-Growth-Audit-${audit.businessName || 'Report'}.pdf"`
    );
    doc.pipe(res);

    const m = audit.modules || {};
    const sp = m.socialPresence || {};
    const rep = m.reputation || {};
    const leak = m.revenueLeak || {};

    // ── Header ──
    doc.fontSize(22).fillColor('#000000').text('RepMeUp Growth Intelligence Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#555555').text(`Analysed by RepMeUp AI  •  ${new Date().toLocaleDateString('en-IN')}`, { align: 'center' });
    doc.moveDown(1);

    // ── Hero ──
    doc.fontSize(14).fillColor('#000000').text(`Business: ${audit.businessName || audit.igHandle || 'N/A'}`);
    doc.fontSize(14).text(`Conversation Score: ${audit.score}/100  (Grade: ${audit.grade})`);
    doc.fontSize(14).fillColor('#cc0000')
      .text(`Estimated Revenue Leak: ₹${(leak.number || 0).toLocaleString('en-IN')}/month`);
    doc.moveDown(1);
    doc.fillColor('#000000');

    // ── Social Presence ──
    doc.fontSize(14).text('Social Presence (Instagram)', { underline: true });
    doc.fontSize(11)
      .text(`Posts analysed: ${sp.igPosts || 0}`)
      .text(`Total comments: ${sp.igComments || 0}`)
      .text(`Owner reply rate: ${sp.igReplyRate || 0}%`)
      .text(`Buying-intent comments: ${sp.igBuyingIntentCount || 0}`)
      .text(`Unanswered buying-intent: ${sp.igUnansweredBuying || 0}`)
      .text(`Posting gaps: ${sp.igPostingGaps ? 'Yes' : 'No'}`);
    doc.moveDown(0.8);

    // ── Reputation ──
    doc.fontSize(14).text('Reputation (Google)', { underline: true });
    doc.fontSize(11)
      .text(`Rating: ${rep.google?.rating || 'N/A'}/5  (${rep.google?.totalReviews || 0} reviews)`)
      .text(`Owner reply rate: ${rep.google?.ownerReplyRate || 0}%`)
      .text(`Unanswered negative reviews: ${rep.google?.unansweredNegative || 0}`);
    doc.moveDown(0.8);

    // ── Revenue Leak ──
    doc.fontSize(14).fillColor('#cc0000').text('Revenue Leak Breakdown', { underline: true });
    doc.fontSize(11).fillColor('#000000').text(leak.formula || '');
    doc.moveDown(0.8);

    // ── AI Recommendations ──
    if (Array.isArray(m.aiRecommendations) && m.aiRecommendations.length) {
      doc.fontSize(14).text('AI Recommendations', { underline: true });
      for (const rec of m.aiRecommendations) {
        doc.fontSize(12).text(`${rec.rank}. ${rec.title}`);
        doc.fontSize(10).text(rec.explanation).text(`Expected impact: ${rec.expectedImpact}`).moveDown(0.5);
      }
      doc.moveDown(0.5);
    }

    // ── CTA ──
    doc.fontSize(13).fillColor('#000000')
      .text('RepMeUp fixes this.', { align: 'center' });
    doc.fontSize(11).fillColor('#555555')
      .text('Book a free demo: repmeup.in/book-demo', { align: 'center' });

    doc.end();
  } catch (err) {
    logger.error('[GrowthAudit] PDF error', { id: req.params.id, error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
    }
  }
});

module.exports = router;
