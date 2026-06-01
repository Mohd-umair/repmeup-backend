/**
 * Campaign pipeline tuning — env-driven for horizontal scale.
 */
module.exports = {
  batchSize: parseInt(process.env.CAMPAIGN_BATCH_SIZE, 10) || 100,
  batchConcurrency: parseInt(process.env.CAMPAIGN_BATCH_CONCURRENCY, 10) || 20,
  sendsPerSecond: parseInt(process.env.CAMPAIGN_SENDS_PER_SECOND, 10) || 30,
  maxInflightPerWaba: parseInt(process.env.CAMPAIGN_MAX_INFLIGHT_PER_WABA, 10) || 5,
  maxSendAttempts: parseInt(process.env.CAMPAIGN_MAX_SEND_ATTEMPTS, 10) || 3,
  inboxConcurrency: parseInt(process.env.CAMPAIGN_INBOX_CONCURRENCY, 10) || 10,
  /** Pause WABA sends for this many ms after sustained Meta 429s */
  wabaPauseMs: parseInt(process.env.CAMPAIGN_WABA_PAUSE_MS, 10) || 120000,
  /** 429 count within window before auto-pause */
  waba429Threshold: parseInt(process.env.CAMPAIGN_WABA_429_THRESHOLD, 10) || 10,
  waba429WindowSec: parseInt(process.env.CAMPAIGN_WABA_429_WINDOW_SEC, 10) || 60,
  /** Skip per-message Socket.IO during high-volume campaign blasts */
  skipStatusSocketWhenBlasting:
    process.env.CAMPAIGN_SKIP_STATUS_SOCKET !== 'false',
  /** Run campaign queues in core worker.js when true (local dev convenience) */
  enableInCoreWorker: process.env.ENABLE_CAMPAIGN_IN_CORE_WORKER !== 'false',
  /** Max replies kept inline on Interaction; older archived by maintenance job */
  maxInlineReplies: parseInt(process.env.INTERACTION_MAX_INLINE_REPLIES, 10) || 500,
  archiveBatchSize: parseInt(process.env.INTERACTION_ARCHIVE_BATCH_SIZE, 10) || 50
};
