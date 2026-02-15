const logger = require('../config/logger');

/**
 * Structured Event Logging Helpers
 * Provides consistent logging patterns for different event types
 */

/**
 * Authentication Events
 */
const auth = {
  login: (data) => {
    const { userId, provider, success, ip, error } = data;
    const level = success ? 'info' : 'warn';
    logger.log(level, 'Auth: Login', {
      event: 'auth.login',
      userId: userId?.toString(),
      provider,
      success,
      ip,
      error: error?.message
    });
  },

  logout: (data) => {
    const { userId } = data;
    logger.info('Auth: Logout', {
      event: 'auth.logout',
      userId: userId?.toString()
    });
  },

  tokenRefresh: (data) => {
    const { userId, success, error } = data;
    const level = success ? 'info' : 'warn';
    logger.log(level, 'Auth: Token refresh', {
      event: 'auth.token_refresh',
      userId: userId?.toString(),
      success,
      error: error?.message
    });
  },

  failure: (data) => {
    const { reason, email, ip } = data;
    logger.warn('Auth: Failure', {
      event: 'auth.failure',
      reason,
      email,
      ip
    });
  }
};

/**
 * Job Events (Queue Processing)
 */
const job = {
  started: (data) => {
    const { queue, jobId, type } = data;
    logger.info('Job: Started', {
      event: 'job.started',
      queue,
      jobId,
      type
    });
  },

  completed: (data) => {
    const { queue, jobId, duration, result } = data;
    logger.info('Job: Completed', {
      event: 'job.completed',
      queue,
      jobId,
      duration: `${duration}ms`,
      resultSummary: result ? Object.keys(result).join(', ') : undefined
    });
  },

  failed: (data) => {
    const { queue, jobId, error, attemptsMade, retriesLeft } = data;
    logger.error('Job: Failed', {
      event: 'job.failed',
      queue,
      jobId,
      error: error?.message,
      stack: error?.stack,
      attemptsMade,
      retriesLeft
    });
  }
};

/**
 * Platform Sync Events
 */
const sync = {
  started: (data) => {
    const { platform, orgId, triggeredBy } = data;
    logger.info('Sync: Started', {
      event: 'sync.started',
      platform,
      orgId: orgId?.toString(),
      triggeredBy
    });
  },

  completed: (data) => {
    const { platform, orgId, count, duration, newInteractions } = data;
    logger.info('Sync: Completed', {
      event: 'sync.completed',
      platform,
      orgId: orgId?.toString(),
      totalCount: count,
      newInteractions,
      duration: `${duration}ms`
    });
  },

  failed: (data) => {
    const { platform, orgId, error } = data;
    logger.error('Sync: Failed', {
      event: 'sync.failed',
      platform,
      orgId: orgId?.toString(),
      error: error?.message,
      stack: error?.stack
    });
  }
};

/**
 * Webhook Events
 */
const webhook = {
  received: (data) => {
    const { platform, eventType, objectId, orgId } = data;
    logger.info('Webhook: Received', {
      event: 'webhook.received',
      platform,
      eventType,
      objectId,
      orgId: orgId?.toString()
    });
  },

  processed: (data) => {
    const { platform, eventType, interactionId, duration } = data;
    logger.info('Webhook: Processed', {
      event: 'webhook.processed',
      platform,
      eventType,
      interactionId: interactionId?.toString(),
      duration: `${duration}ms`
    });
  },

  error: (data) => {
    const { platform, eventType, error, payload } = data;
    logger.error('Webhook: Error', {
      event: 'webhook.error',
      platform,
      eventType,
      error: error?.message,
      payloadPreview: JSON.stringify(payload)?.substring(0, 200)
    });
  }
};

/**
 * Auto-Reply Events
 */
const autoReply = {
  queued: (data) => {
    const { interactionId, orgId, triggerMode } = data;
    logger.info('Auto-reply: Queued', {
      event: 'autoreply.queued',
      interactionId: interactionId?.toString(),
      orgId: orgId?.toString(),
      triggerMode
    });
  },

  generated: (data) => {
    const { interactionId, confidence, sentiment, length } = data;
    logger.info('Auto-reply: Generated', {
      event: 'autoreply.generated',
      interactionId: interactionId?.toString(),
      confidence,
      sentiment,
      replyLength: length
    });
  },

  sent: (data) => {
    const { interactionId, platform, replyId } = data;
    logger.info('Auto-reply: Sent', {
      event: 'autoreply.sent',
      interactionId: interactionId?.toString(),
      platform,
      replyId: replyId?.toString()
    });
  },

  skipped: (data) => {
    const { interactionId, reason } = data;
    logger.debug('Auto-reply: Skipped', {
      event: 'autoreply.skipped',
      interactionId: interactionId?.toString(),
      reason
    });
  },

  failed: (data) => {
    const { interactionId, error, phase } = data;
    logger.error('Auto-reply: Failed', {
      event: 'autoreply.failed',
      interactionId: interactionId?.toString(),
      phase,
      error: error?.message
    });
  }
};

/**
 * AI Service Events
 */
const ai = {
  analysisStarted: (data) => {
    const { interactionId, operation } = data;
    logger.info('AI: Analysis started', {
      event: 'ai.analysis_started',
      interactionId: interactionId?.toString(),
      operation
    });
  },

  analysisCompleted: (data) => {
    const { interactionId, operation, duration, creditsUsed } = data;
    logger.info('AI: Analysis completed', {
      event: 'ai.analysis_completed',
      interactionId: interactionId?.toString(),
      operation,
      duration: `${duration}ms`,
      creditsUsed
    });
  },

  error: (data) => {
    const { operation, error, context } = data;
    logger.error('AI: Error', {
      event: 'ai.error',
      operation,
      error: error?.message,
      stack: error?.stack,
      ...context
    });
  }
};

/**
 * Platform API Call Events
 */
const platformApi = {
  call: (data) => {
    const { platform, method, endpoint, status, duration, error } = data;
    const level = status >= 500 || error ? 'error' : status >= 400 ? 'warn' : 'debug';
    
    logger.log(level, `Platform API: ${platform}`, {
      event: 'platform_api.call',
      platform,
      method,
      endpoint: endpoint?.substring(0, 100),
      status,
      duration: duration ? `${duration}ms` : undefined,
      error: error?.message
    });
  }
};

/**
 * Escalation Events
 */
const escalation = {
  triggered: (data) => {
    const { interactionId, reason, assignedTo } = data;
    logger.warn('Escalation: Triggered', {
      event: 'escalation.triggered',
      interactionId: interactionId?.toString(),
      reason,
      assignedTo: assignedTo?.toString()
    });
  },

  notificationSent: (data) => {
    const { interactionId, recipientId, channel } = data;
    logger.info('Escalation: Notification sent', {
      event: 'escalation.notification_sent',
      interactionId: interactionId?.toString(),
      recipientId: recipientId?.toString(),
      channel
    });
  }
};

/**
 * System Events
 */
const system = {
  startup: (data) => {
    const { service, version, environment } = data;
    logger.info('System: Startup', {
      event: 'system.startup',
      service,
      version,
      environment
    });
  },

  shutdown: (data) => {
    const { reason } = data;
    logger.info('System: Shutdown', {
      event: 'system.shutdown',
      reason
    });
  },

  dbConnected: (data) => {
    const { database, host } = data;
    logger.info('System: Database connected', {
      event: 'system.db_connected',
      database,
      host
    });
  },

  redisConnected: (data) => {
    const { host, port } = data;
    logger.info('System: Redis connected', {
      event: 'system.redis_connected',
      host,
      port
    });
  },

  error: (data) => {
    const { component, error, fatal } = data;
    const level = fatal ? 'error' : 'warn';
    logger.log(level, 'System: Error', {
      event: 'system.error',
      component,
      error: error?.message,
      stack: error?.stack,
      fatal
    });
  }
};

module.exports = {
  auth,
  job,
  sync,
  webhook,
  autoReply,
  ai,
  platformApi,
  escalation,
  system
};
