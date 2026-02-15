const { autoReplyQueue } = require('../config/queue');
const Organization = require('../models/Organization');

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
      console.log('\n🔄 [Scheduler] Initializing auto-reply scheduled jobs...');

      const query = {
        'autoReplySettings.enabled': true,
        'autoReplySettings.triggerMode': { $in: ['scheduled', 'hybrid'] },
        'autoReplySettings.scheduleEnabled': true
      };
      
      console.log('🔍 [Scheduler] Query:', JSON.stringify(query));

      const organizations = await Organization.find(query);

      console.log(`📊 [Scheduler] Found ${organizations.length} organizations with scheduled auto-reply enabled`);

      if (organizations.length === 0) {
        console.log('⚠️  [Scheduler] No organizations found! Check your settings:');
        console.log('   - autoReplySettings.enabled = true');
        console.log('   - autoReplySettings.triggerMode = "scheduled" or "hybrid"');
        console.log('   - autoReplySettings.scheduleEnabled = true');
      }

      for (const org of organizations) {
        console.log(`\n📝 [Scheduler] Processing organization: ${org._id}`);
        console.log(`   Settings:`, {
          enabled: org.autoReplySettings.enabled,
          triggerMode: org.autoReplySettings.triggerMode,
          scheduleEnabled: org.autoReplySettings.scheduleEnabled,
          scheduleInterval: org.autoReplySettings.scheduleInterval
        });
        await this.scheduleForOrganization(org);
      }

      console.log('\n✅ [Scheduler] Auto-reply scheduler initialization complete\n');
    } catch (error) {
      console.error('❌ [Scheduler] Error initializing scheduled jobs:', error);
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

      console.log(`Scheduled auto-reply job for org ${orgId} with interval: ${organization.autoReplySettings.scheduleInterval}`);
    } catch (error) {
      console.error(`Error scheduling job for org ${organization._id}:`, error);
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
        console.log(`Removed existing scheduled job for org ${orgId}`);
      }
    } catch (error) {
      console.error(`Error removing scheduled job for org ${orgId}:`, error);
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
        console.log(`⚠️  [Auto-Reply Queue] Organization ${organizationId} not found`);
        return false;
      }

      if (!organization.autoReplySettings.enabled) {
        console.log(`⚠️  [Auto-Reply Queue] Auto-reply disabled for org ${organizationId}`);
        return false;
      }

      const settings = organization.autoReplySettings;
      
      // Check if webhook mode or hybrid mode is enabled
      if (settings.triggerMode !== 'webhook' && settings.triggerMode !== 'hybrid') {
        return false;
      }

      if (!settings.webhookImmediate) {
        return false;
      }

      // Pre-check: Don't queue if interaction already has replies
      const Interaction = require('../models/Interaction');
      const interaction = await Interaction.findById(interactionId).select('replies status');
      
      if (!interaction) {
        console.log(`⚠️  [Auto-Reply Queue] Interaction ${interactionId} not found`);
        return false;
      }

      // Skip if already replied or has replies
      if (interaction.replies && interaction.replies.length > 0) {
        return false; // Silently skip - already handled
      }

      if (interaction.status === 'replied' || interaction.status === 'resolved') {
        return false; // Silently skip - already handled
      }

      // Use configured delay
      const delay = settings.webhookDelay || delayMinutes;

      // Add job with delay and unique jobId to prevent duplicates
      await autoReplyQueue.add(
        {
          type: 'single',
          interactionId: interactionId,
          organizationId: organizationId
        },
        {
          jobId: `auto-reply-${interactionId}`, // Unique ID prevents duplicate jobs for same interaction
          delay: delay * 60 * 1000, // Convert minutes to milliseconds
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
      console.error('❌ [Auto-Reply Queue] Error:', error);
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
      console.error('Error getting scheduled jobs status:', error);
      return [];
    }
  }
}

module.exports = new AutoReplyScheduler();

