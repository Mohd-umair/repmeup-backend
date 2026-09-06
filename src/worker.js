require('dotenv').config();
const connectDB = require('./config/database');
const { connectRedis, getRedisClient } = require('./config/redis');
const socketEmitter = require('./utils/socketEmitter');
const {
  webhookQueue,
  aiQueue,
  autoReplyQueue,
  scheduledPublishQueue,
  brandAnalysisQueue,
  emailWebhookQueue,
  imapPollingQueue,
  gmailWatchRenewalQueue,
  outlookRenewalQueue,
  voiceCallQueue,
  campaignSendQueue,
  campaignInboxQueue,
  flowTickQueue,
  kbCrawlQueue,
  demoExpiryQueue,
  appointmentReminderQueue,
  publicAuditQueue,
  paymentWebhookQueue,
  platformSyncQueue,
  audienceMaterializeQueue,
  socialCampaignSendQueue,
  activationCampaignLaunchQueue,
  contactIntelligenceQueue,
  duplicateScanQueue,
  contentStudioInputCleanupQueue
} = require('./config/queue');
const processPaymentWebhook = require('./jobs/processPaymentWebhook');
const processWebhook = require('./jobs/processWebhook');
const processAutoReply = require('./jobs/processAutoReply');
const processAI = require('./jobs/processAI');
const processScheduledPublish = require('./jobs/processScheduledPublish');
const processBrandAnalysis = require('./jobs/processBrandAnalysis');
const processEmailWebhook = require('./jobs/processEmailWebhook');
const processImapPolling = require('./jobs/processImapPolling');
const renewGmailWatches = require('./jobs/renewGmailWatches');
const renewOutlookSubscriptions = require('./jobs/renewOutlookSubscriptions');
const processVoiceCall = require('./jobs/processVoiceCall');
const processFlowTick = require('./jobs/processFlowTick');
const processKbCrawl = require('./jobs/processKbCrawl');
const processGrowthAudit = require('./jobs/processGrowthAudit');
const processDemoExpiry = require('./jobs/processDemoExpiry');
const processContentStudioInputCleanup = require('./jobs/processContentStudioInputCleanup');
const processAppointmentReminders = require('./jobs/processAppointmentReminders');
const campaignConfig = require('./config/campaignConfig');
const { registerCampaignWorkers } = require('./workers/registerCampaignWorkers');
const logger = require('./config/logger');

// Concurrency from env
const WEBHOOK_CONCURRENCY = parseInt(process.env.WEBHOOK_CONCURRENCY) || 10;
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY) || 10;
const AUTOREPLY_CONCURRENCY = parseInt(process.env.AUTOREPLY_CONCURRENCY) || 5;
const BRAND_ANALYSIS_CONCURRENCY = parseInt(process.env.BRAND_ANALYSIS_CONCURRENCY) || 2;
const KB_CRAWL_CONCURRENCY = parseInt(process.env.KB_CRAWL_CONCURRENCY) || 2;
const PUBLIC_AUDIT_CONCURRENCY = parseInt(process.env.PUBLIC_AUDIT_CONCURRENCY) || 3;
const EMAIL_WEBHOOK_CONCURRENCY = parseInt(process.env.EMAIL_WEBHOOK_CONCURRENCY) || 5;
const IMAP_POLL_CONCURRENCY = parseInt(process.env.IMAP_POLL_CONCURRENCY) || 3;
const VOICE_CALL_CONCURRENCY = parseInt(process.env.VOICE_CALL_CONCURRENCY) || 4;

async function startWorker() {
  try {
    logger.info('🔧 Starting ORM Worker...');

    await connectDB();
    await connectRedis();

    // Bridge realtime events to browsers: jobs in this process call emitToOrg(),
    // which publishes via Redis; the API instances (redis-adapter) deliver them.
    // Without this init every emit from a job was silently dropped.
    socketEmitter.initRedisEmitter(getRedisClient());
    logger.info('[Worker] Socket emitter bridged via Redis (realtime events reach API clients)');

    webhookQueue.process(WEBHOOK_CONCURRENCY, async (job) => {
      logger.debug('[Worker:webhook] picked up job', { jobId: job.id });
      return await processWebhook(job);
    });
    logger.info('[Worker] webhook processor started', { concurrency: WEBHOOK_CONCURRENCY });

    aiQueue.process(AI_CONCURRENCY, async (job) => {
      logger.debug('[Worker:ai] picked up job', { jobId: job.id });
      return await processAI(job);
    });
    logger.info('[Worker] ai processor started', { concurrency: AI_CONCURRENCY });

    autoReplyQueue.process(AUTOREPLY_CONCURRENCY, async (job) => {
      logger.debug('[Worker:auto-reply] picked up job', { jobId: job.id });
      return await processAutoReply(job);
    });
    logger.info('[Worker] auto-reply processor started', { concurrency: AUTOREPLY_CONCURRENCY });

    // Scheduled publish: run every 1 minute to publish due posts.
    // Guard against creating duplicate repeat jobs on worker restart.
    scheduledPublishQueue.process(1, async () => {
      return await processScheduledPublish();
    });
    const repeatableJobs = await scheduledPublishQueue.getRepeatableJobs();
    const alreadyScheduled = repeatableJobs.some(j => j.id && j.id.includes('scheduled-publish-repeat'));
    if (!alreadyScheduled) {
      await scheduledPublishQueue.add({}, {
        repeat: { every: 60000 },
        jobId: 'scheduled-publish-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] scheduled-publish repeat job registered');
    } else {
      logger.info('[Worker] scheduled-publish repeat job already exists — skipping registration');
    }
    logger.info('[Worker] scheduled-publish processor started (every 1 min)');

    brandAnalysisQueue.process(BRAND_ANALYSIS_CONCURRENCY, async (job) => {
      logger.debug('[Worker:brand-analysis] picked up job', { jobId: job.id });
      return await processBrandAnalysis(job);
    });
    logger.info('[Worker] brand-analysis processor started', { concurrency: BRAND_ANALYSIS_CONCURRENCY });

    // Knowledge-base website crawl (crawl + per-page AI summarize → KB entries)
    kbCrawlQueue.process(KB_CRAWL_CONCURRENCY, async (job) => {
      logger.debug('[Worker:kb-crawl] picked up job', { jobId: job.id });
      return await processKbCrawl(job);
    });
    logger.info('[Worker] kb-crawl processor started', { concurrency: KB_CRAWL_CONCURRENCY });

    // Public Growth Intelligence audit — lead-magnet, no-auth, fan-out to 3 providers
    publicAuditQueue.process(PUBLIC_AUDIT_CONCURRENCY, async (job) => {
      logger.debug('[Worker:public-audit] picked up job', { jobId: job.id });
      return await processGrowthAudit(job);
    });
    logger.info('[Worker] public-audit processor started', { concurrency: PUBLIC_AUDIT_CONCURRENCY });

    // Demo-trial expiry: run daily to lock demo workspaces past their trial.
    // Guard against duplicate repeat jobs on worker restart.
    demoExpiryQueue.process(1, async () => {
      return await processDemoExpiry();
    });
    const demoRepeatables = await demoExpiryQueue.getRepeatableJobs();
    const demoAlreadyScheduled = demoRepeatables.some(j => j.id && j.id.includes('demo-expiry-repeat'));
    if (!demoAlreadyScheduled) {
      await demoExpiryQueue.add({}, {
        repeat: { every: 24 * 60 * 60 * 1000 }, // daily
        jobId: 'demo-expiry-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] demo-expiry repeat job registered (daily)');
    } else {
      logger.info('[Worker] demo-expiry repeat job already exists — skipping registration');
    }

    // Appointment reminders + no-show sweep: every 10 minutes.
    appointmentReminderQueue.process(1, async () => {
      return await processAppointmentReminders();
    });
    const apptRepeatables = await appointmentReminderQueue.getRepeatableJobs();
    const apptAlreadyScheduled = apptRepeatables.some(j => j.id && j.id.includes('appointment-reminder-repeat'));
    if (!apptAlreadyScheduled) {
      await appointmentReminderQueue.add({}, {
        repeat: { every: 10 * 60 * 1000 }, // every 10 min
        jobId: 'appointment-reminder-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] appointment-reminder repeat job registered (every 10 min)');
    } else {
      logger.info('[Worker] appointment-reminder repeat job already exists — skipping registration');
    }
    logger.info('[Worker] demo-expiry processor started (daily)');

    // Content Studio ephemeral input-image cleanup — every 30 min.
    // Guard against duplicate repeat jobs on worker restart.
    contentStudioInputCleanupQueue.process(1, async () => {
      return await processContentStudioInputCleanup();
    });
    const csInputRepeatables = await contentStudioInputCleanupQueue.getRepeatableJobs();
    const csInputAlreadyScheduled = csInputRepeatables.some(j => j.id && j.id.includes('content-studio-input-cleanup-repeat'));
    if (!csInputAlreadyScheduled) {
      await contentStudioInputCleanupQueue.add({}, {
        repeat: { every: 30 * 60 * 1000 }, // every 30 min
        jobId: 'content-studio-input-cleanup-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] content-studio-input-cleanup repeat job registered (every 30 min)');
    } else {
      logger.info('[Worker] content-studio-input-cleanup repeat job already exists — skipping registration');
    }
    logger.info('[Worker] content-studio-input-cleanup processor started (every 30 min)');

    // Email webhook processor (Gmail Pub/Sub + Outlook Graph)
    emailWebhookQueue.process(EMAIL_WEBHOOK_CONCURRENCY, async (job) => {
      logger.debug('[Worker:email-webhook] picked up job', { jobId: job.id, provider: job.data?.provider });
      return await processEmailWebhook(job);
    });
    logger.info('[Worker] email-webhook processor started', { concurrency: EMAIL_WEBHOOK_CONCURRENCY });

    // IMAP polling processor (runs every 5 minutes per connection)
    imapPollingQueue.process(IMAP_POLL_CONCURRENCY, async (job) => {
      logger.debug('[Worker:imap-polling] picked up job', { jobId: job.id });
      return await processImapPolling(job);
    });
    // Register repeatable IMAP polling job (every 5 minutes)
    const imapRepeatableJobs = await imapPollingQueue.getRepeatableJobs();
    const imapAlreadyScheduled = imapRepeatableJobs.some(j => j.id && j.id.includes('imap-poll-repeat'));
    if (!imapAlreadyScheduled) {
      await imapPollingQueue.add({}, {
        repeat: { every: 5 * 60 * 1000 },
        jobId: 'imap-poll-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] imap-polling repeat job registered (every 5 min)');
    } else {
      logger.info('[Worker] imap-polling repeat job already exists — skipping registration');
    }
    logger.info('[Worker] imap-polling processor started (every 5 min)');

    // Gmail watch renewal (every 6 days — watches expire after 7 days)
    gmailWatchRenewalQueue.process(1, async (job) => {
      return await renewGmailWatches(job);
    });
    const watchRepeatableJobs = await gmailWatchRenewalQueue.getRepeatableJobs();
    const watchAlreadyScheduled = watchRepeatableJobs.some(j => j.id && j.id.includes('gmail-watch-renewal-repeat'));
    if (!watchAlreadyScheduled) {
      await gmailWatchRenewalQueue.add({}, {
        repeat: { every: 6 * 24 * 60 * 60 * 1000 },
        jobId: 'gmail-watch-renewal-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] gmail-watch-renewal repeat job registered (every 6 days)');
    } else {
      logger.info('[Worker] gmail-watch-renewal repeat job already exists — skipping registration');
    }
    logger.info('[Worker] gmail-watch-renewal processor started (every 6 days)');

    // Outlook subscription renewal (every 2 days — subscriptions expire after 3 days)
    outlookRenewalQueue.process(1, async (job) => {
      return await renewOutlookSubscriptions(job);
    });
    const outlookRepeatableJobs = await outlookRenewalQueue.getRepeatableJobs();
    const outlookAlreadyScheduled = outlookRepeatableJobs.some(j => j.id && j.id.includes('outlook-renewal-repeat'));
    if (!outlookAlreadyScheduled) {
      await outlookRenewalQueue.add({}, {
        repeat: { every: 2 * 24 * 60 * 60 * 1000 },
        jobId: 'outlook-renewal-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] outlook-subscription-renewal repeat job registered (every 2 days)');
    } else {
      logger.info('[Worker] outlook-subscription-renewal repeat job already exists — skipping registration');
    }
    logger.info('[Worker] outlook-subscription-renewal processor started (every 2 days)');

    // Voice IVR post-call worker (summarize, CRM upsert, WA follow-up, analytics rollup)
    voiceCallQueue.process(VOICE_CALL_CONCURRENCY, async (job) => {
      logger.debug('[Worker:voice-call] picked up job', { jobId: job.id });
      return await processVoiceCall(job);
    });
    logger.info('[Worker] voice-call processor started', { concurrency: VOICE_CALL_CONCURRENCY });

    flowTickQueue.process(1, async () => processFlowTick());
    const flowTickRepeatable = await flowTickQueue.getRepeatableJobs();
    const flowTickScheduled = flowTickRepeatable.some((j) => j.id && j.id.includes('flow-tick-repeat'));
    if (!flowTickScheduled) {
      await flowTickQueue.add({}, {
        repeat: { every: 30000 },
        jobId: 'flow-tick-repeat',
        removeOnComplete: 5
      });
      logger.info('[Worker] flow-tick repeat job registered (every 30s)');
    }
    logger.info('[Worker] flow-tick processor started');

    const reviewRequestQueue = require('./config/queue').reviewRequestQueue;
    reviewRequestQueue.process(2, async (job) => {
      const { requestId } = job.data;
      logger.debug('[Worker:review-request] processing', { jobId: job.id, requestId });
      const reviewCollectionService = require('./services/reviewCollectionService');
      return await reviewCollectionService.sendRequest(requestId);
    });
    logger.info('[Worker] review-request processor started', { concurrency: 2 });

    // Payment webhook queue — confirmation DMs and (Phase 2+) provider event fulfilment
    const PAYMENT_WEBHOOK_CONCURRENCY = parseInt(process.env.PAYMENT_WEBHOOK_CONCURRENCY) || 5;
    paymentWebhookQueue.process(PAYMENT_WEBHOOK_CONCURRENCY, async (job) => {
      logger.debug('[Worker:payment-webhook] picked up job', { jobId: job.id, type: job.data?.type });
      return await processPaymentWebhook(job);
    });
    logger.info('[Worker] payment-webhook processor started', { concurrency: PAYMENT_WEBHOOK_CONCURRENCY });

    // ── Shopify platform-sync queue ──────────────────────────────────────────
    // Processor handles two job types:
    //   1. Explicit jobs (connectionId provided) — full backfill on connect or manual sync
    //   2. Repeatable safety-net (every 6h) — iterates ALL active Shopify connections
    platformSyncQueue.process(2, async (job) => {
      const { runFullSync } = require('./services/shopifySyncService');
      const PlatformConnection = require('./models/PlatformConnection');
      const { connectionId, orgId } = job.data || {};

      if (connectionId) {
        // Targeted sync for one connection
        const conn = await PlatformConnection.findById(connectionId);
        if (conn && conn.isActive) {
          logger.info('[Worker:platform-sync] Running targeted Shopify sync', { connectionId });
          return runFullSync(conn);
        }
        logger.warn('[Worker:platform-sync] Connection not found or inactive', { connectionId });
        return;
      }

      // Safety-net sweep — sync every active Shopify connection
      const connections = await PlatformConnection.find({ platform: 'shopify', isActive: true });
      logger.info(`[Worker:platform-sync] Safety-net sweep: ${connections.length} Shopify connection(s)`);
      for (const conn of connections) {
        try {
          await runFullSync(conn);
        } catch (err) {
          logger.error('[Worker:platform-sync] Safety-net sync failed', { connId: conn._id, error: err.message });
        }
      }
    });

    // Register the 6-hour repeatable safety-net job (idempotent — won't duplicate on restart)
    const existingPlatformSyncJobs = await platformSyncQueue.getRepeatableJobs();
    const shopifySafetyNetExists = existingPlatformSyncJobs.some(j => j.id === 'shopify-safety-net');
    if (!shopifySafetyNetExists) {
      await platformSyncQueue.add({}, {
        repeat: { cron: '0 */6 * * *' },
        jobId: 'shopify-safety-net',
        removeOnComplete: 5
      });
      logger.info('[Worker] Shopify safety-net sync registered (every 6h)');
    } else {
      logger.info('[Worker] Shopify safety-net sync already registered');
    }
    logger.info('[Worker] platform-sync processor started', { concurrency: 2 });

    audienceMaterializeQueue.process(2, (job) => require('./jobs/processAudienceMaterialize')(job));
    socialCampaignSendQueue.process(2, (job) => require('./jobs/processSocialCampaign')(job));
    activationCampaignLaunchQueue.process(2, (job) => require('./jobs/processActivationCampaignLaunch')(job));
    contactIntelligenceQueue.process(2, (job) => require('./jobs/processContactIntelligence')(job));
    duplicateScanQueue.process(1, (job) => require('./jobs/processDuplicateScan')(job));

    const activationRepeatables = await activationCampaignLaunchQueue.getRepeatableJobs();
    if (!activationRepeatables.some((j) => j.id === 'activation-scheduled-sweep')) {
      await activationCampaignLaunchQueue.add(
        { sweep: true },
        { repeat: { every: 5 * 60 * 1000 }, jobId: 'activation-scheduled-sweep', removeOnComplete: 5 }
      );
      logger.info('[Worker] activation scheduled-campaign sweep registered (every 5 min)');
    }

    const duplicateRepeatables = await duplicateScanQueue.getRepeatableJobs();
    if (!duplicateRepeatables.some((j) => j.id === 'duplicate-scan-nightly')) {
      await duplicateScanQueue.add(
        { nightly: true },
        { repeat: { cron: '0 3 * * *' }, jobId: 'duplicate-scan-nightly', removeOnComplete: 5 }
      );
      logger.info('[Worker] duplicate-scan nightly coordinator registered (03:00 UTC)');
    }

    logger.info('[Worker] contact activation queues registered');

    if (campaignConfig.enableInCoreWorker) {
      await registerCampaignWorkers();
      logger.info('[Worker] campaign queues registered in core worker (set ENABLE_CAMPAIGN_IN_CORE_WORKER=false + run campaignWorker.js in production)');
    } else {
      logger.info('[Worker] campaign queues skipped — use campaignWorker.js');
    }

    logger.info('✨ Worker started successfully', {
      webhook: WEBHOOK_CONCURRENCY,
      ai: AI_CONCURRENCY,
      autoReply: AUTOREPLY_CONCURRENCY,
      brandAnalysis: BRAND_ANALYSIS_CONCURRENCY,
      emailWebhook: EMAIL_WEBHOOK_CONCURRENCY,
      imapPoll: IMAP_POLL_CONCURRENCY,
      voiceCall: VOICE_CALL_CONCURRENCY
    });

    const shutdown = async (signal) => {
      logger.warn(`${signal} signal received: closing worker`);
      try {
        await Promise.all([
          webhookQueue.close(),
          aiQueue.close(),
          autoReplyQueue.close(),
          scheduledPublishQueue.close(),
          brandAnalysisQueue.close(),
          emailWebhookQueue.close(),
          imapPollingQueue.close(),
          gmailWatchRenewalQueue.close(),
          outlookRenewalQueue.close(),
          voiceCallQueue.close(),
          campaignSendQueue.close(),
          campaignInboxQueue.close(),
          flowTickQueue.close(),
          publicAuditQueue.close(),
          reviewRequestQueue.close(),
          paymentWebhookQueue.close(),
          platformSyncQueue.close(),
          audienceMaterializeQueue.close(),
          socialCampaignSendQueue.close(),
          activationCampaignLaunchQueue.close(),
          contactIntelligenceQueue.close(),
          duplicateScanQueue.close()
        ]);
        process.exit(0);
      } catch (err) {
        logger.error('Error during worker shutdown', { error: err.message, stack: err.stack });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Worker startup error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

startWorker().catch((err) => {
  logger.error('Worker bootstrap failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
