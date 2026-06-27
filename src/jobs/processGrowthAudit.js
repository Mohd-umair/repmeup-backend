/**
 * Bull job processor: Public Growth Intelligence Audit
 *
 * Pattern mirrors processKbCrawl.js:
 *   1. Load GrowthAudit doc
 *   2. Run all three providers in parallel (Promise.allSettled — partial failure allowed)
 *   3. Score via auditScoringService (includes OpenAI AI Recommendations)
 *   4. Save full result + set status = done | partial | failed
 */

const GrowthAudit = require('../models/GrowthAudit');
const { fetchInstagram } = require('../services/audit/providers/instagramPublicProvider');
const { fetchFacebook } = require('../services/audit/providers/facebookPublicProvider');
const { fetchGoogle } = require('../services/audit/providers/googlePublicProvider');
const { score: auditScore } = require('../services/audit/auditScoringService');
const logger = require('../config/logger');

async function processGrowthAudit(job) {
  const { auditId } = job.data;
  if (!auditId) throw new Error('[processGrowthAudit] auditId is required');

  const audit = await GrowthAudit.findById(auditId);
  if (!audit) throw new Error(`[processGrowthAudit] GrowthAudit ${auditId} not found`);

  audit.status = 'processing';
  audit.startedAt = new Date();
  await audit.save();

  logger.info('[GrowthAudit] starting', {
    auditId: String(auditId),
    igHandle: audit.igHandle,
    industry: audit.industry
  });

  // ── Fan out to all three providers in parallel ──────────────────────────────
  const [igResult, fbResult, googleResult] = await Promise.allSettled([
    audit.igHandle
      ? fetchInstagram(audit.igHandle)
      : Promise.resolve({}),
    audit.fbPageUrl
      ? fetchFacebook(audit.fbPageUrl)
      : Promise.resolve({}),
    audit.googleQuery
      ? fetchGoogle(audit.googleQuery)
      : Promise.resolve({})
  ]);

  const rawData = {
    ig:     igResult.status     === 'fulfilled' ? igResult.value     : {},
    fb:     fbResult.status     === 'fulfilled' ? fbResult.value     : {},
    google: googleResult.status === 'fulfilled' ? googleResult.value : {}
  };

  const failedProviders = [];
  if (igResult.status === 'rejected') {
    logger.warn('[GrowthAudit] Instagram provider failed', { auditId, error: igResult.reason?.message });
    failedProviders.push('instagram');
  }
  if (fbResult.status === 'rejected') {
    logger.warn('[GrowthAudit] Facebook provider failed', { auditId, error: fbResult.reason?.message });
    failedProviders.push('facebook');
  }
  if (googleResult.status === 'rejected') {
    logger.warn('[GrowthAudit] Google provider failed', { auditId, error: googleResult.reason?.message });
    failedProviders.push('google');
  }

  // All providers failed — mark failed and stop
  if (failedProviders.length === 3) {
    audit.status = 'failed';
    audit.errorMessage = 'All data providers failed. Please try again shortly.';
    audit.completedAt = new Date();
    await audit.save();
    logger.error('[GrowthAudit] all providers failed', { auditId });
    return { status: 'failed' };
  }

  // ── Score ───────────────────────────────────────────────────────────────────
  let scored;
  try {
    scored = await auditScore(
      rawData,
      audit.industry || 'general',
      audit.avgOrderValue || 0,
      audit.businessName || ''
    );
  } catch (scoreErr) {
    logger.error('[GrowthAudit] scoring failed', { auditId, error: scoreErr.message });
    audit.status = 'failed';
    audit.errorMessage = 'Scoring failed. Please try again.';
    audit.completedAt = new Date();
    await audit.save();
    throw scoreErr;
  }

  // ── Persist ─────────────────────────────────────────────────────────────────
  audit.modules   = scored.modules;
  audit.benchmarks= scored.benchmarks;
  audit.score     = scored.score;
  audit.grade     = scored.grade;
  audit.status    = failedProviders.length > 0 ? 'partial' : 'done';
  audit.errorMessage = failedProviders.length > 0
    ? `Partial data: ${failedProviders.join(', ')} provider(s) unavailable.`
    : '';
  audit.completedAt = new Date();

  await audit.save();

  logger.info('[GrowthAudit] done', {
    auditId: String(auditId),
    status: audit.status,
    score: audit.score,
    grade: audit.grade,
    revenueLeak: audit.modules?.revenueLeak?.number,
    failedProviders
  });

  return {
    status: audit.status,
    score: audit.score,
    grade: audit.grade,
    revenueLeak: audit.modules?.revenueLeak?.number
  };
}

module.exports = processGrowthAudit;
