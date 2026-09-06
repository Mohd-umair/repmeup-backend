const crypto = require('crypto');
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

// Razorpay webhook — MUST be registered before express.json() to receive raw Buffer for HMAC verification
app.use('/api/razorpay', require('./routes/razorpay'));

// Razorpay commerce payment webhook (per-org payment events) — raw body required
app.use('/api/webhooks/payments/razorpay', require('./routes/paymentWebhookRazorpay'));

// Body parser — capture raw JSON for Meta WhatsApp webhook signature (HMAC over exact bytes)
// Also capture for product-payment and org payment gateway webhooks
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      const path = req.originalUrl || req.url || '';
      // Mounted at /api/webhooks/whatsapp and /api/v1/webhooks/whatsapp
      if (path.includes('/webhooks/whatsapp')) {
        req.rawBody = buf;
      }
      // Product payment legacy webhook and new per-org gateway webhooks
      if (path.includes('/webhooks/product-payment') || path.includes('/webhooks/payments/')) {
        req.rawBody = buf;
      }
      // Shopify webhooks — HMAC verified over raw body
      if (path.includes('/webhooks/shopify')) {
        req.rawBody = buf;
      }
    }
  })
);
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
    // req.path inside app.use('/api/', ...) is RELATIVE to the /api/ mount point,
    // so it starts with /posts/media/ not /api/posts/media/.
    if (req.path === '/health' || req.path.startsWith('/posts/media/')) return true;
    if (req.path.startsWith('/webhooks/')) return true;
    // Voice IVR webhooks (Twilio retries aggressively; rate-limiting here would break calls)
    if (req.path.startsWith('/voice/webhooks/')) return true;
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
app.get('/health', async (req, res) => {
  const payload = {
    success: true,
    message: 'ORM System API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    workers: {
      campaignInCoreWorker: process.env.ENABLE_CAMPAIGN_IN_CORE_WORKER !== 'false',
      dedicatedCampaignWorkerRecommended: process.env.NODE_ENV === 'production'
    }
  };

  if (req.query.campaignMetrics === '1') {
    try {
      const campaignMetrics = require('./services/campaignMetricsService');
      payload.campaignMetrics = await campaignMetrics.getSnapshot();
    } catch {
      payload.campaignMetrics = { error: 'metrics_unavailable' };
    }
  }

  res.status(200).json(payload);
});

// Bull Board monitoring UI — MUST be authenticated. It exposes raw job
// payloads (webhook bodies, access tokens, PII) and allows retry/delete/purge.
// Guarded with HTTP Basic Auth (browser-friendly) using dedicated credentials.
const bullBoardAdapter = require('./config/bullBoard');
const bullBoardAuth = (req, res, next) => {
  const user = process.env.BULL_BOARD_USER;
  const pass = process.env.BULL_BOARD_PASSWORD;

  // Fail closed: if no credentials are configured, the dashboard is disabled
  // rather than served openly.
  if (!user || !pass) {
    return res.status(404).json({ success: false, error: 'Route not found' });
  }

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const providedUser = decoded.slice(0, idx);
    const providedPass = decoded.slice(idx + 1);

    // Constant-time compare to avoid credential timing leaks.
    const expected = `${user}:${pass}`;
    const got = `${providedUser}:${providedPass}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Queue Dashboard"');
  return res.status(401).json({ success: false, error: 'Authentication required' });
};
app.use('/admin/queues', bullBoardAuth, bullBoardAdapter.getRouter());

// ── Route definitions ─────────────────────────────────────────────────────────
// Each route module is loaded once and mounted at BOTH the legacy /api/ prefix
// AND the versioned /api/v1/ prefix.  Existing clients continue to work;
// new integrations should use /api/v1/.
const routeMap = [
  ['/public',         './routes/public'],
  ['/public/growth-audit', './routes/growthAudit'],
  ['/growth-intelligence', './routes/growthIntelligence'],
  ['/contact',        './routes/contact'],
  ['/demo',           './routes/demo'],
  ['/auth',           './routes/auth'],
  ['/inbox',          './routes/inbox'],
  ['/knowledge-base', './routes/knowledgeBase'],
  ['/platforms',      './routes/platforms'],
  ['/webhooks',       './routes/webhooks'],
  ['/organizations',  './routes/organizations'],
  ['/users',          './routes/users'],
  ['/diagnostics',    './routes/diagnostics'],
  ['/analytics',      './routes/analytics'],
  ['/data-delete',    './routes/dataDelete'],
  ['/posts',          './routes/postRoutes'],
  ['/platform-posts', './routes/platformPosts'],
  ['/media-library',  './routes/mediaLibrary'],
  ['/meta',           './routes/meta'],
  ['/notifications',  './routes/notifications'],
  ['/menus',          './routes/menus'],
  ['/subscription',   './routes/subscription'],
  ['/addons',         './routes/addons'],
  ['/social-accounts','./routes/socialAccounts'],
  ['/plans',          './routes/plans'],
  ['/super-admin',    './routes/super-admin'],
  ['/entitlements',   './routes/entitlements'],
  ['/brand-config',   './routes/brandConfig'],
  ['/content-studio', './routes/contentStudioInput'],
  ['/inspirations',   './routes/inspirations'],
  ['/event-templates','./routes/eventTemplates'],
  ['/post-templates', './routes/postTemplates'],
  ['/intent-buckets', './routes/intentBuckets'],
  ['/products',       './routes/products'],
  ['/trends',         './routes/trends'],
  ['/audit-logs',     './routes/auditLog'],
  ['/tickets',        './routes/tickets'],
  ['/contacts',             './routes/contacts'],
  ['/activation',           './routes/activation'],
  ['/email',                './routes/emailAccounts'],
  ['/whatsapp-templates',   './routes/whatsappTemplates'],
  ['/whatsapp-catalog',     './routes/whatsappCatalog'],
  ['/voice',                './routes/voiceIvr'],
  ['/automation',           './routes/automation'],
  ['/retargeting',          './routes/retargeting'],
  ['/whatsapp-flows',       './routes/whatsappFlows'],
  ['/whatsapp-form-flows',  './routes/whatsappFormFlows'],
  ['/campaigns',            './routes/campaigns'],
  ['/reports/number',       './routes/numberReports'],
  ['/commerce-orders',      './routes/commerceOrders'],
  ['/appointments',         './routes/appointments'],
  ['/payment-gateways',     './routes/paymentGateways'],
  ['/payments',             './routes/payments'],
  ['/payment-analytics',   './routes/paymentAnalytics'],
  // ['/labels',      './routes/labels'],
  // ['/templates',   './routes/templates'],
];

// Mount at both /api (legacy compat) and /api/v1 (canonical versioned path)
for (const [path, routeFile] of routeMap) {
  const router = require(routeFile);
  app.use(`/api${path}`, router);
  app.use(`/api/v1${path}`, router);
}

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
        if (req.path === '/health' || req.path.startsWith('/posts/media/')) return true;
        if (req.path.startsWith('/webhooks/')) return true;
        if (req.path.startsWith('/voice/webhooks/')) return true;
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

