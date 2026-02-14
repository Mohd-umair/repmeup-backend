# Production Deployment Guide

## Overview

This guide covers deploying the ORM Backend with PM2 clustering, Redis-backed rate limiting, MongoDB connection pooling, and separate worker processes for optimal performance and scalability.

## Server Requirements

Choose the configuration based on your server size:

### Small Server (1GB RAM, 1-2 CPU cores)
- **Cost**: ~$5-10/month
- **Use**: `ecosystem.config.small.js`
- **Capacity**: ~500-1,000 msgs/hour
- **Setup**: 1 API process, no separate workers
- **Memory**: ~400MB per process

### Medium Server (2GB RAM, 2-4 CPU cores) - RECOMMENDED
- **Cost**: ~$15-25/month
- **Use**: `ecosystem.config.medium.js` or `ecosystem.config.js`
- **Capacity**: ~5,000-10,000 msgs/hour
- **Setup**: 2 API + 1 worker process
- **Memory**: ~512MB per process

### Large Server (4GB+ RAM, 4+ CPU cores)
- **Cost**: ~$40-80/month
- **Use**: `ecosystem.config.large.js`
- **Capacity**: ~15,000-25,000 msgs/hour
- **Setup**: 4 API + 2 worker processes
- **Memory**: ~1GB per process

## Prerequisites

- Node.js >= 18.0.0
- MongoDB (local or Atlas)
- Redis server
- PM2 installed globally: `npm install -g pm2`

## Environment Configuration

Ensure all required environment variables are set in `.env`:

```env
# Phase 1 - Queue Concurrency
WEBHOOK_CONCURRENCY=10
AI_CONCURRENCY=10
AUTOREPLY_CONCURRENCY=5

# Phase 2 - MongoDB Connection Pooling
MONGODB_POOL_MAX=50
MONGODB_POOL_MIN=10
DISABLE_WORKERS=true  # For production (workers run separately)

# Redis
REDIS_URL=redis://localhost:6379

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

## Development Mode

Start the server normally (includes queue processors):

```bash
npm start
# or
npm run dev
```

Access Bull Board monitoring at: `http://localhost:3000/admin/queues`

## Production Deployment

### 1. Install Dependencies

```bash
npm install --production
```

### 2. Start with PM2 (Choose Your Server Size)

```bash
# SMALL SERVER (1GB RAM)
pm2 start ecosystem.config.small.js --env production

# MEDIUM SERVER (2GB RAM) - RECOMMENDED
pm2 start ecosystem.config.medium.js --env production
# OR use default
pm2 start ecosystem.config.js --env production

# LARGE SERVER (4GB+ RAM)
pm2 start ecosystem.config.large.js --env production

# Or start individually
pm2 start ecosystem.config.js --only orm-api --env production
pm2 start ecosystem.config.js --only orm-worker --env production
```

### 3. Monitor Processes

```bash
# Real-time monitoring
pm2 monit

# View logs
pm2 logs

# View specific process logs
pm2 logs orm-api
pm2 logs orm-worker

# Process status
pm2 status

# Detailed process info
pm2 describe orm-api
pm2 describe orm-worker
```

### 4. Queue Monitoring

Access Bull Board UI: `http://your-domain.com/admin/queues`

Monitor:
- Job throughput
- Failed jobs
- Job latency
- Queue health

### 5. Process Management

```bash
# Restart all processes
pm2 restart all

# Restart specific process
pm2 restart orm-api
pm2 restart orm-worker

# Stop all processes
pm2 stop all

# Delete all processes from PM2
pm2 delete all

# Reload with zero downtime (cluster mode only)
pm2 reload orm-api
```

### 6. Save PM2 Configuration

```bash
# Save current process list
pm2 save

# Generate startup script (run on server boot)
pm2 startup
# Follow the instructions shown
```

## Architecture

### API Processes (4 instances)
- Handle HTTP requests
- Add jobs to queues
- Serve Bull Board UI
- Load balanced automatically

### Worker Processes (2 instances)
- Process webhook jobs (10 concurrent)
- Process AI jobs (10 concurrent)
- Process auto-reply jobs (5 concurrent)
- Dedicated CPU for background tasks

## Performance Expectations by Server Size

| Metric | Small (1GB) | Medium (2GB) | Large (4GB+) |
|--------|-------------|--------------|--------------|
| **Throughput** | 10-20 msgs/min | 50-100 msgs/min | 150-250 msgs/min |
| **Max load** | 500-1,000 msgs/hour | 5,000-10,000 msgs/hour | 15,000-25,000 msgs/hour |
| **Instances** | 1 API | 2 API + 1 worker | 4 API + 2 workers |
| **Concurrency** | 3-3-2 jobs/queue | 5-5-3 jobs/queue | 10-10-5 jobs/queue |
| **Memory** | ~400MB total | ~1.5GB total | ~3-4GB total |
| **Rate limiting** | Redis-backed | Redis-backed | Redis-backed |

## Scaling Recommendations

### Vertical Scaling (Same Server)
- Increase `instances` in ecosystem.config.js based on CPU cores
- Increase concurrency environment variables
- Increase MongoDB pool size

### Horizontal Scaling (Multiple Servers)
- Deploy API processes on multiple servers
- Deploy worker processes on dedicated servers
- Use shared Redis cluster
- Use MongoDB replica set

## Memory Optimization

### Monitor Memory Usage
```bash
# Check memory per process
pm2 status

# Detailed memory monitoring
pm2 monit

# Check system memory
free -h
```

### If Memory is High
1. **Switch to smaller config:**
   ```bash
   pm2 delete all
   pm2 start ecosystem.config.small.js --env production
   ```

2. **Reduce concurrency in .env:**
   ```env
   WEBHOOK_CONCURRENCY=2
   AI_CONCURRENCY=2
   AUTOREPLY_CONCURRENCY=1
   MONGODB_POOL_MAX=10
   MONGODB_POOL_MIN=3
   ```

3. **Enable log rotation:**
   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 10M
   pm2 set pm2-logrotate:retain 7
   ```

## Troubleshooting

### High Memory Usage
```bash
# Check memory per process
pm2 status

# Restart process with high memory
pm2 restart <process-name>

# Clear logs
pm2 flush
```

### Queue Backlog
```bash
# Check Bull Board UI for backlog
# Increase worker concurrency
WEBHOOK_CONCURRENCY=20
AI_CONCURRENCY=20

# Or add more worker instances
# Edit ecosystem.config.js: instances: 4
pm2 reload orm-worker
```

### Rate Limit Issues
```bash
# Check Redis connection
redis-cli ping

# Adjust rate limits in .env
RATE_LIMIT_MAX_REQUESTS=200
```

### MongoDB Connection Issues
```bash
# Check connection pool in logs
# Increase pool size if needed
MONGODB_POOL_MAX=100
```

## Rollback Plan

If issues occur:

1. **Reduce concurrency:**
   ```env
   WEBHOOK_CONCURRENCY=1
   AI_CONCURRENCY=1
   AUTOREPLY_CONCURRENCY=1
   ```

2. **Stop PM2 clustering:**
   ```bash
   pm2 stop all
   npm start
   ```

3. **Revert rate limiting:**
   - Comment out RedisStore in `src/app.js`
   - Use default in-memory rate limiting

4. **Disable separate workers:**
   - Remove `DISABLE_WORKERS=true` from .env
   - Stop worker processes: `pm2 stop orm-worker`

## Health Checks

### API Health
```bash
curl http://localhost:3000/health
```

### Redis Health
```bash
redis-cli ping
```

### MongoDB Health
```bash
mongosh --eval "db.adminCommand('ping')"
```

### PM2 Health
```bash
pm2 ping
```

## Log Files

- API logs: `./logs/pm2-out.log`, `./logs/pm2-error.log`
- Worker logs: `./logs/pm2-worker-out.log`, `./logs/pm2-worker-error.log`
- PM2 logs: `~/.pm2/logs/`

## Security Notes

- Keep `.env` file secure, never commit to version control
- Rotate JWT secrets regularly
- Use firewall to restrict Bull Board access (`/admin/queues`)
- Enable Redis password authentication in production
- Use MongoDB authentication in production

## Support

For issues or questions:
1. Check logs: `pm2 logs`
2. Check Bull Board: `/admin/queues`
3. Review this deployment guide
4. Contact DevOps team
