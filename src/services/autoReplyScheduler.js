const { autoReplyQueue } = require('../config/queue');
const Organization = require('../models/Organization');
const aiService = require('./aiService');
const { isThreadStyleDm } = require('../utils/interactionThreadDm');
const logger = require('../config/logger');

/**
 * Auto-Reply Scheduler Service
 * Manages scheduled auto-reply jobs using Bull repeatable jobs
 */
class AutoReplyScheduler {
  /**
   * Initialize scheduled jobs for all organizations
   */
  async initializeScheduledJobs() {
    try {
      logger.info('\n🔄 [Scheduler] Initializing auto-reply scheduled jobs...');

      const query = {
        'autoReplySettings.enabled': true,
        'autoReplySettings.triggerMode': { $in: ['scheduled', 'hybrid'] },
        'autoReplySettings.scheduleEnabled': true
      };
      
      logger.info('🔍 [Scheduler] Query', { query });

      const organizations = await Organization.find(query);

      logger.info(`📊 [Scheduler] Found ${organizations.length} organizations with scheduled auto-reply enabled`);

      if (organizations.length === 0) {
        logger.info('⚠️  [Scheduler] No organizations found! Check your settings:');
        logger.info('   - autoReplySettings.enabled = true');
        logger.info('   - autoReplySettings.triggerMode = "scheduled" or "hybrid"');
        logger.info('   - autoReplySettings.scheduleEnabled = true');
      }

      for (const org of organizations) {
        logger.info(`\n📝 [Scheduler] Processing organization: ${org._id}`);
        logger.info(`   Settings`, {
          enabled: org.autoReplySettings.enabled,
          triggerMode: org.autoReplySettings.triggerMode,
          scheduleEnabled: org.autoReplySettings.scheduleEnabled,
          scheduleInterval: org.autoReplySettings.scheduleInterval
        });
        await this.scheduleForOrganization(org);
      }

      logger.info('\n✅ [Scheduler] Auto-reply scheduler initialization complete\n');
    } catch (error) {
      logger.error('❌ [Scheduler] Error initializing scheduled jobs', { error: error.message, stack: error.stack });
    }
  }

  /**
   * Schedule repeatable job for an organization
   */
  async scheduleForOrganization(organization) {
    try {
      const orgId = organization._id.toString();
      const interval = this.getIntervalMs(
        organization.autoReplySettings.scheduleInterval || '24hours'
      );

      // Remove existing repeatable job if any
      await this.removeScheduledJob(orgId);

      // Add new repeatable job
      await autoReplyQueue.add(
        {
          type: 'scheduled',
          organizationId: orgId
        },
        {
          repeat: {
            every: interval
          },
          jobId: `auto-reply-scheduled-${orgId}`,
          removeOnComplete: 10, // Keep last 10 completed jobs
          removeOnFail: 20 // Keep last 20 failed jobs
        }
      );

      logger.info(`Scheduled auto-reply job for org ${orgId} with interval: ${organization.autoReplySettings.scheduleInterval}`);
    } catch (error) {
      logger.error(`Error scheduling job for org ${organization._id}`, { error: error.message, stack: error.stack });
    }
  }

  /**
   * Remove scheduled job for an organization
   */
  async removeScheduledJob(orgId) {
    try {
      const repeatableJobs = await autoReplyQueue.getRepeatableJobs();
      const jobToRemove = repeatableJobs.find(j => j.id === `auto-reply-scheduled-${orgId}`);
      
      if (jobToRemove) {
        await autoReplyQueue.removeRepeatableByKey(jobToRemove.key);
        logger.info(`Removed existing scheduled job for org ${orgId}`);
      }
    } catch (error) {
      logger.error(`Error removing scheduled job for org ${orgId}`, { error: error.message, stack: error.stack });
    }
  }

  /**
   * Update scheduled job when organization settings change
   */
  async updateScheduledJob(organization) {
    const orgId = organization._id.toString();
    const settings = organization.autoReplySettings;

    if (settings.enabled && 
        (settings.triggerMode === 'scheduled' || settings.triggerMode === 'hybrid') &&
        settings.scheduleEnabled) {
      await this.scheduleForOrganization(organization);
    } else {
      await this.removeScheduledJob(orgId);
    }
  }

  /**
   * Queue immediate auto-reply job (webhook-triggered)
   */
  async queueImmediateAutoReply(interactionId, organizationId, delayMinutes = 5) {
    try {
      const organization = await Organization.findById(organizationId);
      
      if (!organization) {
        logger.info(`⚠️  [Auto-Reply Queue] Organization ${organizationId} not found`);
        return false;
      }

      if (!organization.autoReplySettings.enabled) {
        logger.info(`⚠️  [Auto-Reply Queue] Auto-reply disabled for org ${organizationId}`);
        return false;
      }

      const settings = organization.autoReplySettings;
      
      // Check if webhook mode or hybrid mode is enabled
      if (settings.triggerMode !== 'webhook' && settings.triggerMode !== 'hybrid') {
        logger.info(`⚠️  [Auto-Reply Queue] Skipping — triggerMode is "${settings.triggerMode || 'not set'}" (must be "webhook" or "hybrid" for immediate replies). Org: ${organizationId}`);
        return false;
      }

      if (!settings.webhookImmediate) {
        logger.info(`⚠️  [Auto-Reply Queue] Skipping — webhookImmediate is false/not set. Org: ${organizationId}`);
        return false;
      }

      const Interaction = require('../models/Interaction');
      const interaction = await Interaction.findById(interactionId).select(
        'replies status platform type platformId metadata.lastMid'
      );

      if (!interaction) {
        logger.info(`⚠️  [Auto-Reply Queue] Interaction ${interactionId} not found`);
        return false;
      }

      const threadDm = isThreadStyleDm(interaction);
      if (!threadDm) {
        if (interaction.replies && interaction.replies.length > 0) {
          logger.info(`⚠️  [Auto-Reply Queue] Skipping — interaction ${interactionId} already has replies`);
          return false;
        }
      }
      // Thread DMs: a new inbound webhook sets status to unread first; if still replied/resolved,
      // do not enqueue (e.g. human already replied — matches processAutoReply single-job guards).
      if (interaction.status === 'replied' || interaction.status === 'resolved') {
        logger.info(`⚠️  [Auto-Reply Queue] Skipping — interaction ${interactionId} status is "${interaction.status}"`);
        return false;
      }

      // Respect platform / interaction-type settings (same rules as canAutoReply pre-check)
      if (!aiService.shouldQueueImmediateAutoReply(interaction, organization)) {
        const enabledPlats = settings.enabledPlatforms?.join(', ') || 'all';
        const enabledTypes = settings.enabledTypes?.join(', ') || 'all';
        logger.info(`⚠️  [Auto-Reply Queue] Skipping — platform/type not enabled. Interaction: platform="${interaction.platform}" type="${interaction.type}". Settings: enabledPlatforms=[${enabledPlats}] enabledTypes=[${enabledTypes}]. Org: ${organizationId}`);
        return false;
      }

      // Use configured delay; enforce a short floor so processAI can finish (sentiment, intent, complaint rules)
      const rawMin = Number(settings.webhookDelay);
      const delay =
        Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : (delayMinutes ?? 5);
      const delayMs = Math.max(delay * 60 * 1000, 45 * 1000);

      const mid = interaction.metadata?.lastMid;
      const autoReplyJobId =
        threadDm && mid
          ? `auto-reply-${interactionId}-${mid}`
          : `auto-reply-${interactionId}`;

      await autoReplyQueue.add(
        {
          type: 'single',
          interactionId: interactionId,
          organizationId: organizationId,
          ...(threadDm && mid ? { expectedLastMid: mid } : {})
        },
        {
          jobId: autoReplyJobId,
          delay: delayMs,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: true,
          removeOnFail: false
        }
      );

      return true;

    } catch (error) {
      logger.error('❌ [Auto-Reply Queue] Error', { error: error.message, stack: error.stack });
      return false;
    }
  }

  /**
   * Convert interval string to milliseconds
   */
  getIntervalMs(interval) {
    const map = {
      '15min': 15 * 60 * 1000,
      '30min': 30 * 60 * 1000,
      '1hour': 60 * 60 * 1000,
      '6hours': 6 * 60 * 60 * 1000,
      '12hours': 12 * 60 * 60 * 1000,
      '24hours': 24 * 60 * 60 * 1000
    };
    return map[interval] || map['24hours'];
  }

  /**
   * Get all scheduled jobs status
   */
  async getScheduledJobsStatus() {
    try {
      const repeatableJobs = await autoReplyQueue.getRepeatableJobs();
      return repeatableJobs.filter(j => j.id && j.id.startsWith('auto-reply-scheduled-'));
    } catch (error) {
      logger.error('Error getting scheduled jobs status', { error: error.message, stack: error.stack });
      return [];
    }
  }
}

module.exports = new AutoReplyScheduler();

