# Logging System Implementation - Complete

## Summary

A comprehensive structured logging system has been successfully implemented for the ORM backend using Winston. The system provides enterprise-grade logging capabilities with proper log levels, structured data, request correlation, and sensitive data masking.

## Completed Components

### 1. Logger Module ✅
**File**: `backend/src/config/logger.js`

- Winston-based structured logging
- Environment-aware formatting (pretty for dev, JSON for production)
- Log levels: error, warn, info, http, debug
- Child logger factory for contextual logging
- Sensitive data masking (passwords, tokens, secrets)
- Optional file rotation with `winston-daily-rotate-file`

### 2. Request Logger Middleware ✅
**File**: `backend/src/middlewares/requestLogger.js`

- Generates unique request ID for each request
- Attaches `req.log` child logger with request context
- Logs request start and completion with duration
- Adds `X-Request-Id` header to responses
- Skips health check endpoint logging

**Integration**: Added to `backend/src/app.js` after body parser

### 3. Structured Event Helpers ✅
**File**: `backend/src/utils/logEvents.js`

Provides consistent logging patterns for:
- **Authentication**: login, logout, token refresh, failures
- **Jobs**: started, completed, failed
- **Platform Sync**: started, completed, failed
- **Webhooks**: received, processed, errors
- **Auto-Reply**: queued, generated, sent, skipped, failed
- **AI Service**: analysis started/completed, errors
- **Platform API**: external API calls
- **Escalation**: triggered, notification sent
- **System**: startup, shutdown, DB/Redis connection, errors

### 4. Configuration ✅
**File**: `backend/.env`

Added logging configuration variables:
```env
LOG_LEVEL=info          # error | warn | info | debug
LOG_FORMAT=json         # json | pretty
LOG_FILE_PATH=./logs    # Optional file output
LOG_ROTATE_DAYS=14      # Log retention
```

### 5. Critical Path Integration ✅

Successfully integrated logger in:

#### Core System
- ✅ `backend/src/middlewares/errorHandler.js` - Error logging with full context
- ✅ `backend/src/server.js` - Startup, shutdown, uncaught exceptions

#### Queue Processors
- ✅ `backend/src/jobs/processWebhook.js` - Webhook processing logs
- ✅ `backend/src/jobs/processAI.js` - AI analysis logs with logEvents
- ✅ `backend/src/jobs/processAutoReply.js` - Auto-reply logs with logEvents

#### Controllers
- ✅ `backend/src/controllers/webhookController.js` - Webhook events
- ✅ `backend/src/controllers/platformController.js` - OAuth and sync errors
- ✅ `backend/src/controllers/authController.js` - Already clean (no console logs)

#### Services
- ✅ `backend/src/services/aiService.js` - Provider selection and initialization

## Dependencies Installed

```json
{
  "winston": "^3.11.0",
  "winston-daily-rotate-file": "^4.7.1"
}
```

## Features

### Request Correlation
Every request gets a unique `requestId` that flows through:
- Request logger
- Child loggers
- Response headers
- All log entries for that request

### Contextual Logging
Child loggers carry context throughout the application:
```javascript
const jobLogger = logger.createChild({ 
  module: 'processAutoReply', 
  jobId: job.id,
  orgId: organizationId 
});
```

### Structured Data
All logs use structured JSON format in production:
```javascript
logger.info('Auto-reply job completed', {
  sent: 5,
  processed: 10,
  skipped: 2,
  todayTotal: 45,
  dailyLimit: 100
});
```

### Sensitive Data Masking
Automatically masks sensitive fields:
- password, token, accessToken, refreshToken
- secret, apiKey, authorization
- cookie, session, creditCard, ssn

### Environment-Aware Formatting
- **Development**: Pretty-printed with colors, human-readable
- **Production**: JSON format for log aggregation and parsing

## Usage Examples

### Basic Logging
```javascript
const logger = require('./config/logger');

logger.info('Server started', { port: 3000 });
logger.error('Database connection failed', { 
  error: err.message,
  stack: err.stack
});
```

### Request Logger
```javascript
// Automatically available in controllers via middleware
exports.getUser = async (req, res) => {
  req.log.info('Fetching user', { userId: req.params.id });
  // ...
};
```

### Event Helpers
```javascript
const logEvents = require('./utils/logEvents');

// Auth events
logEvents.auth.login({ userId, provider: 'google', success: true });

// Auto-reply events
logEvents.autoReply.sent({ interactionId, platform: 'instagram' });

// Webhook events
logEvents.webhook.received({ platform: 'youtube', eventType: 'comment' });
```

### Child Loggers
```javascript
const jobLogger = logger.createChild({ 
  module: 'syncService',
  orgId: organization._id 
});

jobLogger.info('Sync started');
jobLogger.error('Sync failed', { error: err.message });
```

## Migration Status

### Completed
- ✅ Logger infrastructure
- ✅ Request middleware
- ✅ Error handler
- ✅ Server initialization
- ✅ All 3 queue processors
- ✅ Key controllers (webhooks, platforms)
- ✅ Started services (AI service)

### Remaining
The following files still contain `console.log` statements that can be migrated gradually:
- Various controllers (~50 console statements)
- Platform integration services (~100 console statements)
- Other services and utilities (~300 console statements)

**Note**: This is expected and intentional. The plan follows a gradual migration strategy where critical paths are converted first, and remaining console statements can be migrated over time without disrupting functionality.

## Best Practices

1. **Use appropriate log levels**:
   - `error`: Failures requiring attention
   - `warn`: Degraded state or issues
   - `info`: Business events and normal operations
   - `debug`: Diagnostic information

2. **Always log structured data**:
   ```javascript
   // Good
   logger.info('User created', { userId: user._id, email: user.email });
   
   // Avoid
   logger.info(`User ${user._id} created with email ${user.email}`);
   ```

3. **Use child loggers for context**:
   ```javascript
   const opLogger = logger.createChild({ 
     module: 'userService',
     operation: 'createUser' 
   });
   ```

4. **Log errors with full context**:
   ```javascript
   logger.error('Operation failed', {
     error: err.message,
     stack: err.stack,
     userId: user._id,
     operation: 'updateProfile'
   });
   ```

5. **Use event helpers for consistency**:
   ```javascript
   // Prefer this
   logEvents.sync.completed({ platform, orgId, count, duration });
   
   // Over this
   logger.info('Sync completed', { platform, orgId, count, duration });
   ```

## Production Deployment

### File Logging
For production, enable file logging:
```env
LOG_LEVEL=info
LOG_FORMAT=json
LOG_FILE_PATH=./logs
LOG_ROTATE_DAYS=14
```

Ensure `logs/` directory exists and is in `.gitignore`:
```bash
mkdir -p logs
echo "logs/" >> .gitignore
```

### PM2 Integration
Winston logs to stdout/stderr, which PM2 automatically captures:
```bash
pm2 start ecosystem.config.js
pm2 logs orm-api      # View logs
pm2 logs --json       # JSON format
```

### Log Aggregation
In production, pipe logs to aggregation services:
- **CloudWatch**: Use PM2 CloudWatch integration
- **ELK Stack**: Forward JSON logs to Elasticsearch
- **Datadog**: Use Datadog agent to collect PM2 logs

## Health Check

To verify logging is working:

1. Check server startup logs for Winston initialization
2. Make a test API request and verify `X-Request-Id` header
3. Check logs for structured format
4. Verify sensitive data is masked

## Next Steps (Optional)

1. **Add ESLint rule** to warn on `console.*` usage:
   ```json
   {
     "rules": {
       "no-console": "warn"
     }
   }
   ```

2. **Continue gradual migration** of remaining console statements

3. **Set up log aggregation** in production environment

4. **Create log dashboards** for monitoring key events

---

**Implementation Date**: 2026-02-13  
**Status**: ✅ Complete and Production-Ready
