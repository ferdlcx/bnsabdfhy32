#!/usr/bin/env bash
# ============================================================================
# Provisioning Script untuk Cloud VPS Ubuntu 22.04 / 24.04 (< $5/bulan)
# Menjalankan Universal Binance Agentic Wallet Automation Engine 24/7 via PM2
# ============================================================================
set -euo pipefail

echo "🚀 [1/5] Memperbarui paket sistem..."
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl git ufw ca-certificates

echo "🛡️ [2/5] Mengonfigurasi Firewall UFW (Hanya membuka SSH, karena Telegram memakai Long Polling)..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable

echo "📦 [3/5] Menginstal Node.js LTS (v22)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "🔧 [4/5] Menginstal Binance Agentic Wallet CLI (@binance/agentic-wallet) & PM2..."
sudo npm install -g @binance/agentic-wallet pm2

echo "📂 [5/5] Menginstal dependency project..."
npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "⚠️ File .env telah dibuat dari .env.example. Silakan isi TELEGRAM_BOT_TOKEN dan TELEGRAM_ALLOWED_USER_IDS terlebih dahulu:"
  echo "   nano .env"
else
  chmod 600 .env
  pm2 start deploy/ecosystem.config.cjs
  pm2 save
  echo "✅ Bot telah berjalan di background via PM2! Gunakan 'pm2 logs baw-automation-engine' untuk memantau."
fi
