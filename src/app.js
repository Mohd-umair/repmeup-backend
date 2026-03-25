const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const rateLimitRedis = require('rate-limit-redis');
const RedisStore = rateLimitRedis.RedisStore || rateLimitRedis.default || rateLimitRedis;
const { getRedisClient } = require('./config/redis');
const errorHandler = require('./middlewares/errorHandler');
const { getCorsOriginList, getCorsOriginOption } = require('./config/corsOrigins');

const app = express();

// Trust proxy (required when behind nginx/reverse proxy for rate-limit and correct client IP)
app.set('trust proxy', 1);

// Security middleware: CSP, XSS, and other safe headers
const corsOrigins = getCorsOriginList();
const connectSrc = ["'self'", ...corsOrigins];
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc,
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

// CORS (comma-separated CORS_ORIGIN for main app + super admin panel, etc.)
app.use(cors({
  origin: getCorsOriginOption(),
  credentials: true
}));

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger middleware (adds req.log and requestId)
const requestLogger = require('./middlewares/requestLogger');
app.use(requestLogger);

// User activity (authenticated API calls) — non-blocking; see UserActivityLog model
const userActivityLogger = require('./middlewares/userActivityLogger');
app.use('/api', userActivityLogger);

// HTTP request logging (morgan) - disabled to reduce console noise; set LOG_HTTP=1 to enable
if (process.env.LOG_HTTP === '1') {
  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  } else {
    app.use(morgan('combined'));
  }
}

// Rate limiting - will be initialized after Redis connects
// In development: disabled by default so dashboard/inbox/analytics don't hit 429. Set RATE_LIMIT_ENABLED=true to test.
// In production: enabled. Set RATE_LIMIT_DISABLED=true to turn off (e.g. when all traffic shares one IP behind a proxy).
const rateLimitDisabled = process.env.RATE_LIMIT_DISABLED === 'true' ||
  (process.env.NODE_ENV === 'development' && process.env.RATE_LIMIT_ENABLED !== 'true');
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 minutes
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || (
  process.env.NODE_ENV === 'development' ? 10000 : 1000
);
let limiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max: rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (rateLimitDisabled) return true;
    if (req.path === '/health' || req.path.startsWith('/api/posts/media/')) return true;
    if (req.path.startsWith('/api/webhooks/')) return true;
    // Inbox avatar/attachment proxies (many small requests when loading inbox; all authenticated)
    if (req.path.includes('inbox/avatar/') || req.path.includes('inbox/attachment')) return true;
    return false;
  },
  message: { success: false, error: 'Too many requests from this IP, please try again later' },
  handler: (req, res, next, options) => {
    console.warn('[Rate limit] Too many requests', { ip: req.ip, path: req.path });
    res.status(429).json(options.message);
  }
});

// Middleware wrapper that uses the current limiter
app.use('/api/', (req, res, next) => {
  if (rateLimitDisabled) return next();
  return limiter(req, res, next);
});

if (rateLimitDisabled) {
  console.log(process.env.NODE_ENV === 'development'
    ? '⚠️  Rate limiting is DISABLED in development. Set RATE_LIMIT_ENABLED=true to test limits.'
    : '⚠️  Rate limiting is DISABLED (RATE_LIMIT_DISABLED=true). Enable it in production.');
}

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'ORM System API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// Bull Board monitoring UI
const bullBoardAdapter = require('./config/bullBoard');
app.use('/admin/queues', bullBoardAdapter.getRouter());

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/knowledge-base', require('./routes/knowledgeBase'));
app.use('/api/platforms', require('./routes/platforms'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/organizations', require('./routes/organizations'));
app.use('/api/users', require('./routes/users'));
app.use('/api/diagnostics', require('./routes/diagnostics'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/data-delete', require('./routes/dataDelete'));
app.use('/api/posts', require('./routes/postRoutes'));
app.use('/api/platform-posts', require('./routes/platformPosts'));
app.use('/api/media-library', require('./routes/mediaLibrary'));
app.use('/api/meta', require('./routes/meta'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/menus', require('./routes/menus'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/social-accounts', require('./routes/socialAccounts'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/super-admin', require('./routes/super-admin'));
app.use('/api/brand-config', require('./routes/brandConfig'));
app.use('/api/intent-buckets', require('./routes/intentBuckets'));
app.use('/api/trends', require('./routes/trends'));
app.use('/api/audit-logs', require('./routes/auditLog'));
// app.use('/api/labels', require('./routes/labels'));
// app.use('/api/templates', require('./routes/templates'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Error handler (must be last)
app.use(errorHandler);

// Function to upgrade rate limiting to Redis-backed after Redis connects
const upgradeRateLimiting = () => {
  try {
    const redisClient = getRedisClient();
    // rate-limit-redis v4 expects sendCommand; node-redis v4 uses client.sendCommand(args)
    const sendCommand = (...args) => redisClient.sendCommand(args);
    limiter = rateLimit({
      windowMs: rateLimitWindowMs,
      max: rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => {
        if (rateLimitDisabled) return true;
        if (req.path === '/health' || req.path.startsWith('/api/posts/media/')) return true;
        if (req.path.startsWith('/api/webhooks/')) return true;
        return false;
      },
      store: new RedisStore({
        sendCommand,
        prefix: 'rl:',
      }),
      message: { success: false, error: 'Too many requests from this IP, please try again later' },
      handler: (req, res, next, options) => {
        console.warn('[Rate limit] Too many requests', { ip: req.ip, path: req.path });
        res.status(429).json(options.message);
      }
    });
    console.log(`✅ Rate limiting upgraded to Redis-backed store (${rateLimitMax} req/${rateLimitWindowMs / 60000}min)${rateLimitDisabled ? ' [DISABLED by RATE_LIMIT_DISABLED]' : ''}`);
  } catch (error) {
    console.warn('⚠️  Could not upgrade to Redis-backed rate limiting, using in-memory fallback:', error.message);
  }
};

module.exports = app;
module.exports.upgradeRateLimiting = upgradeRateLimiting;

