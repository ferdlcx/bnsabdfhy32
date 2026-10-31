module.exports = {
  apps: [
    {
      name: "baw-automation-engine",
      script: "./mint_bot.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
