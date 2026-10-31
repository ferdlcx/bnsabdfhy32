const { BawCli } = require("./bawCli");

/**
 * Daftar alamat token umum sesuai dokumentasi resmi binance-agentic-wallet SKILL.md v1.15.0
 */
const COMMON_BSC_TOKENS = {
  BNB: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  U: "0xcE24439F2D9C6a2289F741120FE202248B666666",
  USD1: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
  MOCHI: "0x0Eb18EA6Bd86F994FEC4F3580B5206F972433364",
};

class WalletService {
  constructor(options = {}) {
    this.cli = options.cli || new BawCli(options);
    this.defaultChainId = String(options.defaultChainId || "56");
    this.requiredCliVersion = options.requiredCliVersion || "1.12.0";
    this.skillVersion = options.skillVersion || "1.15.0";
    this.dryRun = Boolean(options.dryRun);
  }

  /**
   * Preflight Check 1 & 2: Cek versi CLI dan Skill BAW
   */
  async checkCliVersion() {
    return this.cli.run(["cli-check", "--required-version", this.requiredCliVersion, "--json"]);
  }

  async checkSkillVersion() {
    return this.cli.run([
      "skill-check",
      "--skill-name",
      "binance-agentic-wallet",
      "--current-version",
      this.skillVersion,
      "--json",
    ]);
  }

  /**
   * Authentication: signin, verify, signout
   */
  async authSignIn() {
    return this.cli.run(["auth", "signin", "--json"]);
  }

  async authVerify(qrCodeId) {
    if (!qrCodeId || !/^[a-zA-Z0-9-]+$/.test(qrCodeId)) {
      throw new Error("qrCodeId tidak valid.");
    }
    // auth verify dapat memakan waktu hingga 5 menit menunggu scan user di Binance App
    return this.cli.run(["auth", "verify", "--qrCodeId", qrCodeId, "--json"], 310000);
  }

  async authSignOut() {
    return this.cli.run(["auth", "signout", "--json"]);
  }

  /**
   * Wallet Status: UNCONNECTED | CREATING | CONNECTED
   */
  async getStatus() {
    return this.cli.run(["wallet", "status", "--json"]);
  }

  /**
   * Daftar network yang didukung oleh BAW
   */
  async getChains() {
    return this.cli.run(["wallet", "chains", "--json"]);
  }

  /**
   * Mengambil seluruh alamat dompet dan mengembalikan juga alamat spesifik untuk chainId (default 56 / BSC)
   */
  async getAddresses() {
    const res = await this.cli.run(["wallet", "address", "--json"]);
    if (!res.ok) return res;

    const addresses = res.data?.addresses || (Array.isArray(res.data) ? res.data : []);
    const bscEntry = addresses.find((a) => String(a.binanceChainId) === "56");
    const evmFallback = addresses.find((a) => /^0x[a-fA-F0-9]{40}$/.test(a.address || ""));

    return {
      ...res,
      addresses,
      bscAddress: bscEntry?.address || evmFallback?.address || null,
    };
  }

  async getAddressForChain(chainId = this.defaultChainId) {
    const res = await this.getAddresses();
    if (!res.ok) return null;
    const match = (res.addresses || []).find(
      (a) => String(a.binanceChainId) === String(chainId)
    );
    if (match?.address) return match.address;
    // EVM chains share the same 0x address in BAW
    if (String(chainId) !== "CT_501") {
      return res.bscAddress;
    }
    return null;
  }

  /**
   * Cek status klaim .ai Agent ID (baw wallet agent-id --json)
   */
  async getAgentId() {
    return this.cli.run(["wallet", "agent-id", "--json"]);
  }

  /**
   * Cek saldo token (baw wallet balance --json)
   * Default hideLowValue=false agar token baru / free mint (seperti MOCHI) tetap terlihat.
   */
  async getBalances(options = {}) {
    const args = ["wallet", "balance"];
    if (options.symbol) {
      args.push("--symbol", String(options.symbol));
    }
    if (options.tokenAddress) {
      args.push("--tokenAddress", String(options.tokenAddress));
    }
    if (options.chainId) {
      args.push("--binanceChainId", String(options.chainId));
    }
    const hideLow = options.hideLowValue !== undefined ? String(options.hideLowValue) : "false";
    args.push("--hideLowValue", hideLow, "--json");

    return this.cli.run(args);
  }

  /**
   * Cek pengaturan keamanan, kuota harian, waktu kedaluwarsa sesi, dan Developer Mode
   */
  async getSettings() {
    const res = await this.cli.run(["wallet", "settings", "--json"]);
    if (!res.ok || !res.data) return res;

    const devMode = res.data.devMode || {};
    const nowSec = Math.floor(Date.now() / 1000);
    const devModeExpired = devMode.expiresAt ? Number(devMode.expiresAt) <= nowSec : false;
    const devModeReady = Boolean(devMode.enabled) && !devModeExpired && !devMode.balanceExceeded;

    return {
      ...res,
      devModeReady,
      devModeExpired,
    };
  }

  /**
   * Cek apakah wallet sedang terkunci oleh transaksi pending atau butuh konfirmasi di Binance App
   */
  async getTxLock(chainId = this.defaultChainId) {
    return this.cli.run([
      "wallet",
      "tx-lock",
      "--binanceChainId",
      String(chainId),
      "--json",
    ]);
  }

  /**
   * Cek riwayat transaksi on-chain (baw wallet tx-history)
   */
  async getTxHistory(options = {}) {
    const args = ["wallet", "tx-history"];
    if (options.type) args.push("--type", String(options.type));
    if (options.txHash) args.push("--tx", String(options.txHash));
    if (options.chainId) args.push("--binanceChainId", String(options.chainId));
    if (options.size) args.push("--size", String(options.size));
    args.push("--json");
    return this.cli.run(args);
  }

  /**
   * Cek daftar token approval (baw approvals list)
   */
  async getApprovals(chainId = this.defaultChainId, spender = null) {
    const args = ["approvals", "list", "--binanceChainId", String(chainId)];
    if (spender) args.push("--spender", String(spender));
    args.push("--json");
    return this.cli.run(args);
  }

  /**
   * Revoke token approval (baw approvals revoke)
   */
  async revokeApproval({ chainId = this.defaultChainId, tokenContract, spender, type = "approve" }) {
    if (this.dryRun) {
      return {
        ok: true,
        dryRun: true,
        data: {
          orderId: "dry-run-revoke",
          status: "DRY_RUN_SIMULATED",
          txHash: null,
        },
      };
    }
    return this.cli.run([
      "approvals",
      "revoke",
      "--binanceChainId",
      String(chainId),
      "--tokenContract",
      String(tokenContract),
      "--spender",
      String(spender),
      "--type",
      String(type),
      "--json",
    ]);
  }

  /**
   * Step 1 External Contract Call: Preview & Simulation
   * Sesuai dokumentasi resmi references/external-sign.md:
   * baw contract-call preview --binanceChainId 56 --from <from> --to <to> --value <wei> --inputData <hex> --json
   */
  async previewContractCall({
    chainId = this.defaultChainId,
    from,
    to,
    valueWei = "0",
    inputData = "0x",
    gasLimit = null,
  }) {
    // 1. Pastikan Developer Mode aktif sebelum melakukan preview
    const settingsRes = await this.getSettings();
    if (settingsRes.ok && settingsRes.data && !settingsRes.devModeReady) {
      const dm = settingsRes.data.devMode || {};
      let reason = "Developer Mode belum aktif di Binance App.";
      if (settingsRes.devModeExpired) reason = "Developer Mode telah kedaluwarsa (berlaku 7 hari).";
      if (dm.balanceExceeded) reason = "Saldo wallet melebihi batas maksimum Developer Mode (Error 351804).";
      return {
        ok: false,
        error: {
          code: "DEV_MODE_REQUIRED",
          message:
            `${reason}\n` +
            `Cara mengaktifkan: Buka Binance App -> Web3 Wallet -> Agentic Wallet -> Settings (ikon kanan atas) -> Aktifkan Developer Mode & setujui Risk Warning.`,
        },
      };
    }

    // 2. Pastikan wallet tidak sedang LOCKED
    const lockRes = await this.getTxLock(chainId);
    if (lockRes.ok && lockRes.data?.status === "LOCKED") {
      return {
        ok: false,
        error: {
          code: "WALLET_TX_LOCKED",
          message:
            "Wallet sedang terkunci (LOCKED) karena ada transaksi pending di blockchain atau menunggu konfirmasi ganda di Binance App. Selesaikan/tunggu terlebih dahulu.",
        },
      };
    }

    const walletFrom = from || (await this.getAddressForChain(chainId));
    if (!walletFrom) {
      return {
        ok: false,
        error: {
          code: "WALLET_NOT_CONNECTED",
          message: "Tidak dapat memperoleh alamat wallet BAW. Pastikan sudah login (`baw wallet status`).",
        },
      };
    }

    const args = [
      "contract-call",
      "preview",
      "--binanceChainId",
      String(chainId),
      "--from",
      String(walletFrom),
      "--to",
      String(to),
      "--value",
      String(valueWei || "0"),
      "--inputData",
      String(inputData || "0x"),
    ];

    if (gasLimit !== null && gasLimit !== undefined) {
      args.push("--gasLimit", String(gasLimit));
    }
    args.push("--json");

    return this.cli.run(args);
  }

  /**
   * Step 2 External Contract Call: Execute berdasarkan requestId dari preview yang disetujui user
   * Sesuai dokumentasi resmi references/external-sign.md:
   * baw contract-call execute --requestId <requestId> --json
   */
  async executeContractCall(requestId) {
    if (!requestId || typeof requestId !== "string") {
      throw new Error("requestId dari contract-call preview wajib disertakan.");
    }

    if (this.dryRun) {
      return {
        ok: true,
        dryRun: true,
        data: {
          orderId: `dry-run-${Date.now()}`,
          status: "DRY_RUN_SIMULATED",
          txHash: "0x" + "0".repeat(64),
          message: "Mode DRY_RUN aktif: Transaksi tidak di-broadcast ke jaringan.",
        },
      };
    }

    return this.cli.run(["contract-call", "execute", "--requestId", requestId, "--json"]);
  }

  /**
   * Market Order Quote & Swap (Resmi BAW CLI: baw market-order quote / swap)
   */
  async getSwapQuote({ chainId = this.defaultChainId, fromToken, toToken, amount }) {
    return this.cli.run([
      "market-order",
      "quote",
      "--binanceChainId",
      String(chainId),
      "--fromToken",
      String(fromToken),
      "--toToken",
      String(toToken),
      "--amount",
      String(amount),
      "--json",
    ]);
  }

  async executeMarketSwap({ chainId = this.defaultChainId, fromToken, toToken, amount, slippage }) {
    if (this.dryRun) {
      return {
        ok: true,
        dryRun: true,
        data: {
          status: "DRY_RUN_SIMULATED",
          message: "Mode DRY_RUN aktif: Swap tidak dieksekusi.",
        },
      };
    }

    const args = [
      "market-order",
      "swap",
      "--binanceChainId",
      String(chainId),
      "--fromToken",
      String(fromToken),
      "--toToken",
      String(toToken),
      "--amount",
      String(amount),
    ];
    if (slippage) args.push("--slippage", String(slippage));
    args.push("--json");
    return this.cli.run(args);
  }
}

module.exports = {
  WalletService,
  COMMON_BSC_TOKENS,
};
