const crypto = require("node:crypto");

/**
 * Kontrak bawaan yang telah terverifikasi dan masuk dalam allowlist awal (BSC Chain 56).
 */
const DEFAULT_ALLOWED_CONTRACTS = new Map([
  [
    "0x55d398326f99059ff775485246999027b3197955",
    { name: "BSC-USD (USDT)", chainId: "56", type: "token" },
  ],
  [
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    { name: "USD Coin (USDC)", chainId: "56", type: "token" },
  ],
  [
    "0x045398ef956b4787c782f77319ab0a20cb637da0",
    { name: "MOCHI Mint Contract", chainId: "56", type: "mint" },
  ],
  [
    "0x0eb18ea6bd86f994fec4f3580b5206f972433364",
    { name: "MOCHI Token", chainId: "56", type: "token" },
  ],
]);

class TransactionGuard {
  constructor(options = {}) {
    this.maxTxSpendUsd = Number(options.maxTxSpendUsd ?? 15);
    this.maxDailySpendUsd = Number(options.maxDailySpendUsd ?? 50);
    this.confirmationTtlSeconds = Number(options.confirmationTtlSeconds ?? 300);
    this.allowedChains = new Set(
      (options.allowedChains || ["56", "1", "8453", "42161", "137", "CT_501", "4663"]).map(String)
    );
    this.allowedContracts = new Map(DEFAULT_ALLOWED_CONTRACTS);
    this.pendingTxs = new Map();
    this.dailySpendByDate = new Map();
  }

  /**
   * Mendaftarkan kontrak dari Skill yang sudah tervalidasi ke dalam allowlist.
   */
  allowContract(address, metadata = {}) {
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error(`Alamat kontrak tidak valid untuk allowlist: ${address}`);
    }
    this.allowedContracts.set(address.toLowerCase(), {
      name: metadata.name || "Validated Skill Contract",
      chainId: String(metadata.chainId || "56"),
      type: metadata.type || "contract",
    });
  }

  isContractAllowed(address, chainId = "56") {
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return false;
    const entry = this.allowedContracts.get(address.toLowerCase());
    if (!entry) return false;
    return String(entry.chainId) === String(chainId);
  }

  getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  getDailySpentUsd() {
    return this.dailySpendByDate.get(this.getTodayKey()) || 0;
  }

  recordSpendUsd(amountUsd) {
    const val = Number(amountUsd || 0);
    if (val <= 0) return;
    const key = this.getTodayKey();
    this.dailySpendByDate.set(key, this.getDailySpentUsd() + val);
  }

  /**
   * Memvalidasi parameter transaksi sebelum dibuatkan preview / approval.
   */
  validateTransactionParams({
    chainId = "56",
    walletAddress,
    to,
    inputData = "0x",
    valueWei = "0",
    estimatedSpendUsd = 0,
    requireAllowlist = true,
  }) {
    if (!this.allowedChains.has(String(chainId))) {
      throw new Error(`Chain ID "${chainId}" tidak termasuk dalam daftar chain yang didukung.`);
    }

    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      throw new Error("Alamat wallet pengirim (from) tidak valid.");
    }

    if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) {
      throw new Error("Alamat kontrak tujuan (to) tidak valid.");
    }

    if (to.toLowerCase() === "0x0000000000000000000000000000000000000000") {
      throw new Error("Transaksi ke zero address (0x000...000) dilarang.");
    }

    if (requireAllowlist && !this.isContractAllowed(to, chainId)) {
      throw new Error(
        `Kontrak tujuan ${to} belum masuk dalam Contract Allowlist pada chain ${chainId}. Import & validasi skill terlebih dahulu.`
      );
    }

    if (typeof inputData !== "string" || !/^0x([a-fA-F0-9]{2})*$/.test(inputData)) {
      throw new Error("Calldata (inputData) harus berupa string heksadesimal genap yang diawali 0x.");
    }

    if (!/^\d+$/.test(String(valueWei))) {
      throw new Error("Parameter valueWei harus berupa bilangan bulat non-negatif dalam satuan wei.");
    }

    const spend = Number(estimatedSpendUsd || 0);
    if (spend > this.maxTxSpendUsd) {
      throw new Error(
        `Estimasi biaya transaksi ($${spend.toFixed(2)}) melebihi batas per transaksi ($${this.maxTxSpendUsd.toFixed(2)}).`
      );
    }

    if (this.getDailySpentUsd() + spend > this.maxDailySpendUsd) {
      throw new Error(
        `Estimasi biaya transaksi ($${spend.toFixed(2)}) akan melampaui batas pengeluaran harian lokal ($${this.maxDailySpendUsd.toFixed(2)}).`
      );
    }

    return true;
  }

  /**
   * Menghitung hash integritas yang mengikat seluruh parameter transaksi.
   */
  computeIntegrityHash(payload) {
    const canonical = JSON.stringify({
      txId: payload.txId,
      userId: payload.userId,
      walletAddress: String(payload.walletAddress).toLowerCase(),
      chainId: String(payload.chainId),
      steps: (payload.steps || []).map((s) => ({
        to: String(s.to).toLowerCase(),
        inputData: String(s.inputData).toLowerCase(),
        valueWei: String(s.valueWei || "0"),
        requestId: String(s.requestId || ""),
      })),
      estimatedSpendUsd: Number(payload.estimatedSpendUsd || 0),
      expiresAt: payload.expiresAt,
    });
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Membuat antrean transaksi pending yang membutuhkan konfirmasi eksplisit (/confirm <id>).
   */
  createPendingTransaction({
    userId,
    project,
    title,
    walletAddress,
    chainId = "56",
    steps = [],
    estimatedSpendUsd = 0,
    summary = {},
    requireAllowlist = true,
  }) {
    this.cleanupExpired();

    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("Transaksi harus memiliki minimal 1 langkah eksekusi.");
    }

    for (const step of steps) {
      this.validateTransactionParams({
        chainId,
        walletAddress,
        to: step.to,
        inputData: step.inputData,
        valueWei: step.valueWei || "0",
        estimatedSpendUsd,
        requireAllowlist,
      });
    }

    const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
    const txId = `TX-${randomHex}`;
    const now = Date.now();
    const expiresAt = now + this.confirmationTtlSeconds * 1000;

    const record = {
      txId,
      userId: Number(userId),
      project: project || "custom",
      title: title || "On-Chain Transaction",
      walletAddress,
      chainId: String(chainId),
      steps,
      estimatedSpendUsd: Number(estimatedSpendUsd || 0),
      summary,
      status: "PENDING_APPROVAL",
      createdAt: now,
      expiresAt,
    };

    record.integrityHash = this.computeIntegrityHash(record);
    this.pendingTxs.set(txId, record);
    return record;
  }

  /**
   * Mengambil daftar transaksi pending milik user yang belum kedaluwarsa.
   */
  listPendingForUser(userId) {
    this.cleanupExpired();
    const list = [];
    for (const tx of this.pendingTxs.values()) {
      if (tx.userId === Number(userId) && tx.status === "PENDING_APPROVAL") {
        list.push(tx);
      }
    }
    return list;
  }

  /**
   * Mengonfirmasi dan mengunci transaksi agar tidak bisa di-replay.
   */
  consumeForExecution(txId, userId) {
    this.cleanupExpired();
    const cleanId = String(txId || "").trim().toUpperCase();
    const record = this.pendingTxs.get(cleanId);

    if (!record) {
      throw new Error(`Transaksi "${cleanId}" tidak ditemukan atau sudah kedaluwarsa.`);
    }

    if (record.userId !== Number(userId)) {
      throw new Error("Anda tidak memiliki akses untuk mengonfirmasi transaksi ini.");
    }

    if (record.status !== "PENDING_APPROVAL") {
      throw new Error(`Transaksi "${cleanId}" sudah berstatus ${record.status} dan tidak dapat digunakan ulang.`);
    }

    if (Date.now() > record.expiresAt) {
      this.pendingTxs.delete(cleanId);
      throw new Error(`Batas waktu persetujuan transaksi "${cleanId}" telah habis. Silakan ulangi preview.`);
    }

    const expectedHash = this.computeIntegrityHash(record);
    if (expectedHash !== record.integrityHash) {
      this.pendingTxs.delete(cleanId);
      throw new Error("Integritas parameter transaksi berubah! Eksekusi dibatalkan demi keamanan.");
    }

    // One-time use (Replay Protection)
    record.status = "EXECUTING";
    this.pendingTxs.delete(cleanId);
    return record;
  }

  cancelPending(txId, userId) {
    this.cleanupExpired();
    if (!txId) {
      // Batalkan semua milik user tersebut
      let count = 0;
      for (const [id, rec] of this.pendingTxs.entries()) {
        if (rec.userId === Number(userId)) {
          this.pendingTxs.delete(id);
          count++;
        }
      }
      return count;
    }

    const cleanId = String(txId).trim().toUpperCase();
    const record = this.pendingTxs.get(cleanId);
    if (!record || record.userId !== Number(userId)) {
      return 0;
    }
    this.pendingTxs.delete(cleanId);
    return 1;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [id, rec] of this.pendingTxs.entries()) {
      if (now > rec.expiresAt) {
        this.pendingTxs.delete(id);
      }
    }
  }
}

module.exports = {
  TransactionGuard,
  DEFAULT_ALLOWED_CONTRACTS,
};
