/**
 * Bull job processor: Public Growth Intelligence Audit
 *
 * Pattern mirrors processKbCrawl.js:
 *   1. Load GrowthAudit doc
 *   2. Run only the providers the user submitted (IG / FB / Google URLs)
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

  const platforms = {
    instagram: !!audit.igHandle,
    facebook: !!audit.fbPageUrl,
    google: !!audit.googleQuery
  };

  logger.info('[GrowthAudit] starting', {
    auditId: String(auditId),
    igHandle: audit.igHandle,
    industry: audit.industry,
    platforms
  });

  // ── Only scrape platforms the user provided ─────────────────────────────────
  const providerTasks = [];
  if (platforms.instagram) {
    providerTasks.push({ key: 'ig', run: () => fetchInstagram(audit.igHandle) });
  }
  if (platforms.facebook) {
    providerTasks.push({ key: 'fb', run: () => fetchFacebook(audit.fbPageUrl) });
  }
  if (platforms.google) {
    providerTasks.push({ key: 'google', run: () => fetchGoogle(audit.googleQuery) });
  }

  const settled = await Promise.allSettled(providerTasks.map(t => t.run()));

  const rawData = { ig: {}, fb: {}, google: {} };
  const failedProviders = [];

  settled.forEach((result, i) => {
    const { key } = providerTasks[i];
    if (result.status === 'fulfilled') {
      rawData[key] = result.value;
    } else {
      const label = key === 'ig' ? 'instagram' : key === 'fb' ? 'facebook' : 'google';
      logger.warn(`[GrowthAudit] ${label} provider failed`, { auditId, error: result.reason?.message });
      failedProviders.push(label);
    }
  });

  // All requested providers failed — mark failed and stop
  if (failedProviders.length > 0 && failedProviders.length === providerTasks.length) {
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
      audit.businessName || '',
      platforms
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
