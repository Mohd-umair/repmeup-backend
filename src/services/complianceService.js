const BrandConfig = require('../models/BrandConfig');

/**
 * Thrown when content fails a *hard* compliance rule (e.g. a banned word) at
 * an actual publishing boundary. Distinct from soft flags (e.g. "disclaimer
 * may be required") which only raise the risk score — those never block.
 */
class ComplianceError extends Error {
  constructor(message, { complianceFlags = [], riskScore = 0 } = {}) {
    super(message);
    this.name = 'ComplianceError';
    this.statusCode = 422;
    this.code = 'COMPLIANCE_BLOCKED';
    this.complianceFlags = complianceFlags;
    this.riskScore = riskScore;
  }
}

/**
 * Compliance service: check post content against brand config (banned words, disclaimers).
 * Returns riskScore (0-100), complianceFlags, and hardViolation.
 *
 * IMPORTANT: this is the only source of truth for riskScore/complianceFlags.
 * Callers must never persist client-supplied values for these fields —
 * always recompute here at every publish/schedule/approval boundary.
 */
async function checkContent(organizationId, content) {
  if (!content || typeof content !== 'string') {
    return { riskScore: 0, complianceFlags: [], hardViolation: false };
  }
  const text = content.toLowerCase().trim();
  const flags = [];
  let riskScore = 0;
  let hardViolation = false;

  try {
    const config = await BrandConfig.findOne({ organization: organizationId })
      .select('bannedWords legalDisclaimers')
      .lean();
    if (!config) return { riskScore: 0, complianceFlags: [], hardViolation: false };

    // Banned words: each match adds to risk AND is a hard violation — the org
    // explicitly said "never use these words", so this must block auto-publish.
    if (config.bannedWords && config.bannedWords.length > 0) {
      const words = config.bannedWords.map(w => w.toLowerCase().trim()).filter(Boolean);
      for (const word of words) {
        if (text.includes(word)) {
          riskScore += 25;
          flags.push(`Contains banned word: "${word}"`);
          hardViolation = true;
        }
      }
      riskScore = Math.min(100, riskScore);
    }

    // Legal disclaimer required but missing — soft flag only (informational;
    // the exact disclaimer wording may legitimately not match verbatim).
    if (config.legalDisclaimers && config.legalDisclaimers.trim()) {
      const disclaimer = config.legalDisclaimers.trim().toLowerCase();
      const snippet = disclaimer.substring(0, 50);
      if (!text.includes(snippet)) {
        riskScore = Math.min(100, riskScore + 15);
        flags.push('Legal disclaimer may be required');
      }
    }
  } catch (err) {
    console.warn('[complianceService] checkContent error:', err.message);
  }

  return { riskScore, complianceFlags: flags, hardViolation };
}

/**
 * Recompute compliance for `content` and throw ComplianceError if it fails a
 * hard rule. Call this at every point content actually reaches a platform
 * (immediate publish, approval→publish, scheduled worker) — never trust a
 * riskScore/complianceFlags value that arrived from the client or was
 * computed earlier against different content.
 *
 * @returns {Promise<{riskScore:number, complianceFlags:string[], hardViolation:boolean}>}
 *   the freshly computed result, for callers that also want to persist it.
 */
async function assertCompliant(organizationId, content) {
  const result = await checkContent(organizationId, content);
  if (result.hardViolation) {
    throw new ComplianceError(
      `Content blocked: ${result.complianceFlags.join('; ')}. Edit the post to remove banned words before publishing.`,
      result
    );
  }
  return result;
}

module.exports = { checkContent, assertCompliant, ComplianceError };
