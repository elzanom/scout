// PM2 process config for laminar-scout.
// Single app: src/index.js runs the cron orchestrator AND the in-process Helius webhook
// receiver. To isolate the webhook into its own process, split startWebhookServer() out of
// index.js and add a second app here pointing at src/collector/helius-stream.js.
module.exports = {
  apps: [
    {
      name: "laminar-scout",
      script: "src/index.js",
      cwd: __dirname,
      env_file: ".env",
      watch: false,
      autorestart: true,
      max_memory_restart: "512M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
