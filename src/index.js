const { getConfig } = require("./config/env");
const { SecurityManager } = require("./security/allowlist");
const { TransactionGuard } = require("./security/txGuard");
const { BawCli } = require("./wallet/bawCli");
const { WalletService } = require("./wallet/walletService");
const { SkillRegistry } = require("./skills/skillRegistry");
const { UniversalSkillLoader } = require("./skills/skillLoader");
const { MochiAdapter } = require("./adapters/mochiAdapter");
const { GenericContractAdapter } = require("./adapters/genericAdapter");
const { AIRouter } = require("./ai/aiRouter");
const { TransactionMonitor } = require("./orchestrator/txMonitor");
const { TaskOrchestrator } = require("./orchestrator/taskOrchestrator");
const { createTelegramBot } = require("./telegram/bot");

function createEngine(configOverrides = {}) {
  const config = getConfig(configOverrides);

  const security = new SecurityManager({
    allowedUserIds: config.allowedUserIds,
    killSwitch: config.killSwitch,
    dataDir: config.dataDir,
  });

  const txGuard = new TransactionGuard({
    maxTxSpendUsd: config.maxTxSpendUsd,
    maxDailySpendUsd: config.maxDailySpendUsd,
    confirmationTtlSeconds: config.txConfirmationTtlSeconds,
  });

  const bawCli = new BawCli({
    bin: config.bawBin,
    timeoutMs: config.bawTimeoutMs,
  });

  const walletService = new WalletService({
    cli: bawCli,
    defaultChainId: config.defaultChainId,
    requiredCliVersion: config.bawRequiredCliVersion,
    skillVersion: config.bawSkillVersion,
    dryRun: config.dryRun,
  });

  const skillRegistry = new SkillRegistry({
    skillsDir: config.skillsDir,
  });

  // Daftarkan semua kontrak dari skill yang sudah ada di registry ke dalam TransactionGuard allowlist
  for (const skill of skillRegistry.listSkills()) {
    if (skill.validationStatus !== "BLOCKED_UNSAFE" && skill.contracts) {
      for (const [role, addr] of Object.entries(skill.contracts)) {
        if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
          txGuard.allowContract(addr, {
            name: `${skill.projectName} (${role})`,
            chainId: skill.network?.chainId || "56",
            type: role,
          });
        }
      }
    }
  }

  const skillLoader = new UniversalSkillLoader({
    registry: skillRegistry,
    txGuard,
  });

  const mochiAdapter = new MochiAdapter({
    rpcUrl: config.bscRpcUrl,
  });

  const genericAdapter = new GenericContractAdapter({
    walletService,
    txGuard,
  });

  const aiRouter = new AIRouter({
    geminiApiKey: config.geminiApiKey,
    geminiModel: config.geminiModel,
    openaiCompatApiKey: config.openaiCompatApiKey,
    openaiCompatBaseUrl: config.openaiCompatBaseUrl,
    openaiCompatModel: config.openaiCompatModel,
    timeoutMs: config.aiTimeoutMs,
    maxCallsPerHour: config.aiMaxCallsPerHour,
    maxTokensPerCall: config.aiMaxTokensPerCall,
  });

  let botInstance = null;

  const txMonitor = new TransactionMonitor({
    walletService,
    intervalMs: config.txMonitorIntervalMs,
    notifyCallback: async (chatId, info) => {
      if (!botInstance || !chatId) return;
      const icon = info.finalStatus === "confirmed" ? "✅" : "❌";
      const text =
        `${icon} **Update Status Transaksi On-Chain**\n\n` +
        `• **Transaksi:** ${info.title}\n` +
        `• **Status Akhir:** \`${info.finalStatus.toUpperCase()}\`\n` +
        `• **TxHash:** \`${info.txHash}\`\n` +
        `• 🔗 [Lihat di BscScan](https://bscscan.com/tx/${info.txHash})`;
      await botInstance.telegram
        .sendMessage(chatId, text, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        })
        .catch(() => {});
    },
  });

  const orchestrator = new TaskOrchestrator({
    config,
    security,
    walletService,
    txGuard,
    skillRegistry,
    skillLoader,
    mochiAdapter,
    genericAdapter,
    aiRouter,
    txMonitor,
  });

  return {
    config,
    security,
    txGuard,
    bawCli,
    walletService,
    skillRegistry,
    skillLoader,
    mochiAdapter,
    genericAdapter,
    aiRouter,
    txMonitor,
    orchestrator,
    startTelegramBot() {
      botInstance = createTelegramBot({
        config,
        security,
        orchestrator,
      });
      botInstance.launch({ dropPendingUpdates: true });
      console.log(
        `✅ Universal Binance Agentic Wallet Automation Engine AKTIF! (Mode: ${
          config.dryRun ? "DRY-RUN" : "LIVE"
        })`
      );

      const stopGracefully = (signal) => {
        console.log(`\n🛑 Menerima sinyal ${signal}, menghentikan engine...`);
        txMonitor.stop();
        try {
          botInstance.stop(signal);
        } catch {}
        process.exit(0);
      };

      process.once("SIGINT", () => stopGracefully("SIGINT"));
      process.once("SIGTERM", () => stopGracefully("SIGTERM"));
      return botInstance;
    },
  };
}

if (require.main === module) {
  const engine = createEngine();
  engine.startTelegramBot();
}

module.exports = {
  createEngine,
};
