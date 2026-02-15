const logger = require('../config/logger');
const { randomUUID } = require('crypto');

/**
 * Request Logger Middleware
 * Adds request ID and logger instance to each request
 * Logs request start and completion with duration
 */
const requestLogger = (req, res, next) => {
  // Generate or use existing request ID
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.requestId = requestId;
  
  // Create child logger with request context
  req.log = logger.createChild({
    reqId: requestId,
    method: req.method,
    path: req.path,
    ip: req.ip || req.connection.remoteAddress
  });
  
  // Capture request start time
  const startTime = Date.now();
  
  // Log request start (only for non-health checks)
  if (req.path !== '/health') {
    req.log.info('Request started', {
      method: req.method,
      url: req.originalUrl,
      userAgent: req.headers['user-agent']
    });
  }
  
  // Capture response
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    
    // Add request ID to response headers
    res.setHeader('X-Request-Id', requestId);
    
    // Log response (skip health checks)
    if (req.path !== '/health') {
      const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      
      req.log.log(logLevel, 'Request completed', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration: `${duration}ms`
      });
    }
    
    // Call original send
    return originalSend.call(this, data);
  };
  
  next();
};

module.exports = requestLogger;
