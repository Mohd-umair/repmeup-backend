require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/database');
const { connectRedis } = require('./config/redis');
const http = require('http');
const socketIO = require('socket.io');
const logger = require('./config/logger');

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! Shutting down...', {
    error: err.message,
    stack: err.stack,
    name: err.name
  });
  process.exit(1);
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
    methods: ['GET', 'POST']
  }
});

// Make io accessible to routes and share via singleton emitter
app.set('io', io);
const socketEmitter = require('./utils/socketEmitter');
socketEmitter.setIO(io);

// Socket.IO connection handler
io.on('connection', (socket) => {
  logger.debug('Socket client connected', { socketId: socket.id });

  // Frontend emits: emit('join_organization', { organizationId })
  socket.on('join_organization', (data) => {
    const orgId = typeof data === 'string' ? data : data?.organizationId;
    if (orgId) {
      socket.join(`org-${orgId}`);
      logger.debug('Socket joined organization room', { socketId: socket.id, orgId });
    }
  });

  socket.on('leave_organization', (data) => {
    const orgId = typeof data === 'string' ? data : data?.organizationId;
    if (orgId) socket.leave(`org-${orgId}`);
  });

  socket.on('disconnect', () => {
    logger.debug('Socket client disconnected', { socketId: socket.id });
  });
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Connect to MongoDB
    await connectDB();
    logger.info('MongoDB connected successfully');

    // Connect to Redis
    await connectRedis();
    logger.info('Redis connected successfully');
    
    // Upgrade rate limiting to Redis-backed after connection
    if (app.upgradeRateLimiting) {
      app.upgradeRateLimiting();
    }

    // Initialize queue processors (unless DISABLE_WORKERS is set)
    if (process.env.DISABLE_WORKERS !== 'true') {
      const { webhookQueue, aiQueue, autoReplyQueue, syncQueue } = require('./config/queue');
      const processWebhook = require('./jobs/processWebhook');
      const processAI = require('./jobs/processAI');
      const processAutoReply = require('./jobs/processAutoReply');

      // Queue concurrency from environment or defaults
      const WEBHOOK_CONCURRENCY = parseInt(process.env.WEBHOOK_CONCURRENCY) || 10;
      const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY) || 10;
      const AUTOREPLY_CONCURRENCY = parseInt(process.env.AUTOREPLY_CONCURRENCY) || 5;

      logger.info('Queue concurrency configuration', {
        webhook: WEBHOOK_CONCURRENCY,
        ai: AI_CONCURRENCY,
        autoReply: AUTOREPLY_CONCURRENCY
      });

      // Start webhook queue processor
      webhookQueue.process(WEBHOOK_CONCURRENCY, async (job) => {
        const jobLogger = logger.createChild({ module: 'webhook-queue', jobId: job.id });
        jobLogger.info('Processing webhook job');
        return await processWebhook(job);
      });
      logger.info('Webhook queue processor started');

      // Start AI queue processor
      aiQueue.process(AI_CONCURRENCY, async (job) => {
        const jobLogger = logger.createChild({ module: 'ai-queue', jobId: job.id });
        jobLogger.info('Processing AI job');
        return await processAI(job);
      });
      logger.info('AI queue processor started');

      // Start auto-reply queue processor
      autoReplyQueue.process(AUTOREPLY_CONCURRENCY, async (job) => {
        const jobLogger = logger.createChild({ module: 'autoreply-queue', jobId: job.id });
        jobLogger.info('Processing auto-reply job');
        return await processAutoReply(job);
      });
      logger.info('Auto-reply queue processor started');
    } else {
      logger.warn('Queue processors disabled (DISABLE_WORKERS=true). Workers should run separately.');
    }

    // Initialize auto-reply scheduler
    const autoReplyScheduler = require('./services/autoReplyScheduler');
    await autoReplyScheduler.initializeScheduledJobs();
    logger.info('Auto-reply scheduler initialized');

    // Start listening
    server.listen(PORT, () => {
      logger.info('ORM System API Server started', {
        environment: process.env.NODE_ENV,
        port: PORT,
        apiUrl: `http://localhost:${PORT}`,
        healthUrl: `http://localhost:${PORT}/health`,
        mongodb: 'connected',
        redis: 'connected'
      });
      
      // Pretty banner for console (only in dev)
      if (process.env.NODE_ENV === 'development') {
        console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║          🚀 ORM SYSTEM API SERVER RUNNING 🚀          ║
║                                                       ║
║  Environment: ${process.env.NODE_ENV?.toUpperCase().padEnd(37)} ║
║  Port:        ${PORT.toString().padEnd(37)} ║
║  MongoDB:     Connected ✅                            ║
║  Redis:       Connected ✅                            ║
║                                                       ║
║  API URL:     http://localhost:${PORT}                    ║
║  Health:      http://localhost:${PORT}/health             ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
      `);
      }
    });
  } catch (error) {
    logger.error('Failed to start server', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED REJECTION! Shutting down...', {
    error: err.message,
    stack: err.stack,
    name: err.name
  });
  server.close(() => {
    process.exit(1);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Process terminated');
  });
});

// Start the server
startServer();

