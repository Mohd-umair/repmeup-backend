/**
 * Knowledge Base Search Service
 *
 * Resolves the most relevant KB entries to inject into a reply prompt.
 * Strategy (in order):
 *   1. MongoDB $text search (requires text index on title/content/keywords)
 *   2. Keyword/title regex match — tokens of length >= 2 so short DMs ("hi", "ok") still match
 *   3. Top-priority fallback — highest priority/training-weight entries so DMs always get
 *      brand context even when nothing matches
 */

const KnowledgeBase = require('../../models/KnowledgeBase');
const logger = require('../../config/logger');
const { escapeRegex } = require('../../utils/sanitize');

/** Base filter for KB entries used in replies (DMs use the same path as comments). */
function knowledgeBaseReplyFilter(organizationId) {
  return {
    organization: organizationId,
    isActive: true,
    isTrainingData: { $ne: false }
  };
}

/**
 * Search relevant knowledge base entries for a query.
 *
 * @param {string} organizationId
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<{ entries: Array, fromFallback: boolean }>}
 */
async function searchKnowledgeBase(organizationId, query, limit = 5) {
  try {
    const base = knowledgeBaseReplyFilter(organizationId);
    const trimmed = (query && String(query).trim()) || '';

    const topPriorityFallback = async () => KnowledgeBase
      .find(base)
      .select('title content category priority keywords trainingWeight usageCount lastUsedAt')
      .sort({ priority: -1, trainingWeight: -1, usageCount: -1 })
      .limit(limit);

    if (!trimmed) {
      const entries = await topPriorityFallback();
      return { entries, fromFallback: true };
    }

    // 1. MongoDB text search
    let results = [];
    try {
      results = await KnowledgeBase
        .find({ ...base, $text: { $search: trimmed } })
        .select('title content category priority keywords trainingWeight usageCount lastUsedAt')
        .sort({ score: { $meta: 'textScore' }, priority: -1 })
        .limit(limit);
    } catch (textErr) {
      logger.warn('Knowledge base text search skipped', { message: textErr.message });
    }

    if (results.length > 0) {
      return { entries: results, fromFallback: false };
    }

    // 2. Keyword / title regex match
    const queryWords = trimmed
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\w]/g, ''))
      .filter((w) => w.length >= 2)
      .slice(0, 12);

    if (queryWords.length > 0) {
      const escapedForRegex = queryWords.map((w) => escapeRegex(w));
      const keywordResults = await KnowledgeBase
        .find({
          ...base,
          $or: [
            { keywords: { $in: queryWords } },
            { title: { $regex: escapedForRegex.join('|'), $options: 'i' } }
          ]
        })
        .select('title content category priority keywords trainingWeight usageCount lastUsedAt')
        .sort({ priority: -1, usageCount: -1 })
        .limit(limit);

      if (keywordResults.length > 0) {
        return { entries: keywordResults, fromFallback: false };
      }
    }

    // 3. Top-priority fallback
    const fallbackEntries = await topPriorityFallback();
    return { entries: fallbackEntries, fromFallback: true };
  } catch (error) {
    console.error('Knowledge base search error:', error.message);
    return { entries: [], fromFallback: false };
  }
}

module.exports = {
  searchKnowledgeBase,
  knowledgeBaseReplyFilter
};
