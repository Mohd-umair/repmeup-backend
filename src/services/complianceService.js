const BrandConfig = require('../models/BrandConfig');

/**
 * Compliance service: check post content against brand config (banned words, disclaimers).
 * Returns riskScore (0-100) and complianceFlags.
 */
async function checkContent(organizationId, content) {
  if (!content || typeof content !== 'string') {
    return { riskScore: 0, complianceFlags: [] };
  }
  const text = content.toLowerCase().trim();
  const flags = [];
  let riskScore = 0;

  try {
    const config = await BrandConfig.findOne({ organization: organizationId }).lean();
    if (!config) return { riskScore: 0, complianceFlags: [] };

    // Banned words: each match adds to risk
    if (config.bannedWords && config.bannedWords.length > 0) {
      const words = config.bannedWords.map(w => w.toLowerCase().trim()).filter(Boolean);
      for (const word of words) {
        if (text.includes(word)) {
          riskScore += 25;
          flags.push(`Contains banned word: "${word}"`);
        }
      }
      riskScore = Math.min(100, riskScore);
    }

    // Legal disclaimer required but missing
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

  return { riskScore, complianceFlags: flags };
}

module.exports = { checkContent };
