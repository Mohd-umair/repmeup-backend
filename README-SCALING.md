# Backend Scaling - Quick Reference

## 🚀 Quick Start Commands

### Development
```bash
npm start  # Single process with all features
```

### Production - Choose Your Server Size

```bash
# Small Server (1GB RAM) - $5-10/month
npm run pm2:small

# Medium Server (2GB RAM) - RECOMMENDED
npm run pm2:medium

# Large Server (4GB+ RAM) - High Traffic
npm run pm2:large
```

### Monitor & Manage
```bash
npm run pm2:monitor  # Real-time monitoring
npm run pm2:logs     # View logs
npm run pm2:restart  # Restart all processes
npm run pm2:stop     # Stop all processes
npm run pm2:delete   # Remove all processes
```

---

## 📊 Memory Optimization Summary

### What We Did:
1. ✅ **Reduced default concurrency** from 10-10-5 to 5-5-3
2. ✅ **Reduced MongoDB pool** from 50 to 20 connections
3. ✅ **Added memory limits** - 512MB per process (down from 1GB)
4. ✅ **Added heap limits** - `--max-old-space-size=512`
5. ✅ **Reduced job retention** - 50 completed, 100 failed (down from 100/500)
6. ✅ **Created 3 configs** for different server sizes
7. ✅ **Added queue rate limiting** - max 100 jobs/second
8. ✅ **Optimized queue settings** - stalled job detection, lock renewal

### Memory Footprint:
- **Before**: ~1-2GB per process
- **After (Medium)**: ~512MB per process
- **After (Small)**: ~400MB per process

### Throughput:
- **Small**: 500-1,000 msgs/hour
- **Medium**: 5,000-10,000 msgs/hour
- **Large**: 15,000-25,000 msgs/hour

---

## 🔧 Configuration Files

| File | Server Size | RAM | Processes | Use Case |
|------|-------------|-----|-----------|----------|
| `ecosystem.small.config.js` | 1GB | 1GB | 1 API | Testing, Low traffic |
| `ecosystem.medium.config.js` | 2GB | 2GB | 2 API + 1 Worker | **RECOMMENDED** |
| `ecosystem.config.js` | 2GB | 2GB | 2 API + 1 Worker | Default (same as medium) |
| `ecosystem.large.config.js` | 4GB+ | 4GB+ | 4 API + 2 Workers | High traffic |

---

## 📈 Monitoring

### Check Memory Usage
```bash
pm2 status          # Quick overview
pm2 monit           # Real-time monitoring
free -h             # System memory
```

### Check Queue Health
- Open browser: `http://your-server:3000/admin/queues`
- Monitor waiting jobs, completed, failed
- Check job throughput

### Check Logs
```bash
pm2 logs                 # All logs
pm2 logs orm-api         # API logs only
pm2 logs orm-worker      # Worker logs only
pm2 logs --lines 100     # Last 100 lines
```

---

## ⚙️ Fine-Tuning

### If Memory is Still High

1. **Reduce concurrency further** (in `.env`):
   ```env
   WEBHOOK_CONCURRENCY=2
   AI_CONCURRENCY=2
   AUTOREPLY_CONCURRENCY=1
   ```

2. **Reduce MongoDB pool**:
   ```env
   MONGODB_POOL_MAX=10
   MONGODB_POOL_MIN=3
   ```

3. **Use fork mode instead of cluster**:
   - Edit your ecosystem config
   - Change `exec_mode: 'cluster'` to `exec_mode: 'fork'`
   - Reduce `instances` to 1

4. **Enable log rotation**:
   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 10M
   pm2 set pm2-logrotate:retain 3
   ```

### If You Need More Throughput

1. **Increase concurrency** (in `.env`):
   ```env
   WEBHOOK_CONCURRENCY=10
   AI_CONCURRENCY=10
   AUTOREPLY_CONCURRENCY=5
   ```

2. **Add more worker instances**:
   - Edit ecosystem config
   - Increase `instances: 2` for orm-worker

3. **Upgrade to larger config**:
   ```bash
   pm2 delete all
   npm run pm2:large
   ```

---

## 🛡️ Safety Features

All configs include:

- ✅ **Auto-restart on memory limit** - Prevents OOM crashes
- ✅ **Auto-restart on failure** - Max 10 restarts with exponential backoff
- ✅ **Graceful shutdown** - 5s to finish current requests
- ✅ **Job cleanup** - Auto-removes old completed/failed jobs
- ✅ **Stalled job detection** - Retries stuck jobs after 30s
- ✅ **Redis-backed rate limiting** - Shared across all instances

---

## 📚 Read More

- `SERVER-SIZING.md` - Detailed server sizing guide
- `DEPLOYMENT.md` - Full deployment documentation
- `.env` - Environment variables reference

---

## 🆘 Troubleshooting

### Server keeps restarting
```bash
pm2 logs  # Check error logs
# Common causes:
# - Memory limit too low (increase max_memory_restart)
# - Database connection failed
# - Redis connection failed
```

### High memory usage
```bash
pm2 monit  # Watch memory in real-time
# Solutions:
# - Switch to smaller config
# - Reduce concurrency
# - Enable log rotation
```

### Queue backlog growing
```bash
# Check Bull Board: http://your-server:3000/admin/queues
# Solutions:
# - Increase worker instances
# - Increase concurrency
# - Add more server resources
```

### "Too many connections" error
```bash
# Reduce MongoDB pool in .env:
MONGODB_POOL_MAX=10
MONGODB_POOL_MIN=3
```

---

## 💡 Best Practices

1. **Start conservative** - Use medium or small config first
2. **Monitor for 24-48 hours** before scaling
3. **Use managed services** - MongoDB Atlas, Redis Cloud to save memory
4. **Enable log rotation** - Prevent disk space issues
5. **Set up alerts** - PM2 plus monitoring for production
6. **Test locally** - Use `npm start` for development
7. **Gradual scaling** - Don't jump from small to large immediately

---

**Need help?** Check the logs first: `pm2 logs`
