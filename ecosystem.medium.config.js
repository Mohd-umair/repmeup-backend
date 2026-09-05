// PM2 Configuration for MEDIUM servers (2GB RAM, 2-4 CPU cores)
// Filename must end in .config.js for PM2 6+ to load the apps array.
module.exports = {
  apps: [
    {
      name: 'orm-api',
      script: './src/server.js',
      instances: 2, // 2 API processes
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        DISABLE_WORKERS: 'true'
      },
      max_memory_restart: '512M',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      node_args: '--max-old-space-size=512',
      exp_backoff_restart_delay: 100
    },
    {
      name: 'orm-worker',
      script: './src/worker.js',
      instances: 1, // 1 worker process
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production',
        WEBHOOK_CONCURRENCY: 5,
        AI_CONCURRENCY: 5,
        AUTOREPLY_CONCURRENCY: 3,
        ENABLE_CAMPAIGN_IN_CORE_WORKER: 'false',
        MONGODB_POOL_MAX: 20,
        MONGODB_POOL_MIN: 5
      },
      max_memory_restart: '512M',
      error_file: './logs/pm2-worker-error.log',
      out_file: './logs/pm2-worker-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      node_args: '--max-old-space-size=512',
      exp_backoff_restart_delay: 100
    },
    {
      name: 'orm-campaign-worker',
      script: './src/campaignWorker.js',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        CAMPAIGN_BATCH_CONCURRENCY: 20,
        CAMPAIGN_SENDS_PER_SECOND: 30,
        MONGODB_POOL_MAX: 30,
        MONGODB_POOL_MIN: 5
      },
      max_memory_restart: '512M',
      error_file: './logs/pm2-campaign-worker-error.log',
      out_file: './logs/pm2-campaign-worker-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      node_args: '--max-old-space-size=512',
      exp_backoff_restart_delay: 100
    }
  ]
};
