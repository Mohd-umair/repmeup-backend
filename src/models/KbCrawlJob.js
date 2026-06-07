const mongoose = require('mongoose');

/**
 * KbCrawlJob — tracks the lifecycle of a "crawl whole website" knowledge-base
 * ingestion. The HTTP request enqueues a Bull job and returns this doc's id so
 * the frontend can poll progress while the worker crawls + summarizes pages.
 *
 * One KnowledgeBase entry is created per successfully-summarized page; this doc
 * records the running totals and any per-page failures for transparency.
 */
const kbCrawlJobSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  startUrl: { type: String, required: true, trim: true },
  maxPages: { type: Number, default: 25, min: 1, max: 100 },

  status: {
    type: String,
    enum: ['queued', 'crawling', 'completed', 'failed', 'partial'],
    default: 'queued',
    index: true
  },

  // Running progress (updated as the crawl proceeds).
  pagesFound: { type: Number, default: 0 },      // links discovered/queued so far
  pagesProcessed: { type: Number, default: 0 },  // pages successfully scraped
  entriesCreated: { type: Number, default: 0 },  // KB entries actually saved
  currentUrl: { type: String, default: '' },     // page being worked on (UX hint)

  creditsUsed: { type: Number, default: 0 },

  // Ids of the KnowledgeBase docs created by this crawl (for undo / display).
  knowledgeBaseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeBase' }],

  // Per-page failures — non-fatal, surfaced to the user for transparency.
  errors: [{
    url: { type: String },
    reason: { type: String }
  }],

  // Shared crawl options the user chose (title prefix, category, tags, etc.).
  options: { type: mongoose.Schema.Types.Mixed, default: {} },

  error: { type: String, default: '' }, // fatal error message when status==='failed'
  startedAt: { type: Date },
  finishedAt: { type: Date }
}, {
  timestamps: true
});

// Recent jobs per org, newest first — for a "crawl history" view and polling.
kbCrawlJobSchema.index({ organization: 1, createdAt: -1 });

module.exports = mongoose.model('KbCrawlJob', kbCrawlJobSchema);
