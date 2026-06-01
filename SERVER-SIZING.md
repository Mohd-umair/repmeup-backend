# Server Sizing Guide

## Quick Start: Which Config Should I Use?

### 🟢 I have a 1GB RAM server (e.g., DigitalOcean Basic Droplet, AWS t2.micro)
```bash
pm2 start ecosystem.config.small.js --env production
```
- **Memory per process**: 400MB
- **Total memory usage**: ~400-500MB
- **Handles**: 500-1,000 messages/hour
- **Cost**: $5-10/month
- **Good for**: Testing, small businesses, low traffic

### 🔵 I have a 2GB RAM server (RECOMMENDED for most users)
```bash
pm2 start ecosystem.config.medium.js --env production
# OR
pm2 start ecosystem.config.js --env production
```
- **Memory per process**: 512MB
- **Total memory usage**: ~1.5GB (2 API + 1 core worker + 1 campaign worker)
- **Handles**: 5,000-10,000 messages/hour (interactive); campaigns scale with `orm-campaign-worker`
- **Cost**: $15-25/month
- **Good for**: Production, growing businesses, moderate traffic

### 🟣 I have a 4GB+ RAM server
```bash
pm2 start ecosystem.config.large.js --env production
```
- **Memory per process**: 1GB
- **Total memory usage**: ~3-4GB (4 API + 2 core workers + 2 campaign workers)
- **Handles**: 15,000-25,000 messages/hour (interactive); large WhatsApp blasts via dedicated campaign workers
- **Cost**: $40-80/month
- **Good for**: High traffic, enterprise, multiple clients

---

## Detailed Comparison

| Feature | Small (1GB) | Medium (2GB) | Large (4GB+) |
|---------|-------------|--------------|--------------|
| **API Processes** | 1 | 2 | 4 |
| **Worker Processes** | 0 | 1 core + 1 campaign | 2 core + 2 campaign |
| **Queue Concurrency** | 3-3-2 | 5-5-3 | 10-10-5 |
| **MongoDB Pool** | 10 (3 min) | 20 (5 min) | 50 (10 min) |
| **Memory Limit/Process** | 400MB | 512MB | 1GB |
| **Total Memory** | ~400-500MB | ~1.5GB | ~3-4GB |
| **Messages/Hour** | 500-1,000 | 5,000-10,000 | 15,000-25,000 |
| **Concurrent Jobs** | 8 total | 13 total | 25 total |
| **PM2 Mode** | fork | cluster | cluster |
| **Auto-scaling** | No | Limited | Yes |
| **Redundancy** | None | Some | High |

---

## How to Check Your Server Resources

### Check Available RAM
```bash
free -h
# Look at "available" memory
```

### Check CPU Cores
```bash
nproc
# Number of CPU cores
```

### Check Current Usage
```bash
# Overall system
htop
# or
top

# PM2 processes
pm2 monit
```

---

## Environment Variables by Size

### Small Server (.env settings)
```env
WEBHOOK_CONCURRENCY=3
AI_CONCURRENCY=3
AUTOREPLY_CONCURRENCY=2
MONGODB_POOL_MAX=10
MONGODB_POOL_MIN=3
```

### Medium Server (.env settings) - DEFAULT
```env
WEBHOOK_CONCURRENCY=5
AI_CONCURRENCY=5
AUTOREPLY_CONCURRENCY=3
MONGODB_POOL_MAX=20
MONGODB_POOL_MIN=5
```

### Large Server (.env settings)
```env
WEBHOOK_CONCURRENCY=10
AI_CONCURRENCY=10
AUTOREPLY_CONCURRENCY=5
MONGODB_POOL_MAX=50
MONGODB_POOL_MIN=10
```

---

## When to Upgrade

### Signs You Need More Resources:

1. **High Memory Usage**
   ```bash
   pm2 status
   # If memory % is consistently > 80%
   ```

2. **Queue Backlog**
   - Check Bull Board: `http://your-server/admin/queues`
   - If "waiting" jobs are growing

3. **Slow Response Times**
   - API requests taking > 2 seconds

4. **Frequent Restarts**
   ```bash
   pm2 logs
   # If you see "max_memory_restart" frequently
   ```

### Upgrade Path:

1. **Small → Medium**: Add 1GB RAM
2. **Medium → Large**: Add 2GB RAM
3. **Large → Distributed**: Multiple servers with load balancer

---

## Cost Optimization Tips

### If You're on a Budget:

1. **Start Small**
   - Use `ecosystem.config.small.js`
   - Monitor with `pm2 monit`
   - Upgrade only when needed

2. **Use Managed Services**
   - MongoDB Atlas (free tier: 512MB)
   - Redis Cloud (free tier: 30MB)
   - Saves memory on your server

3. **Enable Log Rotation**
   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 10M
   pm2 set pm2-logrotate:retain 3
   ```

4. **Reduce Logging**
   ```env
   LOG_LEVEL=error  # Instead of debug
   ```

5. **Clean Old Jobs**
   - Bull automatically removes completed/failed jobs
   - Check `removeOnComplete: 50` in queue.js

---

## Testing Your Configuration

### 1. Start with Small Config
```bash
pm2 start ecosystem.config.small.js --env production
pm2 monit
```

### 2. Monitor for 24 Hours
- Watch memory usage
- Check queue backlog
- Monitor response times

### 3. Upgrade if Needed
```bash
pm2 delete all
pm2 start ecosystem.config.medium.js --env production
```

---

## Memory Safety Features

All configs include:

✅ **max_memory_restart** - Auto-restart if memory exceeds limit
✅ **node_args --max-old-space-size** - Hard memory cap
✅ **exp_backoff_restart_delay** - Prevents restart loops
✅ **Queue cleanup** - Auto-removes old jobs
✅ **Connection pooling** - Reuses DB connections

---

## Support

**Not sure which to use?**
- Start with **Medium config** (works for 90% of cases)
- Monitor for a week
- Scale up/down as needed

**Having memory issues?**
1. Check `pm2 monit`
2. Review logs: `pm2 logs`
3. Try smaller config or reduce concurrency
4. Consider managed Redis/MongoDB to offload memory
