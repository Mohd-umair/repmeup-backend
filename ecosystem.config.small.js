// PM2 Configuration for SMALL servers (1GB RAM, 1-2 CPU cores)
module.exports = {
  apps: [
    {
      name: 'orm-api',
      script: './src/server.js',
      instances: 1, // Single API instance
      exec_mode: 'fork', // Fork mode for single instance
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        WEBHOOK_CONCURRENCY: 3,
        AI_CONCURRENCY: 3,
        AUTOREPLY_CONCURRENCY: 2,
        MONGODB_POOL_MAX: 10,
        MONGODB_POOL_MIN: 3
      },
      max_memory_restart: '400M',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      node_args: '--max-old-space-size=400',
      exp_backoff_restart_delay: 100
    }
  ]
};
