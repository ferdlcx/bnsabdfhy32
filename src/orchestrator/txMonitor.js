/**
 * Transaction Monitor:
 * Memantau transaksi yang baru di-broadcast ke jaringan dan mengirimkan notifikasi
 * otomatis ke Telegram pengguna begitu transaksi terkonfirmasi on-chain.
 */
class TransactionMonitor {
  constructor(options = {}) {
    this.walletService = options.walletService;
    this.intervalMs = Number(options.intervalMs || 15000);
    this.notifyCallback = options.notifyCallback || (async () => {});
    this.watchedTxs = new Map(); // txHash -> { txHash, userId, chatId, title, chainId, addedAt, attempts }
    this.activityHistory = [];
    this.timer = null;
  }

  recordActivity(entry) {
    this.activityHistory.unshift({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (this.activityHistory.length > 50) {
      this.activityHistory.length = 50;
    }
  }

  getRecentActivity(limit = 10) {
    return this.activityHistory.slice(0, limit);
  }

  watchTransaction({ txHash, orderId, userId, chatId, title, chainId = "56" }) {
    if (!txHash || txHash === "0x" + "0".repeat(64)) return;
    this.watchedTxs.set(txHash.toLowerCase(), {
      txHash,
      orderId: orderId || null,
      userId,
      chatId,
      title: title || "On-Chain Transaction",
      chainId: String(chainId),
      addedAt: Date.now(),
      attempts: 0,
    });

    if (!this.timer) {
      this.start();
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce() {
    if (this.watchedTxs.size === 0) {
      this.stop();
      return;
    }

    for (const [key, item] of this.watchedTxs.entries()) {
      item.attempts += 1;
      // Stop polling after ~10 minutes (40 attempts @ 15s)
      if (item.attempts > 40) {
        this.watchedTxs.delete(key);
        continue;
      }

      try {
        const res = await this.walletService.getTxHistory({
          txHash: item.txHash,
          chainId: item.chainId,
        });

        if (!res.ok || !res.data?.transactions) continue;
        const found = res.data.transactions.find(
          (t) => String(t.txHash).toLowerCase() === key
        );

        if (found && (found.status === "confirmed" || found.status === "failed")) {
          this.watchedTxs.delete(key);
          this.recordActivity({
            type: "TX_FINALIZED",
            title: item.title,
            txHash: item.txHash,
            status: found.status,
            chainId: item.chainId,
          });

          await this.notifyCallback(item.chatId, {
            ...item,
            finalStatus: found.status,
            txData: found,
          });
        }
      } catch {
        // Abaikan error sementara pada polling
      }
    }
  }
}

module.exports = {
  TransactionMonitor,
};
