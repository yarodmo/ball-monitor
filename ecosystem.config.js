module.exports = {
  apps: [
    {
      name: "ball-monitor",
      script: "./src/monitor.js",
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      // Error handling
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // Security: use .env file
      env_file: ".env"
    }
  ]
};
