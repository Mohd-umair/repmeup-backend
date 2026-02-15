module.exports = {
  apps: [
    {
      name: 'orm-api',
      script: './src/server.js',
      instances: 2, // Start with 2 processes (adjust based on server: 1-4)
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        DISABLE_WORKERS: 'true' // Disable queue processors in API, run separately
      },
      max_memory_restart: '512M', // Restart if memory exceeds 512MB (adjust: 256M-1G)
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      listen_timeout: 10000,
      shutdown_with_message: true,
      // Memory management
      node_args: '--max-old-space-size=512', // Limit heap to 512MB
      exp_backoff_restart_delay: 100 // Exponential backoff for restarts
    },
    {
      name: 'orm-worker',
      script: './src/worker.js',
      instances: 1, // Start with 1 worker (scale to 2-4 as needed)
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production',
        WEBHOOK_CONCURRENCY: 5,  // Reduced from 10
        AI_CONCURRENCY: 5,        // Reduced from 10
        AUTOREPLY_CONCURRENCY: 3  // Reduced from 5
      },
      max_memory_restart: '512M', // Restart if memory exceeds 512MB
      error_file: './logs/pm2-worker-error.log',
      out_file: './logs/pm2-worker-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      // Memory management
      node_args: '--max-old-space-size=512', // Limit heap to 512MB
      exp_backoff_restart_delay: 100
    }
  ]
};
