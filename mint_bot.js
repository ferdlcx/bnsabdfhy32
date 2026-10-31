"use strict";

const { Telegraf } = require("telegraf");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { loadDotEnv, parseAllowedUserIds, getConfig } = require("./src/config/env");
const { redactText } = require("./src/security/redactor");
const { safeFetchText } = require("./src/security/ssrfGuard");
const { inspectBscAddress } = require("./src/wallet/bscScanner");
const { SkillRegistry } = require("./src/skills/skillRegistry");
const { UniversalSkillLoader } = require("./src/skills/skillLoader");
const {
  PendingPreviewStore,
  AgentToolRegistry,
  GEMINI_TOOL_DECLARATIONS,
} = require("./src/agent/toolRegistry");
const {
  GeminiAgentOrchestrator,
  resolveGeminiModel,
} = require("./src/agent/geminiOrchestrator");
const {
  MINT_CONTRACT,
  MOCHI_CONTRACT,
  SITE_URL,
  USDT_CONTRACT,
  executeMochiPreview,
  formatUnits,
  getMochiStatus,
  prepareMochiTransaction,
  summarizeMochiStatus,
  summarizeMochiPreview,
  mochiProtocolAdapter,
} = require("./mochi");

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Menjalankan perintah BAW CLI dengan argumen tetap menggunakan execFile (tanpa shell).
 */
async function executeBaw(args = [], execImpl = execFileAsync) {
  try {
    const { stdout, stderr } = await execImpl("baw", args.map(String), {
      timeout: 45000,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return redactText((stdout || stderr || "Eksekusi selesai tanpa output.").trim());
  } catch (error) {
    return redactText(
      `Error CLI BAW: ${(error.stderr || error.stdout || error.message || "Unknown error").trim()}`
    );
  }
}

/**
 * Menjalankan perintah BAW CLI dan memvalidasi output JSON `{ success: true, data: ... }`.
 */
async function executeBawJson(args = [], execImpl = execFileAsync) {
  let stdout = "";
  try {
    const finalArgs = args.map(String);
    if (!finalArgs.includes("--json")) finalArgs.push("--json");
    ({ stdout } = await execImpl("baw", finalArgs, {
      timeout: 45000,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
      windowsHide: true,
    }));
  } catch (error) {
    const output = error.stderr || error.stdout || error.message || "Unknown BAW error";
    throw new Error(redactText(String(output).trim()));
  }

  let response;
  try {
    const cleanOut = stdout.trim();
    const firstBrace = cleanOut.indexOf("{");
    const lastBrace = cleanOut.lastIndexOf("}");
    const jsonSlice =
      firstBrace !== -1 && lastBrace > firstBrace
        ? cleanOut.slice(firstBrace, lastBrace + 1)
        : cleanOut;
    response = JSON.parse(jsonSlice);
  } catch {
    throw new Error("Output BAW bukan JSON yang valid.");
  }

  if (response.success !== true) {
    throw new Error(redactText(response.error?.message || "Perintah BAW gagal."));
  }
  return response;
}

async function replyInChunks(ctx, text) {
  const safe = redactText(String(text || ""));
  const chars = Array.from(safe);
  for (let i = 0; i < chars.length; i += MAX_MESSAGE_LENGTH) {
    const chunk = chars.slice(i, i + MAX_MESSAGE_LENGTH).join("");
    await ctx
      .reply(chunk, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      })
      .catch(() =>
        ctx.reply(chunk, {
          disable_web_page_preview: true,
        })
      );
  }
}

async function replyPlainInChunks(ctx, text) {
  const safe = redactText(String(text || ""));
  const chars = Array.from(safe);
  for (let i = 0; i < chars.length; i += MAX_MESSAGE_LENGTH) {
    await ctx.reply(chars.slice(i, i + MAX_MESSAGE_LENGTH).join(""), {
      disable_web_page_preview: true,
    });
  }
}

function createBotApp(options = {}) {
  loadDotEnv();
  const config = getConfig(options.envOverrides || {});

  const token = options.telegramBotToken || config.telegramBotToken;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum diatur.");

  const apiKey = options.geminiApiKey ?? config.geminiApiKey;
  if (!apiKey && !options.allowMissingGeminiKey) {
    throw new Error("GEMINI_API_KEY belum diatur.");
  }

  const allowedUsers =
    options.allowedUsers ||
    parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS || "");

  const runBawJson = options.runBawJson || ((args) => executeBawJson(args, options.execImpl));
  const runBawRaw = options.runBawRaw || ((args) => executeBaw(args, options.execImpl));
  const fetchImpl = options.fetchImpl || fetch;

  const previewStore = options.previewStore || new PendingPreviewStore();
  const skillRegistry = options.skillRegistry || new SkillRegistry({ skillsDir: config.skillsDir });
  const skillLoader =
    options.skillLoader ||
    new UniversalSkillLoader({
      registry: skillRegistry,
      fetchTextFn: options.safeFetchTextFn || safeFetchText,
    });

  const toolRegistry =
    options.toolRegistry ||
    new AgentToolRegistry({
      runBawJson,
      fetchImpl,
      safeFetchTextFn: options.safeFetchTextFn || safeFetchText,
      previewStore,
      adapters: [mochiProtocolAdapter],
    });

  const geminiOrchestrator =
    options.geminiOrchestrator ||
    new GeminiAgentOrchestrator({
      apiKey,
      model: resolveGeminiModel(options.model || process.env.GEMINI_MODEL),
      toolRegistry,
      aiClient: options.aiClient,
    });

  const bot = options.bot || new Telegraf(token);
  let killSwitch = Boolean(config.killSwitch);

  const isAllowed = (ctx) =>
    ctx.chat?.type === "private" && ctx.from && allowedUsers.has(Number(ctx.from.id));

  // /id - Menampilkan Telegram User ID
  bot.command("id", async (ctx) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return;
    await ctx.reply(`Telegram User ID Anda: \`${ctx.from.id}\``, {
      parse_mode: "Markdown",
    });
  });

  // /start & /help
  const sendHelp = async (ctx) => {
    if (!isAllowed(ctx)) return ctx.reply(`Akses ditolak. ID Anda: ${ctx.from?.id}`);
    await replyInChunks(
      ctx,
      "🤖 **Web3 Telegram Agent (Binance Agentic Wallet + Gemini Tool Calling)**\n\n" +
        "**Perintah Utama:**\n" +
        "• `/status`, `/wallet`, `/address`, `/balance`, `/settings`, `/chains` — Cek status & dompet BAW (read-only)\n" +
        "• `/mochi` / `/mochi check` — Cek panduan, eligibility, kuota, & saldo untuk MOCHI\n" +
        "• `/mochi quote <1-10>` — Cek estimasi biaya mint MOCHI\n" +
        "• `/mochi mint <1-10>` — Buat preview transaksi (Approval USDT / Mint MOCHI)\n" +
        "• `/pending` — Lihat preview transaksi yang menunggu konfirmasi\n" +
        "• `/confirm [id]` — Konfirmasi & jalankan 1 preview transaksi yang aktif\n" +
        "• `/cancel [id]` — Batalkan preview transaksi yang aktif\n" +
        "• `/skills`, `/addskill <url>` — Lihat / baca dokumentasi `skill.md` eksternal\n" +
        "• `/cek <0x...>` — Cek kontrak/wallet di BNB Chain (GoPlus & DexScreener)\n" +
        "• `/reset` — Hapus riwayat percakapan Gemini\n\n" +
        "**Catatan Privasi & Keamanan:**\n" +
        "Pesan chat biasa dikirim ke Google Gemini API dan data web dibaca dari host terkait. " +
        "Situs eksternal diperlakukan sebagai input tidak tepercaya. Setiap transaksi (Approval maupun Mint) memerlukan `/confirm` eksplisit secara terpisah."
    );
  };

  bot.command("start", sendHelp);
  bot.command("help", sendHelp);

  // /reset - Hapus riwayat percakapan Gemini per user
  bot.command("reset", async (ctx) => {
    if (!isAllowed(ctx)) return;
    geminiOrchestrator.resetUserHistory(ctx.from.id);
    await ctx.reply("Konteks percakapan sudah dihapus.");
  });

  // /address & /wallet
  bot.command(["address", "wallet"], async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await runBawRaw(["wallet", "address", "--json"]);
    const match = out.match(/0x[a-fA-F0-9]{40}/);
    const cleanAddr = match
      ? `\n\nTap untuk salin: \`${match[0]}\`\n🔗 [BscScan](https://bscscan.com/address/${match[0]})`
      : "";
    await replyInChunks(
      ctx,
      `📍 **Alamat Dompet BAW Anda:**\n\`\`\`json\n${out}\n\`\`\`${cleanAddr}`
    );
  });

  // /status
  bot.command("status", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await runBawRaw(["wallet", "status", "--json"]);
    await replyInChunks(ctx, `📡 **Status Wallet:**\n\`\`\`json\n${out}\n\`\`\``);
  });

  // /balance
  bot.command("balance", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await runBawRaw(["wallet", "balance", "--hideLowValue", "false", "--json"]);
    await replyInChunks(ctx, `💰 **Saldo Wallet:**\n\`\`\`json\n${out}\n\`\`\``);
  });

  // /settings
  bot.command("settings", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await runBawRaw(["wallet", "settings", "--json"]);
    await replyInChunks(ctx, `⚙️ **Wallet Settings:**\n\`\`\`json\n${out}\n\`\`\``);
  });

  // /chains
  bot.command("chains", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await runBawRaw(["wallet", "chains", "--json"]);
    await replyInChunks(ctx, `🌐 **Supported Chains:**\n\`\`\`json\n${out}\n\`\`\``);
  });

  // /cek <0x...>
  bot.command("cek", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const target = ctx.message.text.replace(/^\/cek(@\S+)?/i, "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(target)) {
      return ctx.reply("Format salah! Gunakan: `/cek 0xAlamatKontrakAtauWallet`", {
        parse_mode: "Markdown",
      });
    }
    await ctx.sendChatAction("typing");
    const { report } = await inspectBscAddress(target);
    await replyInChunks(ctx, report);
  });

  // /skills & /addskill
  bot.command("skills", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const list = skillRegistry.listSkills();
    const lines = list.map(
      (s) =>
        `• **${s.projectName}** (\`${s.slug}\`) — Chain \`${s.network?.chainId || "56"}\` | Adapter: \`${s.adapter}\` | Status: \`${s.validationStatus}\``
    );
    await replyInChunks(ctx, `📚 **Registered Skills (${list.length}):**\n${lines.join("\n")}`);
  });

  bot.command("addskill", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const url = ctx.message.text.replace(/^\/addskill(@\S+)?/i, "").trim();
    if (!url) {
      return ctx.reply("Gunakan: `/addskill https://agenticmochi.xyz/skill.md`", {
        parse_mode: "Markdown",
      });
    }
    try {
      await ctx.sendChatAction("typing");
      const res = await skillLoader.loadFromUrl(url);
      if (!res.validation.safe) {
        return replyPlainInChunks(
          ctx,
          `Skill ditolak oleh validator keamanan (${res.validation.status}): ${res.validation.issues.join("; ")}`
        );
      }
      const adapterSupported = Boolean(toolRegistry.findAdapter(res.skill.slug));
      await replyPlainInChunks(
        ctx,
        [
          `Panduan skill berhasil dibaca: ${res.skill.projectName} (${res.skill.slug})`,
          `Sumber: ${res.skill.sourceUrl}`,
          `Network: ${res.skill.network?.name} (chainId ${res.skill.network?.chainId})`,
          `Kontrak terdeteksi: ${JSON.stringify(res.skill.contracts || {})}`,
          `Status adapter transaksi tervalidasi: ${
            adapterSupported
              ? `Didukung (${res.skill.adapter})`
              : "Belum didukung untuk pembuatan transaksi otomatis (hanya analisis read-only)"
          }`,
        ].join("\n")
      );
    } catch (error) {
      await replyPlainInChunks(ctx, `Gagal membaca skill: ${error.message}`);
    }
  });

  // /mochi [stats|check|quote|mint]
  bot.command("mochi", async (ctx) => {
    if (!isAllowed(ctx)) return;
    if (killSwitch) {
      return ctx.reply("Kill switch sedang aktif. Seluruh operasi transaksi dihentikan.");
    }
    const rawArgs = ctx.message.text
      .replace(/^\/mochi(@\S+)?/i, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const sub = (rawArgs[0] || "check").toLowerCase();

    try {
      await ctx.sendChatAction("typing");
      if (sub === "check" || sub === "stats" || sub === "status") {
        const status = await getMochiStatus({ runBawJson, fetchImpl });
        return replyPlainInChunks(ctx, summarizeMochiStatus(status));
      }

      if (sub === "quote") {
        const shares = Number(rawArgs[1] ?? 1);
        const quote = await mochiProtocolAdapter.quote({
          shares,
          runBawJson,
          fetchImpl,
        });
        return replyPlainInChunks(
          ctx,
          [
            `Quote MOCHI (${quote.shares} share)`,
            `Wallet: ${quote.walletAddress}`,
            `Biaya maksimum (quoteFor): ${quote.maxCostUsdt} USDT`,
            `Estimasi diterima: ${quote.tokensOut}`,
            `Perlu approval USDT terlebih dahulu: ${quote.approvalRequired ? "ya" : "tidak"}`,
            `Saldo saat ini: ${quote.bnbBalance} BNB; ${quote.usdtBalance} USDT (Allowance: ${quote.allowanceUsdt} USDT)`,
            "Tidak ada transaksi yang dibuat.",
          ].join("\n")
        );
      }

      if (sub === "mint") {
        const shares = Number(rawArgs[1] ?? 1);
        const result = await toolRegistry.handlePrepareTransaction(
          { protocol: "mochi", action: "mint", shares },
          { userId: ctx.from.id, chatId: ctx.chat.id }
        );
        return replyPlainInChunks(ctx, result.summaryText);
      }

      await replyPlainInChunks(
        ctx,
        "Gunakan: /mochi check | /mochi quote <1-10> | /mochi mint <1-10>"
      );
    } catch (error) {
      await replyPlainInChunks(ctx, `Gagal memproses perintah MOCHI: ${error.message}`);
    }
  });

  // /pending - Lihat preview aktif
  bot.command("pending", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const active = previewStore.getForUser(ctx.from.id);
    if (!active) {
      return ctx.reply("Tidak ada preview transaksi yang sedang menunggu konfirmasi.");
    }
    const summary = mochiProtocolAdapter.summarizePreview({
      ...active.prepared,
      previewId: active.previewId,
      expiresAt: active.expiresAt,
    });
    await replyPlainInChunks(ctx, summary);
  });

  // /confirm [previewId] - Eksekusi 1 preview yang telah dikonfirmasi user secara eksplisit
  bot.command("confirm", async (ctx) => {
    if (!isAllowed(ctx)) return;
    if (killSwitch) {
      return ctx.reply("Kill switch sedang aktif. Eksekusi transaksi ditolak.");
    }
    const argId = ctx.message.text.replace(/^\/confirm(@\S+)?/i, "").trim() || null;

    try {
      await ctx.sendChatAction("typing");
      const confirmed = await toolRegistry.confirmAndExecuteForUser({
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        previewId: argId,
      });

      const { execution, action, shares, previewId } = confirmed;
      const lines = [
        `HASIL EKSEKUSI TRANSAKSI (${previewId})`,
        `Tindakan: ${action === "approve" ? "Approval USDT" : `Mint ${shares} share MOCHI`}`,
        `Status BAW: ${execution.status || "UNKNOWN"}`,
        ...(execution.orderId ? [`Order ID: ${execution.orderId}`] : []),
        ...(execution.txHash ? [`TxHash: ${execution.txHash}`] : []),
        ...(execution.txHash ? [`BscScan: https://bscscan.com/tx/${execution.txHash}`] : []),
        ...(execution.message ? [`Pesan: ${execution.message}`] : []),
        ...(action === "approve"
          ? [
              "",
              "Catatan: Approval USDT telah dikirim. Setelah transaksi approval terkonfirmasi di jaringan, minta preview mint MOCHI secara terpisah lalu konfirmasi kembali dengan /confirm.",
            ]
          : []),
      ];
      await replyPlainInChunks(ctx, lines.join("\n"));
    } catch (error) {
      await replyPlainInChunks(ctx, `Konfirmasi gagal: ${error.message}`);
    }
  });

  // /cancel [previewId] - Batalkan preview transaksi
  bot.command("cancel", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const argId = ctx.message.text.replace(/^\/cancel(@\S+)?/i, "").trim() || null;
    const cancelled = previewStore.cancelForUser(ctx.from.id, argId);
    if (!cancelled) {
      return ctx.reply("Tidak ada preview transaksi aktif yang cocok untuk dibatalkan.");
    }
    await ctx.reply(`Preview transaksi ${cancelled.previewId} (${cancelled.action}) telah dibatalkan.`);
  });

  // /killswitch [on|off]
  bot.command("killswitch", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const arg = ctx.message.text.replace(/^\/killswitch(@\S+)?/i, "").trim().toLowerCase();
    if (arg === "on") {
      killSwitch = true;
      previewStore.cancelForUser(ctx.from.id);
      return ctx.reply("Kill switch DIAKTIFKAN. Semua preview dibatalkan dan transaksi baru diblokir.");
    }
    if (arg === "off") {
      killSwitch = false;
      return ctx.reply("Kill switch DINONAKTIFKAN.");
    }
    return ctx.reply(`Status kill switch: ${killSwitch ? "AKTIF" : "NONAKTIF"}`);
  });

  // Handler pesan teks:
  // 1. Alamat 0x... murni -> scanner kontrak BNB Chain (read-only)
  // 2. Pesan chat / permintaan baca situs / cek eligibility / siapkan transaksi -> Gemini Agent Orchestrator dengan Function Calling
  bot.on("text", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const text = (ctx.message?.text || "").trim();
    if (!text || text.startsWith("/")) return;

    const exactAddrMatch = text.match(/^(0x[a-fA-F0-9]{40})$/);
    if (exactAddrMatch) {
      await ctx.sendChatAction("typing");
      const { report } = await inspectBscAddress(exactAddrMatch[1]);
      return replyInChunks(ctx, report);
    }

    try {
      const answer = await geminiOrchestrator.handleUserMessage({
        userId: ctx.from.id,
        chatId: ctx.chat.id,
        text,
        onTyping: () => ctx.sendChatAction("typing"),
      });
      await replyPlainInChunks(ctx, answer);
    } catch (error) {
      console.error("Gemini orchestrator request failed:", {
        name: error?.name || "UnknownError",
        status: error?.status || error?.code || null,
        message: redactText(error?.message || ""),
      });
      await ctx.reply(
        `Gagal memproses permintaan (${redactText(error?.message || "Unknown error")}). ` +
          `Anda tetap dapat menggunakan perintah langsung seperti /mochi check, /mochi mint 1, /status, atau /balance.`
      );
    }
  });

  return {
    bot,
    toolRegistry,
    previewStore,
    geminiOrchestrator,
    skillRegistry,
    skillLoader,
    start() {
      bot.launch({ dropPendingUpdates: true });
      console.log("✅ Web3 Telegram Agent (Gemini Tool Calling + BAW Direct Bridge) aktif!");
      return bot;
    },
  };
}

function startBot(options = {}) {
  const app = createBotApp(options);
  app.start();
  return app;
}

if (require.main === module) {
  startBot();
}

module.exports = {
  GEMINI_TOOL_DECLARATIONS,
  createBotApp,
  startBot,
  executeBaw,
  executeBawJson,
};
