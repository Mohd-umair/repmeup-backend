require('dotenv').config();
const connectDB = require('./config/database');
const { connectRedis } = require('./config/redis');
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
  publicAuditQueue
} = require('./config/queue');
const processWebhook = require('./jobs/processWebhook');
const processAI = require('./jobs/processAI');
const processAutoReply = require('./jobs/processAutoReply');
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
          publicAuditQueue.close()
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
