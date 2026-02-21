const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { getRedisClient } = require('./config/redis');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

// Trust proxy (required when behind nginx/reverse proxy for rate-limit and correct client IP)
app.set('trust proxy', 1);

// Security middleware: CSP, XSS, and other safe headers
const frontendOrigin = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:4200';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", frontendOrigin],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  credentials: true
}));

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger middleware (adds req.log and requestId)
const requestLogger = require('./middlewares/requestLogger');
app.use(requestLogger);

// Logging middleware (HTTP format logging)
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Rate limiting - will be initialized after Redis connects
// For now, use in-memory rate limiting as fallback
let limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000, // Increased from 100 to 1000
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health check and media serving
    // Media endpoints need to be accessible by Instagram/Facebook/LinkedIn without rate limits
    return req.path === '/health' || req.path.startsWith('/api/posts/media/');
  },
  message: { success: false, error: 'Too many requests from this IP, please try again later' }
});

// Middleware wrapper that uses the current limiter
app.use('/api/', (req, res, next) => limiter(req, res, next));

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
app.use('/api/media-library', require('./routes/mediaLibrary'));
app.use('/api/meta', require('./routes/meta'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/menus', require('./routes/menus'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/social-accounts', require('./routes/socialAccounts'));
app.use('/api/plans', require('./routes/plans'));
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
    limiter = rateLimit({
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
      max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000, // Increased from 100 to 1000
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => {
        // Skip rate limiting for health check
        return req.path === '/health';
      },
      store: new RedisStore({
        // @ts-expect-error - rate-limit-redis expects Redis v4 client
        client: redisClient,
        prefix: 'rl:',
      }),
      message: { success: false, error: 'Too many requests from this IP, please try again later' }
    });
    console.log('✅ Rate limiting upgraded to Redis-backed store (1000 req/15min)');
  } catch (error) {
    console.warn('⚠️  Could not upgrade to Redis-backed rate limiting, using in-memory fallback:', error.message);
  }
};

module.exports = app;
module.exports.upgradeRateLimiting = upgradeRateLimiting;

