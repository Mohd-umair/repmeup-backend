const KnowledgeBase = require('../models/KnowledgeBase');
const KbCrawlJob = require('../models/KbCrawlJob');
const webScraperService = require('../services/webScraperService');
const contentSummarizerService = require('../services/contentSummarizerService');
const aiCreditService = require('../services/aiCreditService');
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const { runWithAiContextAndUsageId } = require('../services/aiRequestContext');
const logger = require('../config/logger');

/**
 * Remaining KB entry capacity for an org. Returns Infinity when unlimited.
 * Mirrors assertKbEntryCapAvailable() in knowledgeBaseController but returns a
 * number so the crawl can stop early instead of throwing mid-loop.
 */
async function remainingKbCapacity(organizationId) {
  const q = await entitlementsService.quota(organizationId, FEATURE_KEYS.KB_ENTRIES_MAX);
  if (q.isUnlimited) return Infinity;
  return Math.max(0, q.limit - q.used);
}

/**
 * Bull job processor: crawl a whole website and create one AI-summarized
 * KnowledgeBase entry per page.
 *
 * job.data: { crawlJobId }
 *
 * Design notes:
 *  - One summarize() AI call per page → credits deducted per page actually saved.
 *  - Per-page failures are recorded in crawlJob.errors and skipped (non-fatal).
 *  - Respects the org KB entry cap: stops creating entries once capacity is hit.
 *  - Final status: 'completed' (all good), 'partial' (some pages failed / cap hit),
 *    or 'failed' (fatal — e.g. start page unreachable).
 */
async function processKbCrawl(job) {
  const { crawlJobId } = job.data;
  if (!crawlJobId) throw new Error('crawlJobId is required');

  const crawlJob = await KbCrawlJob.findById(crawlJobId);
  if (!crawlJob) throw new Error(`KbCrawlJob ${crawlJobId} not found`);

  const organizationId = crawlJob.organization;
  const userId = crawlJob.createdBy;
  const opts = crawlJob.options || {};

  crawlJob.status = 'crawling';
  crawlJob.startedAt = new Date();
  await crawlJob.save();

  logger.info('[KbCrawl] starting', { crawlJobId: String(crawlJobId), startUrl: crawlJob.startUrl, maxPages: crawlJob.maxPages });

  let capacityRemaining = await remainingKbCapacity(organizationId);
  if (capacityRemaining <= 0) {
    crawlJob.status = 'failed';
    crawlJob.error = 'Knowledge base entry limit reached. Upgrade your plan to add more entries.';
    crawlJob.finishedAt = new Date();
    await crawlJob.save();
    return { status: 'failed', reason: 'kb_cap' };
  }

  // The crawl is bounded by both maxPages and remaining KB capacity.
  const effectiveMaxPages = Math.min(crawlJob.maxPages, capacityRemaining);

  let crawlResult;
  try {
    crawlResult = await webScraperService.crawlSite(crawlJob.startUrl, {
      maxPages: effectiveMaxPages,
      onProgress: async ({ pagesFound, pagesProcessed, currentUrl }) => {
        // Lightweight progress write — keep the polling UI moving.
        await KbCrawlJob.updateOne(
          { _id: crawlJobId },
          { $set: { pagesFound, pagesProcessed, currentUrl } }
        );
      }
    });
  } catch (err) {
    crawlJob.status = 'failed';
    crawlJob.error = err.message || 'Crawl failed';
    crawlJob.finishedAt = new Date();
    await crawlJob.save();
    logger.warn('[KbCrawl] fatal crawl error', { crawlJobId: String(crawlJobId), error: err.message });
    return { status: 'failed', reason: err.message };
  }

  const pages = crawlResult.pages || [];
  logger.info('[KbCrawl] crawl finished, summarizing pages', { crawlJobId: String(crawlJobId), pages: pages.length });

  let totalCreditsUsed = 0;
  const createdIds = [];
  const errors = [];

  for (const page of pages) {
    if (capacityRemaining <= 0) {
      errors.push({ url: page.url, reason: 'KB entry capacity reached — page skipped.' });
      continue;
    }

    // Pre-check credits before each AI call so we fail gracefully mid-crawl.
    const estimate = aiCreditService.calculateCreditsFromWordCount(
      opts.targetWordCount || 1500,
      opts.targetTagCount || 8
    );
    const creditCheck = await aiCreditService.checkCredits(organizationId, estimate);
    if (!creditCheck.allowed) {
      errors.push({ url: page.url, reason: 'Out of AI credits — remaining pages skipped.' });
      break; // no point continuing; all further pages would also fail
    }

    try {
      const { result: summaryData, aiApiUsageId } = await runWithAiContextAndUsageId(
        { organizationId, userId, feature: 'knowledge_base.from_url_crawl' },
        () => contentSummarizerService.summarize(page.content, {
          title: page.title,
          url: page.url,
          focus: opts.focus || 'overview',
          targetWordCount: opts.targetWordCount ? parseInt(opts.targetWordCount, 10) : undefined,
          targetTagCount: opts.targetTagCount ? parseInt(opts.targetTagCount, 10) : undefined
        })
      );

      const contentStats = webScraperService.getContentStats(page.content);
      const pageTitle = page.title || page.url;
      const titlePrefix = opts.titlePrefix ? `${opts.titlePrefix} — ` : '';

      const kb = new KnowledgeBase({
        title: `${titlePrefix}${pageTitle}`.slice(0, 300),
        content: summaryData.summary,
        category: opts.category || 'website',
        tags: Array.isArray(opts.tags) && opts.tags.length ? opts.tags : (summaryData.tags || []),
        keywords: summaryData.tags || [],
        priority: opts.priority || 1,
        source: 'url',
        metadata: {
          url: page.url,
          crawlJobId: String(crawlJobId),
          startUrl: crawlJob.startUrl,
          scrapedAt: page.scrapedAt,
          description: page.description,
          originalContentLength: contentStats.charCount,
          originalWordCount: contentStats.wordCount,
          summaryLength: summaryData.summaryLength,
          compressionRatio: summaryData.compressionRatio,
          keyPoints: summaryData.keyPoints,
          headings: page.metadata?.headings,
          ...page.metadata
        },
        organization: organizationId,
        createdBy: userId
      });
      await kb.save();
      createdIds.push(kb._id);
      capacityRemaining -= 1;

      // Deduct actual credits for this page.
      const actualWordCount = summaryData.summary.trim().split(/\s+/).length;
      const actualCost = aiCreditService.calculateCreditsFromWordCount(actualWordCount, (summaryData.tags || []).length);
      await aiCreditService.deductCredits(
        organizationId,
        actualCost,
        { operation: 'knowledge_base_from_url_crawl', userId, url: page.url, wordCount: actualWordCount, tagCount: (summaryData.tags || []).length },
        { aiApiUsageId }
      );
      totalCreditsUsed += actualCost;

      // Incremental progress write so the UI shows entries appearing.
      await KbCrawlJob.updateOne(
        { _id: crawlJobId },
        {
          $set: { entriesCreated: createdIds.length, creditsUsed: totalCreditsUsed, currentUrl: page.url },
          $push: { knowledgeBaseIds: kb._id }
        }
      );
    } catch (err) {
      // Summarize/save failure on one page is non-fatal — record and continue.
      errors.push({ url: page.url, reason: (err.message || 'Failed to process page').slice(0, 300) });
      logger.warn('[KbCrawl] page failed', { crawlJobId: String(crawlJobId), url: page.url, error: err.message });
    }
  }

  // Finalize status.
  const finalStatus = createdIds.length === 0
    ? 'failed'
    : (errors.length > 0 ? 'partial' : 'completed');

  crawlJob.status = finalStatus;
  crawlJob.entriesCreated = createdIds.length;
  crawlJob.knowledgeBaseIds = createdIds;
  crawlJob.creditsUsed = totalCreditsUsed;
  crawlJob.errors = errors.slice(0, 50);
  crawlJob.error = finalStatus === 'failed' ? 'No pages could be summarized into knowledge base entries.' : '';
  crawlJob.finishedAt = new Date();
  await crawlJob.save();

  if (createdIds.length > 0) {
    await entitlementsService.invalidateEntitlements(organizationId);
  }

  logger.info('[KbCrawl] done', {
    crawlJobId: String(crawlJobId),
    status: finalStatus,
    entriesCreated: createdIds.length,
    creditsUsed: totalCreditsUsed,
    failedPages: errors.length
  });

  return { status: finalStatus, entriesCreated: createdIds.length, creditsUsed: totalCreditsUsed };
}

module.exports = processKbCrawl;
