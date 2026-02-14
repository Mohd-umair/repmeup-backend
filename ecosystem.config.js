module.exports = {
  apps: [
    {
      name: 'orm-api',
      script: './src/server.js',
      instances: 4, // 4 Node processes (adjust based on CPU cores)
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
      max_memory_restart: '1G',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      listen_timeout: 10000,
      shutdown_with_message: true
    },
    {
      name: 'orm-worker',
      script: './src/worker.js',
      instances: 2, // 2 worker processes
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production',
        WEBHOOK_CONCURRENCY: 10,
        AI_CONCURRENCY: 10,
        AUTOREPLY_CONCURRENCY: 5
      },
      max_memory_restart: '1G',
      error_file: './logs/pm2-worker-error.log',
      out_file: './logs/pm2-worker-out.log',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000
    }
  ]
};
