const KnowledgeBase = require('../models/KnowledgeBase');
const KbCrawlJob = require('../models/KbCrawlJob');
const webScraperService = require('../services/webScraperService');
const contentSummarizerService = require('../services/contentSummarizerService');
const aiCreditService = require('../services/aiCreditService');
const entitlementsService = require('../services/entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const { runWithAiContextAndUsageId } = require('../services/aiRequestContext');
const logger = require('../config/logger');

async function remainingKbCapacity(organizationId) {
  const q = await entitlementsService.quota(organizationId, FEATURE_KEYS.KB_ENTRIES_MAX);
  if (q.isUnlimited) return Infinity;
  return Math.max(0, q.limit - q.used);
}

async function summarizeAndSavePage({
  page,
  organizationId,
  userId,
  crawlJobId,
  startUrl,
  opts,
  capacityRemainingRef
}) {
  const estimate = aiCreditService.calculateCreditsFromWordCount(
    opts.targetWordCount || 1500,
    opts.targetTagCount || 8
  );
  const creditCheck = await aiCreditService.checkCredits(organizationId, estimate);
  if (!creditCheck.allowed) {
    return { error: { url: page.url, reason: 'Out of AI credits — remaining pages skipped.' }, stop: true };
  }

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
      startUrl,
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
  capacityRemainingRef.value -= 1;

  const actualWordCount = summaryData.summary.trim().split(/\s+/).length;
  const actualCost = aiCreditService.calculateCreditsFromWordCount(
    actualWordCount,
    (summaryData.tags || []).length
  );

  // Deduct credits — keep the KB entry even if deduction fails (subscription not found, etc.)
  try {
    await aiCreditService.deductCredits(
      organizationId,
      actualCost,
      {
        operation: 'knowledge_base_from_url_crawl',
        userId,
        url: page.url,
        wordCount: actualWordCount,
        tagCount: (summaryData.tags || []).length
      },
      { aiApiUsageId }
    );
  } catch (deductErr) {
    logger.warn('[KbCrawl] credit deduction failed for page', {
      crawlJobId: String(crawlJobId),
      url: page.url,
      error: deductErr.message
    });
    // KB entry is already saved — do not throw; the entry is the priority.
  }

  return { kbId: kb._id, creditsUsed: actualCost };
}

/**
 * Bull job processor: import user-selected pages (or legacy auto-crawl) into KB entries.
 */
async function processKbCrawl(job) {
  const { crawlJobId } = job.data;
  if (!crawlJobId) throw new Error('crawlJobId is required');

  const crawlJob = await KbCrawlJob.findById(crawlJobId);
  if (!crawlJob) throw new Error(`KbCrawlJob ${crawlJobId} not found`);

  const organizationId = crawlJob.organization;
  const userId = crawlJob.createdBy;
  const opts = crawlJob.options || {};
  const selectedUrls = Array.isArray(crawlJob.selectedUrls) ? crawlJob.selectedUrls.filter(Boolean) : [];

  crawlJob.status = 'crawling';
  crawlJob.startedAt = new Date();
  await crawlJob.save();

  logger.info('[KbCrawl] starting', {
    crawlJobId: String(crawlJobId),
    startUrl: crawlJob.startUrl,
    maxPages: crawlJob.maxPages,
    selectedCount: selectedUrls.length
  });

  let capacityRemaining = await remainingKbCapacity(organizationId);
  if (capacityRemaining <= 0) {
    crawlJob.status = 'failed';
    crawlJob.error = 'Knowledge base entry limit reached. Upgrade your plan to add more entries.';
    crawlJob.finishedAt = new Date();
    await crawlJob.save();
    return { status: 'failed', reason: 'kb_cap' };
  }

  const effectiveMaxPages = Math.min(crawlJob.maxPages, capacityRemaining);
  let pages = [];

  if (selectedUrls.length > 0) {
    const urlsToScrape = selectedUrls.slice(0, effectiveMaxPages);
    crawlJob.pagesFound = urlsToScrape.length;
    await crawlJob.save();

    for (let i = 0; i < urlsToScrape.length; i++) {
      const pageUrl = urlsToScrape[i];
      await KbCrawlJob.updateOne(
        { _id: crawlJobId },
        { $set: { pagesProcessed: i, currentUrl: pageUrl } }
      );

      if (i > 0 && webScraperService.crawlDelayMs > 0) {
        await new Promise((r) => setTimeout(r, webScraperService.crawlDelayMs));
      }

      try {
        const scraped = await webScraperService.scrape(pageUrl);
        pages.push(scraped);
      } catch (err) {
        pages.push({ url: pageUrl, error: err.message || 'Failed to scrape page' });
      }
    }
  } else {
    let crawlResult;
    try {
      crawlResult = await webScraperService.crawlSite(crawlJob.startUrl, {
        maxPages: effectiveMaxPages,
        onProgress: async ({ pagesFound, pagesProcessed, currentUrl }) => {
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
      await entitlementsService.invalidateEntitlements(organizationId);
      logger.warn('[KbCrawl] fatal crawl error', { crawlJobId: String(crawlJobId), error: err.message });
      return { status: 'failed', reason: err.message };
    }
    pages = crawlResult.pages || [];
  }

  logger.info('[KbCrawl] pages ready, summarizing', { crawlJobId: String(crawlJobId), pages: pages.length });

  let totalCreditsUsed = 0;
  const createdIds = [];
  const errors = [];
  const capacityRef = { value: capacityRemaining };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    if (page.error) {
      errors.push({ url: page.url, reason: String(page.error).slice(0, 300) });
      continue;
    }

    if (capacityRef.value <= 0) {
      errors.push({ url: page.url, reason: 'KB entry capacity reached — page skipped.' });
      continue;
    }

    try {
      const result = await summarizeAndSavePage({
        page,
        organizationId,
        userId,
        crawlJobId,
        startUrl: crawlJob.startUrl,
        opts,
        capacityRemainingRef: capacityRef
      });

      if (result.stop) {
        errors.push(result.error);
        break;
      }
      if (result.error) {
        errors.push(result.error);
        continue;
      }

      createdIds.push(result.kbId);
      totalCreditsUsed += result.creditsUsed;

      await KbCrawlJob.updateOne(
        { _id: crawlJobId },
        {
          $set: {
            entriesCreated: createdIds.length,
            creditsUsed: totalCreditsUsed,
            currentUrl: page.url,
            pagesProcessed: i + 1
          },
          $push: { knowledgeBaseIds: result.kbId }
        }
      );
    } catch (err) {
      errors.push({ url: page.url, reason: (err.message || 'Failed to process page').slice(0, 300) });
      logger.warn('[KbCrawl] page failed', { crawlJobId: String(crawlJobId), url: page.url, error: err.message });
    }
  }

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

  // Always invalidate so the frontend always sees fresh credit usage and KB counts.
  await entitlementsService.invalidateEntitlements(organizationId);

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
