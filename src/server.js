require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/database');
const { connectRedis } = require('./config/redis');
const http = require('http');
const socketIO = require('socket.io');

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  console.error(err.name, err.message);
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

// Make io accessible to routes
app.set('io', io);

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join-organization', (organizationId) => {
    socket.join(`org-${organizationId}`);
    console.log(`Socket ${socket.id} joined organization ${organizationId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Connect to MongoDB
    await connectDB();
    console.log('✅ MongoDB connected successfully');

    // Connect to Redis
    await connectRedis();
    console.log('✅ Redis connected successfully');
    
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

      console.log('🔧 Queue Concurrency Configuration:');
      console.log(`   Webhook: ${WEBHOOK_CONCURRENCY} concurrent jobs`);
      console.log(`   AI: ${AI_CONCURRENCY} concurrent jobs`);
      console.log(`   Auto-reply: ${AUTOREPLY_CONCURRENCY} concurrent jobs`);

      // Start webhook queue processor
      webhookQueue.process(WEBHOOK_CONCURRENCY, async (job) => {
        console.log(`\n📥 [Queue] Processing webhook job ${job.id}`);
        return await processWebhook(job);
      });
      console.log('✅ Webhook queue processor started');

      // Start AI queue processor
      aiQueue.process(AI_CONCURRENCY, async (job) => {
        console.log(`\n🤖 [Queue] Processing AI job ${job.id}`);
        return await processAI(job);
      });
      console.log('✅ AI queue processor started');

      // Start auto-reply queue processor
      autoReplyQueue.process(AUTOREPLY_CONCURRENCY, async (job) => {
        console.log(`\n💬 [Queue] Processing auto-reply job ${job.id}`);
        return await processAutoReply(job);
      });
      console.log('✅ Auto-reply queue processor started');
    } else {
      console.log('⚠️  Queue processors disabled (DISABLE_WORKERS=true). Workers should run separately.');
    }

    // Initialize auto-reply scheduler
    const autoReplyScheduler = require('./services/autoReplyScheduler');
    await autoReplyScheduler.initializeScheduledJobs();
    console.log('✅ Auto-reply scheduler initialized');

    // Start listening
    server.listen(PORT, () => {
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
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  server.close(() => {
    process.exit(1);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('💥 Process terminated!');
  });
});

// Start the server
startServer();

