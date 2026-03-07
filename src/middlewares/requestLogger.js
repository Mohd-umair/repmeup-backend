const logger = require('../config/logger');
const { randomUUID } = require('crypto');

/**
 * Request Logger Middleware
 * Adds request ID and logger instance to each request.
 * Logs request start/completion only when LOG_HTTP=1 (to reduce console noise).
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
  const shouldLogRequests = process.env.LOG_HTTP === '1';
  
  // Log request start only when LOG_HTTP=1 (skip health checks either way)
  if (shouldLogRequests && req.path !== '/health') {
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
    
    // Log response only when LOG_HTTP=1 (skip health checks either way)
    if (shouldLogRequests && req.path !== '/health') {
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
