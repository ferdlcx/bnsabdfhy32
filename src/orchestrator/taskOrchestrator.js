const { inspectBscAddress } = require("../wallet/bscScanner");
const {
  formatWalletOverview,
  formatBalances,
  formatMochiStats,
  formatMochiEligibility,
  formatMochiQuote,
  formatPendingTransaction,
} = require("../telegram/formatters");

/**
 * Task Orchestrator:
 * Mengintegrasikan Direct Execution Engine (Deterministik) dan AI Reasoning Engine
 * dengan Transaction Guard, Skill Registry, dan Project Adapters.
 */
class TaskOrchestrator {
  constructor(options = {}) {
    this.config = options.config;
    this.security = options.security;
    this.walletService = options.walletService;
    this.txGuard = options.txGuard;
    this.skillRegistry = options.skillRegistry;
    this.skillLoader = options.skillLoader;
    this.mochiAdapter = options.mochiAdapter;
    this.genericAdapter = options.genericAdapter;
    this.aiRouter = options.aiRouter;
    this.txMonitor = options.txMonitor;
  }

  /**
   * /status - Status seluruh komponen sistem
   */
  async getSystemStatus() {
    const [cliRes, statusRes, settingsRes, agentIdRes] = await Promise.all([
      this.walletService.checkCliVersion(),
      this.walletService.getStatus(),
      this.walletService.getSettings(),
      this.walletService.getAgentId(),
    ]);

    const aiStatus = this.aiRouter.getStatus();
    const skills = this.skillRegistry.listSkills();

    let msg = `🖥️ **Universal BAW Automation Engine — System Status**\n\n`;
    msg += `• **Mode Eksekusi:** \`${this.config.dryRun ? "🧪 DRY-RUN (Simulasi Aman)" : "🟢 LIVE ON-CHAIN"}\`\n`;
    msg += `• **Kill Switch:** \`${this.security.isKillSwitchActive() ? "🛑 AKTIF (Semua Tx Diblokir)" : "🟢 NORMAL"}\`\n`;
    msg += `• **BAW CLI:** ${
      cliRes.ok
        ? `✅ v${cliRes.data?.currentCliVersion || this.config.bawRequiredCliVersion}`
        : `⚠️ ${cliRes.error?.message || "Belum terdeteksi"}`
    }\n`;
    msg += `• **Wallet Session:** \`${statusRes.data?.status || (statusRes.ok ? "CONNECTED" : "UNCONNECTED")}\`\n`;
    msg += `• **.ai Agent ID:** ${
      agentIdRes.data?.claimed
        ? `✅ \`${agentIdRes.data.agentId}\``
        : "❌ Belum diklaim / Belum login"
    }\n`;
    msg += `• **Developer Mode:** ${
      settingsRes.devModeReady ? "✅ Ready" : "⚠️ Off / Expired"
    }\n`;
    msg += `• **AI Router:** Primary Gemini (${aiStatus.geminiConfigured ? "✅ Ready" : "⚪ Not Set"}) | Secondary (${
      aiStatus.secondaryConfigured ? "✅ Ready" : "⚪ Not Set"
    }) | Deterministic Engine (✅ Always On)\n`;
    msg += `• **AI Budget Terpakai:** \`${aiStatus.callsLastHour} / ${aiStatus.maxCallsPerHour} calls/jam\`\n`;
    msg += `• **Skills Terdaftar:** \`${skills.length} skills\` (${skills.map((s) => s.slug).join(", ")})\n`;
    msg += `• **Spending Limit Lokal:** \`$${this.txGuard.getDailySpentUsd().toFixed(2)} / $${this.config.maxDailySpendUsd.toFixed(2)} hari ini\``;

    return msg;
  }

  /**
   * /wallet - Informasi lengkap wallet & Agent ID
   */
  async getWalletInfo() {
    const [statusRes, addressRes, agentIdRes, settingsRes] = await Promise.all([
      this.walletService.getStatus(),
      this.walletService.getAddresses(),
      this.walletService.getAgentId(),
      this.walletService.getSettings(),
    ]);

    return formatWalletOverview({
      statusRes,
      addressRes,
      agentIdRes,
      settingsRes,
    });
  }

  /**
   * /balance - Saldo seluruh token di BAW
   */
  async getBalances(symbol = null) {
    const res = await this.walletService.getBalances({
      symbol: symbol || undefined,
      hideLowValue: "false",
    });
    return formatBalances(res);
  }

  /**
   * /chains - Daftar jaringan yang didukung oleh BAW
   */
  async getSupportedChains() {
    const res = await this.walletService.getChains();
    if (!res.ok || !Array.isArray(res.data)) {
      return `❌ Gagal mengambil daftar chain: \`${res.error?.message || res.raw}\``;
    }
    let msg = `🌐 **Jaringan Blockchain yang Didukung (BAW):**\n\n`;
    for (const c of res.data) {
      msg += `• **${c.name}** (${c.simpleName}) — Chain ID: \`${c.binanceChainId}\`\n`;
    }
    return msg;
  }

  /**
   * /skills - Daftar skill yang terdaftar di Skill Registry
   */
  listSkillsFormatted() {
    const skills = this.skillRegistry.listSkills();
    if (skills.length === 0) {
      return "📚 Belum ada skill yang terdaftar.";
    }
    let msg = `📚 **Daftar Skill Terdaftar (${skills.length}):**\n\n`;
    for (const s of skills) {
      msg += `🔹 **${s.projectName}** (\`${s.slug}\` v${s.version})\n`;
      msg += `   • Network: ${s.network?.name || "BSC"} (Chain \`${s.network?.chainId || "56"}\`)\n`;
      msg += `   • Adapter: \`${s.adapter}\` | Status: \`${s.validationStatus}\`\n`;
      msg += `   • Source: \`${s.sourceUrl}\`\n\n`;
    }
    return msg.trim();
  }

  /**
   * /addskill <url> - Universal Skill Loader
   */
  async addSkillFromUrl(url) {
    const result = await this.skillLoader.loadFromUrl(url);
    const { skill, validation, cached } = result;

    this.security.logAudit("SKILL_IMPORT", {
      url,
      slug: skill.slug,
      status: validation.status,
      cached,
    });

    if (!validation.safe) {
      return (
        `🚨 **SKILL DIBLOKIR OLEH SECURITY VALIDATOR**\n\n` +
        `• **URL:** \`${url}\`\n` +
        `• **Status:** \`${validation.status}\`\n` +
        `• **Masalah Keamanan:**\n` +
        validation.issues.map((i) => `  - ${i}`).join("\n")
      );
    }

    const contractsList = Object.entries(skill.contracts || {})
      .filter(([, v]) => Boolean(v))
      .map(([k, v]) => `  - ${k}: \`${v}\``)
      .join("\n");

    const fnsList = (skill.functions || [])
      .map((f) => `  - \`${f.signature}\` (${f.selector || "no selector"})`)
      .join("\n");

    return (
      `✅ **Skill Berhasil ${cached ? "Dimuat dari Cache" : "Di-import & Divalidasi"}!**\n\n` +
      `• **Nama Project:** **${skill.projectName}** (\`${skill.slug}\` v${skill.version})\n` +
      `• **Network:** ${skill.network?.name} (Chain ID \`${skill.network?.chainId}\`)\n` +
      `• **Adapter:** \`${skill.adapter}\`\n` +
      `• **Status Keamanan:** \`${validation.status}\`\n` +
      (contractsList ? `\n📄 **Kontrak Terdeteksi:**\n${contractsList}\n` : "") +
      (fnsList ? `\n⚙️ **Fungsi & Selector:**\n${fnsList}\n` : "") +
      (skill.requiredConditions?.length
        ? `\n📌 **Persyaratan:**\n${skill.requiredConditions.map((c) => `  - ${c}`).join("\n")}\n`
        : "")
    );
  }

  /**
   * /check <project> - Cek eligibility wallet pada project
   */
  async checkProjectEligibility(projectSlug = "mochi", explicitAddress = null) {
    const slug = String(projectSlug || "mochi").trim().toLowerCase();
    if (slug === "mochi") {
      const addr =
        explicitAddress || (await this.walletService.getAddressForChain("56"));
      if (!addr) {
        return "❌ Gagal mendapatkan alamat BSC dari wallet BAW. Pastikan sudah login (`/status`) atau sertakan alamat `0x...`.";
      }
      const verify = await this.mochiAdapter.checkEligibility(addr);
      return formatMochiEligibility(verify);
    }

    const skill = this.skillRegistry.getSkill(slug);
    if (!skill) {
      return `❌ Project "${slug}" belum terdaftar di Skill Registry. Gunakan \`/addskill <url>\` terlebih dahulu.`;
    }

    return (
      `ℹ️ **Eligibility Info — ${skill.projectName}**\n` +
      `• Persyaratan: ${(skill.requiredConditions || ["Tidak ada syarat khusus"]).join(", ")}\n` +
      `• Endpoint Verify: \`${skill.apiEndpoints?.verify || "Tidak tersedia"}\``
    );
  }

  /**
   * /quote <project> <amount>
   */
  async getProjectQuote(projectSlug = "mochi", amount = 1) {
    const slug = String(projectSlug || "mochi").trim().toLowerCase();
    if (slug === "mochi") {
      const addr = await this.walletService.getAddressForChain("56");
      const quote = await this.mochiAdapter.getQuote(Number(amount || 1), addr);
      return formatMochiQuote(quote);
    }

    throw new Error(`Adapter quote untuk project "${slug}" belum tersedia.`);
  }

  /**
   * Menyiapkan transaksi Mint MOCHI (Preview + Simpan ke Pending Approval)
   */
  async prepareMochiMint(shares, userId) {
    if (this.security.isKillSwitchActive()) {
      throw new Error("🛑 Kill Switch sedang aktif! Seluruh persiapan dan eksekusi transaksi dinonaktifkan.");
    }

    const { pendingRecord } = await this.mochiAdapter.prepareMint({
      shares: Number(shares || 1),
      userId,
      walletService: this.walletService,
      txGuard: this.txGuard,
    });

    this.security.logAudit("TX_PREVIEW_CREATED", {
      txId: pendingRecord.txId,
      userId,
      project: "mochi",
      shares,
      estimatedSpendUsd: pendingRecord.estimatedSpendUsd,
    });

    return formatPendingTransaction(pendingRecord);
  }

  /**
   * /confirm <id> - Mengeksekusi transaksi yang telah di-preview dan disetujui pengguna
   */
  async confirmTransaction(txIdInput, userId, chatId) {
    if (this.security.isKillSwitchActive()) {
      throw new Error("🛑 Kill Switch sedang aktif! Eksekusi transaksi dibatalkan.");
    }

    let targetTxId = String(txIdInput || "").trim().toUpperCase();
    if (!targetTxId) {
      const userPending = this.txGuard.listPendingForUser(userId);
      if (userPending.length === 0) {
        return "❌ Tidak ada transaksi yang menunggu persetujuan.";
      }
      if (userPending.length > 1) {
        return (
          `⚠️ Terdapat ${userPending.length} transaksi pending. Sebutkan ID secara spesifik:\n` +
          userPending.map((t) => `• \`/confirm ${t.txId}\` — ${t.title}`).join("\n")
        );
      }
      targetTxId = userPending[0].txId;
    }

    const record = this.txGuard.consumeForExecution(targetTxId, userId);
    const results = [];

    for (const step of record.steps) {
      let requestId = step.requestId;

      // Jika langkah ke-2 membutuhkan re-preview setelah langkah ke-1 (Approve) berhasil
      if (!requestId && step.deferPreviewAfterApprove) {
        const freshPreview = await this.walletService.previewContractCall({
          chainId: record.chainId,
          from: record.walletAddress,
          to: step.to,
          valueWei: step.valueWei,
          inputData: step.inputData,
        });
        if (!freshPreview.ok || !freshPreview.data?.requestId) {
          throw new Error(
            `Gagal menyiapkan preview lanjutan untuk "${step.label}": ${
              freshPreview.error?.message || freshPreview.raw
            }`
          );
        }
        requestId = freshPreview.data.requestId;
      }

      const execRes = await this.walletService.executeContractCall(requestId);
      if (!execRes.ok) {
        this.security.logAudit("TX_EXECUTION_FAILED", {
          txId: record.txId,
          step: step.stepNumber,
          error: execRes.error,
        });
        throw new Error(
          `Eksekusi gagal pada Step ${step.stepNumber} (${step.label}):\n\`${
            execRes.error?.message || execRes.raw
          }\``
        );
      }

      const txHash = execRes.data?.txHash || null;
      const status = execRes.data?.status || "SUBMITTED";
      results.push({
        stepNumber: step.stepNumber,
        label: step.label,
        status,
        txHash,
        orderId: execRes.data?.orderId,
        message: execRes.data?.message,
      });

      if (txHash && this.txMonitor) {
        this.txMonitor.watchTransaction({
          txHash,
          orderId: execRes.data?.orderId,
          userId,
          chatId,
          title: `${record.title} - ${step.label}`,
          chainId: record.chainId,
        });
      }
    }

    this.txGuard.recordSpendUsd(record.estimatedSpendUsd);
    this.security.logAudit("TX_EXECUTED", {
      txId: record.txId,
      userId,
      results,
    });

    if (this.txMonitor) {
      this.txMonitor.recordActivity({
        type: "TX_EXECUTED",
        txId: record.txId,
        title: record.title,
        results,
      });
    }

    let msg = `🚀 **Transaksi \`${record.txId}\` Berhasil Dikirim!**\n\n`;
    for (const r of results) {
      msg += `✅ **Step ${r.stepNumber}: ${r.label}**\n`;
      msg += `• Status: \`${r.status}\`\n`;
      if (r.txHash) {
        msg += `• TxHash: \`${r.txHash}\`\n`;
        msg += `• Explorer: [Lihat di BscScan](https://bscscan.com/tx/${r.txHash})\n`;
      }
      if (r.status === "PENDING_CONFIRMATION" || r.message) {
        msg += `• 📱 **Penting:** ${r.message || "Buka Binance App Anda untuk menyetujui konfirmasi akhir."}\n`;
      }
      msg += `\n`;
    }
    return msg.trim();
  }

  /**
   * /task <instruction> - Menjalankan instruksi natural language melalui AI Router + Deterministic Execution
   */
  async handleNaturalLanguageTask(instruction, userId) {
    const skills = this.skillRegistry.listSkills();
    const plan = await this.aiRouter.routeTaskInstruction(instruction, skills);

    let header = `🤖 **Task Planner (${plan.provider})**\n• **Rencana:** ${plan.explanation}\n\n---\n\n`;

    switch (plan.intent) {
      case "WALLET_INFO":
        return header + (await this.getWalletInfo());
      case "WALLET_BALANCE":
        return header + (await this.getBalances());
      case "MOCHI_STATS":
        return header + formatMochiStats(await this.mochiAdapter.getStats());
      case "PROJECT_CHECK":
        return header + (await this.checkProjectEligibility(plan.project || "mochi"));
      case "PROJECT_QUOTE":
        return header + (await this.getProjectQuote(plan.project || "mochi", plan.params?.shares || 1));
      case "MOCHI_MINT_PREVIEW":
        return header + (await this.prepareMochiMint(plan.params?.shares || 1, userId));
      case "ADD_SKILL":
        if (plan.params?.url) {
          return header + (await this.addSkillFromUrl(plan.params.url));
        }
        return header + "Sebutkan URL skill yang ingin di-import.";
      case "INSPECT_ADDRESS":
        if (plan.params?.address) {
          const scan = await inspectBscAddress(plan.params.address, this.config.bscRpcUrl);
          return header + scan.report;
        }
        return header + "Alamat kontrak tidak valid.";
      default:
        return header;
    }
  }
}

module.exports = {
  TaskOrchestrator,
};
