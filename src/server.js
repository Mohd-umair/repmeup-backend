require('dotenv').config();
const app = require('./app');
const { getCorsOriginOption } = require('./config/corsOrigins');
const connectDB = require('./config/database');
const { connectRedis } = require('./config/redis');
const http = require('http');
const socketIO = require('socket.io');
const logger = require('./config/logger');

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

// Attach the Voice IVR WebSocket gateway at /voice/stream (Twilio Media Streams)
const voiceGatewayService = require('./services/voiceGatewayService');
voiceGatewayService.attach(server);

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: getCorsOriginOption(),
    methods: ['GET', 'POST'],
    credentials: true
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

    // Queue processors are intentionally NOT started here.
    // Run worker.js as a separate PM2 process to handle all queue jobs.
    // This prevents double-processing when both server.js and worker.js are running.
    logger.info('Queue processors not started in server process — run worker.js separately.');

    // Seed global flow blueprints (idempotent upsert — safe to run on every boot)
    try {
      const { seedGlobalBlueprints } = require('./scripts/seedCheckoutBlueprint');
      await seedGlobalBlueprints();
      logger.info('Flow blueprints seeded');
    } catch (seedErr) {
      logger.warn('Blueprint seeding failed (non-fatal):', seedErr.message);
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

