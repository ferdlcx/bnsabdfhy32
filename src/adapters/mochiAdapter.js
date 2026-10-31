const { bscRpcCall } = require("../wallet/bscScanner");

const MOCHI_CONSTANTS = {
  PROJECT_NAME: "MOCHI",
  WEBSITE_URL: "https://agenticmochi.xyz",
  SKILL_URL: "https://agenticmochi.xyz/skill.md",
  STATS_URL: "https://agenticmochi.xyz/api/stats",
  VERIFY_URL: "https://agenticmochi.xyz/api/verify",
  QUOTE_URL: "https://agenticmochi.xyz/api/quote",
  ACTIVITY_URL: "https://agenticmochi.xyz/api/activity",
  CHAIN_ID: "56",
  MINT_CONTRACT: "0x045398ef956b4787c782f77319ab0a20cb637da0",
  USDT_CONTRACT: "0x55d398326f99059fF775485246999027B3197955",
  MOCHI_TOKEN: "0x0Eb18EA6Bd86F994FEC4F3580B5206F972433364",
  ZERO_ADDRESS: "0x0000000000000000000000000000000000000000",
  SELECTORS: {
    MINT: "0x836a1040", // mint(uint256 shares, address referrer, uint256 maxCost)
    QUOTE: "0xed1bd76c", // quote(uint256 shares)
    QUOTE_FOR: "0x207c8371", // quoteFor(uint256 agentId, uint256 shares)
    APPROVE: "0x095ea7b3", // approve(address spender, uint256 amount)
  },
  MAX_SHARES_PER_TX: 10,
  MAX_QUOTA_PER_IDENTITY: 10,
  TOKENS_PER_SHARE: 21000000,
  USDT_DECIMALS: 18,
};

function padUint256Hex(value) {
  const big = BigInt(value);
  if (big < 0n) throw new Error("Nilai uint256 tidak boleh negatif.");
  return big.toString(16).padStart(64, "0");
}

function padAddressHex(address) {
  const clean = String(address).replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(clean)) {
    throw new Error(`Alamat EVM tidak valid: ${address}`);
  }
  return clean.padStart(64, "0");
}

function buildMintCalldata(shares, referrer = MOCHI_CONSTANTS.ZERO_ADDRESS, maxCostWei = 0n) {
  return (
    MOCHI_CONSTANTS.SELECTORS.MINT +
    padUint256Hex(shares) +
    padAddressHex(referrer) +
    padUint256Hex(maxCostWei)
  );
}

function buildApproveCalldata(spender = MOCHI_CONSTANTS.MINT_CONTRACT, amountWei = 0n) {
  return (
    MOCHI_CONSTANTS.SELECTORS.APPROVE +
    padAddressHex(spender) +
    padUint256Hex(amountWei)
  );
}

function buildQuoteCalldata(shares) {
  return MOCHI_CONSTANTS.SELECTORS.QUOTE + padUint256Hex(shares);
}

function buildQuoteForCalldata(agentId, shares) {
  return (
    MOCHI_CONSTANTS.SELECTORS.QUOTE_FOR +
    padUint256Hex(agentId) +
    padUint256Hex(shares)
  );
}

function formatWeiToUnits(weiStr, decimals = 18) {
  const wei = BigInt(weiStr || "0");
  const base = 10n ** BigInt(decimals);
  const whole = wei / base;
  const frac = wei % base;
  if (frac === 0n) return `${whole}.0`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

class MochiAdapter {
  constructor(options = {}) {
    this.fetchFn = options.fetchFn || fetch;
    this.rpcCallFn = options.rpcCallFn || bscRpcCall;
    this.rpcUrl = options.rpcUrl;
  }

  async fetchJson(url) {
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "BinanceAgenticAutomationEngine/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`MOCHI API error HTTP ${res.status} pada ${url}`);
    }
    return res.json();
  }

  /**
   * 1. Mengambil status live MOCHI dari /api/stats
   */
  async getStats() {
    return this.fetchJson(MOCHI_CONSTANTS.STATS_URL);
  }

  /**
   * 2. Memeriksa eligibility wallet pada /api/verify?address=<wallet>
   */
  async checkEligibility(walletAddress) {
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      throw new Error("Alamat wallet BSC (0x...) tidak valid untuk pengecekan eligibility MOCHI.");
    }
    const url = `${MOCHI_CONSTANTS.VERIFY_URL}?address=${encodeURIComponent(walletAddress)}`;
    return this.fetchJson(url);
  }

  /**
   * 3. Mengambil riwayat aktivitas mint dari /api/activity
   */
  async getHistory(walletAddress = null, limit = 30) {
    const url = `${MOCHI_CONSTANTS.ACTIVITY_URL}?limit=${encodeURIComponent(limit)}`;
    const data = await this.fetchJson(url);
    const allMints = data.mints || [];
    const myMints = walletAddress
      ? allMints.filter((m) => String(m.buyer).toLowerCase() === walletAddress.toLowerCase())
      : [];

    return {
      ...data,
      myMints,
    };
  }

  /**
   * 4. Menghitung quote (Personalized via quoteFor jika memiliki Agent ID, atau umum via quote)
   */
  async getQuote(sharesInput, walletAddress = null) {
    const shares = Number(sharesInput);
    if (!Number.isInteger(shares) || shares < 1 || shares > MOCHI_CONSTANTS.MAX_SHARES_PER_TX) {
      throw new Error(
        `Jumlah shares harus bilangan bulat antara 1 sampai ${MOCHI_CONSTANTS.MAX_SHARES_PER_TX}.`
      );
    }

    const stats = await this.getStats();
    let verifyData = null;
    if (walletAddress && /^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      verifyData = await this.checkEligibility(walletAddress);
    }

    const pricePerShareWei = BigInt(stats.pricePerShare || "1000000000000000000");
    const tokensPerShareWei = BigInt(stats.tokensPerShare || "21000000000000000000000000");

    // Cek apakah free first share berlaku untuk wallet ini
    const globalFreeAvailable = Boolean(stats.freeFirstShare && !stats.freeSharePoolExhausted);
    let walletHasFreeShare = false;
    let onChainCostWei = null;

    if (verifyData) {
      walletHasFreeShare = Boolean(
        globalFreeAvailable &&
          (verifyData.firstShareFree ||
            verifyData.freeShareAvailable ||
            Number(verifyData.freeSharesAvailable) > 0)
      );

      // Verifikasi langsung ke smart contract menggunakan quoteFor(uint256 agentId, uint256 shares) jika agentId tersedia
      if (verifyData.agentId && /^\d+$/.test(String(verifyData.agentId))) {
        try {
          const calldata = buildQuoteForCalldata(verifyData.agentId, shares);
          const hexRes = await this.rpcCallFn(
            "eth_call",
            [{ to: MOCHI_CONSTANTS.MINT_CONTRACT, data: calldata }, "latest"],
            this.rpcUrl
          );
          if (hexRes && hexRes !== "0x") {
            onChainCostWei = BigInt(hexRes);
          }
        } catch {
          // Gunakan kalkulasi deterministik dari verifyData jika RPC timeout
        }
      }
    }

    const freeSharesApplied =
      onChainCostWei !== null
        ? onChainCostWei < pricePerShareWei * BigInt(shares)
          ? 1
          : 0
        : walletHasFreeShare
          ? 1
          : 0;

    const paidShares = Math.max(0, shares - freeSharesApplied);
    const exactCostWei =
      onChainCostWei !== null ? onChainCostWei : pricePerShareWei * BigInt(paidShares);

    // Sesuai dokumentasi resmi agenticmochi.xyz/skill.md:
    // "Pass maxCost = 0 to mint only your free share: the call succeeds at zero cost and needs no USDT allowance at all."
    // Untuk share berbayar, maxCost = exactCostWei (1 USDT per paid share).
    const maxCostWei = exactCostWei;
    const totalMochiTokens = Number(tokensPerShareWei / 10n ** 18n) * shares;

    // Cek apakah membutuhkan USDT approve
    let currentAllowanceWei = 0n;
    if (verifyData && verifyData.allowance !== undefined) {
      const allowanceFloat = Number(verifyData.allowance || 0);
      currentAllowanceWei = BigInt(Math.floor(allowanceFloat * 1e6)) * 10n ** 12n;
    }

    const needsApproval = maxCostWei > 0n && currentAllowanceWei < maxCostWei;
    const approveCalldata = needsApproval
      ? buildApproveCalldata(MOCHI_CONSTANTS.MINT_CONTRACT, maxCostWei)
      : null;
    const mintCalldata = buildMintCalldata(
      shares,
      MOCHI_CONSTANTS.ZERO_ADDRESS,
      maxCostWei
    );

    return {
      shares,
      freeSharesApplied,
      paidShares,
      costUsdt: formatWeiToUnits(exactCostWei, 18),
      costWei: exactCostWei.toString(),
      maxCostUsdt: formatWeiToUnits(maxCostWei, 18),
      maxCostWei: maxCostWei.toString(),
      tokensOut: totalMochiTokens.toLocaleString("en-US"),
      tokensOutRaw: (tokensPerShareWei * BigInt(shares)).toString(),
      needsApproval,
      approveCalldata,
      mintCalldata,
      stats,
      verifyData,
    };
  }

  /**
   * 5. Menyiapkan transaksi Mint (Preview via BAW CLI + Simpan ke TransactionGuard untuk konfirmasi /confirm <id>)
   * Wajib membaca ulang state project (/api/stats & /api/verify) sebelum menyiapkan transaksi.
   */
  async prepareMint({ shares: sharesInput, userId, walletService, txGuard }) {
    const shares = Number(sharesInput || 1);
    if (!Number.isInteger(shares) || shares < 1 || shares > MOCHI_CONSTANTS.MAX_SHARES_PER_TX) {
      throw new Error(
        `Jumlah shares tidak valid. Pilih antara 1 hingga ${MOCHI_CONSTANTS.MAX_SHARES_PER_TX} shares.`
      );
    }

    const walletAddress = await walletService.getAddressForChain(MOCHI_CONSTANTS.CHAIN_ID);
    if (!walletAddress) {
      throw new Error(
        "Wallet BAW belum terhubung atau tidak ditemukan alamat BSC. Jalankan `/status` atau `/auth` terlebih dahulu."
      );
    }

    // Baca ulang stats & eligibility live
    const quote = await this.getQuote(shares, walletAddress);
    const { stats, verifyData } = quote;

    if (!stats.mintOpen || stats.paused) {
      throw new Error("Minting MOCHI saat ini sedang ditutup atau dijeda (paused).");
    }

    if (Number(stats.remainingShares) < shares) {
      throw new Error(
        `Sisa shares global tidak mencukupi (Tersisa: ${stats.remainingShares} shares).`
      );
    }

    if (!verifyData || !verifyData.eligible) {
      const reasons = (verifyData?.reasons || ["NO_AGENT_ID"]).join(", ");
      throw new Error(
        `Wallet \`${walletAddress}\` belum memenuhi syarat (ineligible) untuk mint MOCHI.\n` +
          `Alasan: **${reasons}**\n` +
          `Pastikan wallet ini telah mengklaim **.ai Agent ID** di Binance App (Web3 Wallet -> Agent ID).`
      );
    }

    if (Number(verifyData.quotaRemaining) < shares) {
      throw new Error(
        `Kuota Agent ID Anda tidak mencukupi. Sisa kuota: ${verifyData.quotaRemaining} shares (Meminta: ${shares} shares).`
      );
    }

    const costUsdtNum = Number(quote.costUsdt);
    const walletUsdtNum = Number(verifyData.usdt || 0);
    if (costUsdtNum > 0 && walletUsdtNum < costUsdtNum) {
      throw new Error(
        `Saldo USDT tidak mencukupi untuk mint ${shares} shares.\n` +
          `• Dibutuhkan: ${quote.costUsdt} USDT\n` +
          `• Saldo USDT Anda: ${verifyData.usdt} USDT`
      );
    }

    const steps = [];

    // Jika membutuhkan USDT approve (hanya untuk paid share ketika allowance < maxCost)
    if (quote.needsApproval && quote.approveCalldata) {
      const approvePreview = await walletService.previewContractCall({
        chainId: MOCHI_CONSTANTS.CHAIN_ID,
        from: walletAddress,
        to: MOCHI_CONSTANTS.USDT_CONTRACT,
        valueWei: "0",
        inputData: quote.approveCalldata,
      });

      if (!approvePreview.ok) {
        const errMsg =
          approvePreview.error?.message || approvePreview.raw || "Gagal melakukan preview USDT approve.";
        throw new Error(`Preview USDT Approve gagal: ${errMsg}`);
      }

      steps.push({
        stepNumber: 1,
        label: `Approve ${quote.maxCostUsdt} USDT ke MOCHI Mint Contract`,
        to: MOCHI_CONSTANTS.USDT_CONTRACT,
        valueWei: "0",
        inputData: quote.approveCalldata,
        requestId: approvePreview.data?.requestId,
        previewData: approvePreview.data,
      });
    }

    // Preview panggilan kontrak mint(shares, 0x0, maxCost)
    // Catatan: Jika membutuhkan approve terlebih dahulu dan simulasi mint gagal karena allowance belum masuk on-chain,
    // kita tangani secara terstruktur.
    const mintPreview = await walletService.previewContractCall({
      chainId: MOCHI_CONSTANTS.CHAIN_ID,
      from: walletAddress,
      to: MOCHI_CONSTANTS.MINT_CONTRACT,
      valueWei: "0",
      inputData: quote.mintCalldata,
    });

    if (!mintPreview.ok && steps.length === 0) {
      const errMsg =
        mintPreview.error?.message || mintPreview.raw || "Gagal melakukan preview transaksi mint MOCHI.";
      throw new Error(`Preview Mint MOCHI gagal: ${errMsg}`);
    }

    steps.push({
      stepNumber: steps.length + 1,
      label: `Mint ${shares} Share (${quote.tokensOut} MOCHI) — Biaya: ${quote.costUsdt} USDT`,
      to: MOCHI_CONSTANTS.MINT_CONTRACT,
      valueWei: "0",
      inputData: quote.mintCalldata,
      requestId: mintPreview.ok ? mintPreview.data?.requestId : null,
      previewData: mintPreview.ok ? mintPreview.data : null,
      deferPreviewAfterApprove: !mintPreview.ok && steps.length > 0,
    });

    const pendingRecord = txGuard.createPendingTransaction({
      userId,
      project: "mochi",
      title: `MOCHI Mint (${shares} share${shares > 1 ? "s" : ""})`,
      walletAddress,
      chainId: MOCHI_CONSTANTS.CHAIN_ID,
      steps,
      estimatedSpendUsd: costUsdtNum,
      summary: {
        shares,
        freeSharesApplied: quote.freeSharesApplied,
        paidShares: quote.paidShares,
        costUsdt: quote.costUsdt,
        maxCostUsdt: quote.maxCostUsdt,
        tokensReceived: `${quote.tokensOut} MOCHI`,
        agentHandle: verifyData.handle ? `${verifyData.handle}.ai` : verifyData.agentId,
        quotaRemainingAfter: Number(verifyData.quotaRemaining) - shares,
      },
    });

    return {
      pendingRecord,
      quote,
    };
  }
}

module.exports = {
  MochiAdapter,
  MOCHI_CONSTANTS,
  buildMintCalldata,
  buildApproveCalldata,
  buildQuoteCalldata,
  buildQuoteForCalldata,
};
