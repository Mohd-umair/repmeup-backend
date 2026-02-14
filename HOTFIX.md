# 🔥 HOTFIX: Rate Limiting & Queue Stalling Issues

## Issues Found:

1. ✅ **429 Errors** - Rate limiting was too aggressive (100 req/15min)
2. ✅ **Job Stalling** - Queue jobs timing out too quickly (30s locks)

## Fixes Applied:

### 1. Increased Rate Limits
- **Before**: 100 requests per 15 minutes
- **After**: 1000 requests per 15 minutes
- **Why**: Single user with active UI can easily make 100+ requests in 15 minutes

### 2. Increased Job Lock Durations
- **Lock Duration**: 30s → 120s (auto-reply jobs need more time)
- **Lock Renew**: 15s → 60s
- **Stall Check**: 30s → 60s
- **Why**: AI processing and auto-reply generation can take 30-60 seconds

### 3. Skip Health Check from Rate Limiting
- Health checks now bypass rate limiting
- Prevents monitoring/uptime services from being blocked

## Deploy the Fix:

### On Your Live Server:

```bash
# 1. Stop the server
pm2 stop all

# 2. Pull the latest changes (or copy the updated files)
# Updated files:
#   - src/app.js
#   - src/config/queue.js  
#   - .env

# 3. Update .env if needed
nano .env
# Change: RATE_LIMIT_MAX_REQUESTS=1000

# 4. Restart
pm2 restart all

# 5. Monitor logs
pm2 logs --lines 50

# 6. Clear rate limit data in Redis (if needed)
redis-cli
> KEYS rl:*
> DEL rl:*  # Delete all rate limit keys
> exit
```

### Quick Test:

```bash
# Should return 200 OK
curl -i http://localhost:3000/health

# Should NOT get 429
curl -i http://localhost:3000/api/inbox
```

## Monitor for Success:

### Good Signs:
- ✅ No more 429 errors in logs
- ✅ Jobs completing instead of stalling
- ✅ API responding normally

### Bad Signs:
- ❌ Still seeing 429 errors → Increase `RATE_LIMIT_MAX_REQUESTS` more
- ❌ Jobs still stalling → Increase `lockDuration` in queue.js
- ❌ High CPU/memory → Reduce concurrency in .env

## Rollback Plan:

If issues persist:

```bash
# Disable rate limiting entirely (temporary)
# In src/app.js, comment out:
# app.use('/api/', (req, res, next) => limiter(req, res, next));

# Or set very high limit
RATE_LIMIT_MAX_REQUESTS=10000
```

## Long-term Recommendations:

1. **Monitor with Bull Board**: http://your-server:3000/admin/queues
2. **Set up proper rate limits per user** (not per IP)
3. **Consider job timeouts per job type**:
   - Webhook: 30s
   - AI: 120s
   - Auto-reply: 120s
4. **Add Redis memory monitoring**
5. **Set up PM2 monitoring**: `pm2 plus` or custom monitoring

## Configuration Reference:

### Rate Limits by Use Case:

| Use Case | Requests/15min | Good For |
|----------|----------------|----------|
| 100 | Very restrictive | Public API with abuse concerns |
| 1000 | Moderate | **Normal production (CURRENT)** |
| 5000 | Relaxed | High-traffic apps |
| 10000+ | Very relaxed | Internal/trusted clients |

### Queue Lock Durations:

| Job Type | Recommended Lock | Current |
|----------|------------------|---------|
| Webhook Processing | 60s | 120s ✅ |
| AI Analysis | 120s | 120s ✅ |
| Auto-reply | 120s | 120s ✅ |
| Sync | 60s | 120s ✅ |

## Testing Checklist:

- [ ] APIs respond with 200 (not 429)
- [ ] Jobs complete successfully
- [ ] No "stalled" errors in logs
- [ ] Memory usage stable
- [ ] CPU usage normal
- [ ] Bull Board shows healthy queues

## Support:

If you still see issues after applying this fix:

1. Check `pm2 logs` for errors
2. Check Bull Board for queue status
3. Check Redis: `redis-cli INFO stats`
4. Reduce concurrency in .env if needed
