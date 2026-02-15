const winston = require('winston');
const path = require('path');
const DailyRotateFile = require('winston-daily-rotate-file');

/**
 * Logger Configuration - Winston-based structured logging
 * Supports development and production modes with appropriate formats
 */

// Determine log level from environment
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FORMAT = process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');
const LOG_FILE_PATH = process.env.LOG_FILE_PATH || './logs';
const LOG_ROTATE_DAYS = parseInt(process.env.LOG_ROTATE_DAYS) || 14;

// Sensitive fields to mask in logs
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'session',
  'creditCard',
  'ssn'
];

/**
 * Mask sensitive data in objects
 */
function maskSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const masked = Array.isArray(obj) ? [...obj] : { ...obj };
  
  for (const key in masked) {
    const lowerKey = key.toLowerCase();
    
    // Check if key contains sensitive field names
    const isSensitive = SENSITIVE_FIELDS.some(field => lowerKey.includes(field));
    
    if (isSensitive && typeof masked[key] === 'string') {
      // Mask the value
      masked[key] = '***MASKED***';
    } else if (typeof masked[key] === 'object' && masked[key] !== null) {
      // Recursively mask nested objects
      masked[key] = maskSensitiveData(masked[key]);
    }
  }
  
  return masked;
}

/**
 * Custom format for development - pretty print with colors
 */
const prettyFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, module, reqId, orgId, userId, jobId, ...meta }) => {
    let log = `${timestamp} [${level}]`;
    
    // Add context if available
    if (module) log += ` [${module}]`;
    if (reqId) log += ` [req:${reqId.substring(0, 8)}]`;
    if (jobId) log += ` [job:${jobId}]`;
    if (orgId) log += ` [org:${orgId.toString().substring(0, 8)}]`;
    if (userId) log += ` [user:${userId.toString().substring(0, 8)}]`;
    
    log += `: ${message}`;
    
    // Add metadata if present
    const metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
      // Mask sensitive data
      const maskedMeta = maskSensitiveData(meta);
      log += ` ${JSON.stringify(maskedMeta)}`;
    }
    
    return log;
  })
);

/**
 * Custom format for production - structured JSON
 */
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format((info) => {
    // Mask sensitive data in production logs
    return maskSensitiveData(info);
  })()
);

/**
 * Create transports based on environment
 */
const transports = [];

// Console transport (always enabled)
transports.push(
  new winston.transports.Console({
    format: LOG_FORMAT === 'json' ? jsonFormat : prettyFormat
  })
);

// File transports (optional, for production)
if (process.env.NODE_ENV === 'production' && LOG_FILE_PATH) {
  // Combined log file (all logs)
  transports.push(
    new DailyRotateFile({
      filename: path.join(LOG_FILE_PATH, 'orm-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: `${LOG_ROTATE_DAYS}d`,
      format: jsonFormat,
      level: 'info'
    })
  );
  
  // Error log file (errors only)
  transports.push(
    new DailyRotateFile({
      filename: path.join(LOG_FILE_PATH, 'orm-error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: `${LOG_ROTATE_DAYS}d`,
      format: jsonFormat,
      level: 'error'
    })
  );
}

/**
 * Create Winston logger instance
 */
const logger = winston.createLogger({
  level: LOG_LEVEL,
  levels: winston.config.npm.levels, // error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
  transports,
  exitOnError: false,
  // Don't log unhandled rejections (we handle them separately)
  exceptionHandlers: process.env.NODE_ENV === 'production' ? [
    new winston.transports.File({ filename: path.join(LOG_FILE_PATH, 'exceptions.log') })
  ] : []
});

/**
 * Create child logger with context
 * @param {Object} context - Additional context (module, reqId, orgId, userId, jobId)
 * @returns {winston.Logger} Child logger with context
 */
logger.createChild = function(context = {}) {
  return logger.child(context);
};

/**
 * Log HTTP request (for Morgan integration)
 */
logger.http = function(message, meta = {}) {
  logger.log('http', message, meta);
};

/**
 * Convenience methods with consistent structure
 */

// Log error with full context
logger.logError = function(message, error, context = {}) {
  logger.error(message, {
    error: error.message,
    stack: error.stack,
    ...context
  });
};

// Log event (business/system events)
logger.logEvent = function(eventName, eventData = {}) {
  logger.info(`Event: ${eventName}`, eventData);
};

// Log API call (external services)
logger.logApiCall = function(service, method, url, status, duration, error = null) {
  const level = status >= 500 || error ? 'error' : status >= 400 ? 'warn' : 'info';
  logger.log(level, `API Call: ${service}`, {
    service,
    method,
    url: url?.substring(0, 100), // Truncate long URLs
    status,
    duration,
    error: error?.message
  });
};

// Log startup
logger.info('Logger initialized', {
  level: LOG_LEVEL,
  format: LOG_FORMAT,
  environment: process.env.NODE_ENV,
  fileLogging: process.env.NODE_ENV === 'production' && LOG_FILE_PATH ? 'enabled' : 'disabled'
});

module.exports = logger;
