const { Telegraf } = require("telegraf");
const { inspectBscAddress } = require("../wallet/bscScanner");
const {
  formatMochiStats,
  formatPendingTransaction,
} = require("./formatters");
const { redactText } = require("../security/redactor");

const MAX_MESSAGE_LENGTH = 3900;

async function replyInChunks(ctx, text) {
  const safeText = redactText(String(text || ""));
  const chars = Array.from(safeText);
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

function getHelpMessage() {
  return (
    `🤖 **Universal Binance Agentic Wallet Automation Engine**\n\n` +
    `📌 **Core & Wallet Commands (Deterministic / 0 AI Token):**\n` +
    `• \`/start\` — Inisialisasi bot\n` +
    `• \`/help\` — Daftar seluruh command\n` +
    `• \`/status\` — Status seluruh komponen (BAW, Agent ID, DevMode, AI, Skills)\n` +
    `• \`/wallet\` — Informasi lengkap wallet, address, & .ai Agent ID\n` +
    `• \`/balance [symbol]\` — Cek saldo semua aset (termasuk token baru)\n` +
    `• \`/chains\` — Daftar jaringan blockchain yang didukung\n` +
    `• \`/history\` — Riwayat aktivitas & transaksi on-chain\n` +
    `• \`/auth\` — Mulai sesi login QR BAW baru\n` +
    `• \`/verify <qrCodeId>\` — Verifikasi login QR BAW\n\n` +
    `🍡 **MOCHI Free & Paid Mint Adapter:**\n` +
    `• \`/mochi\` atau \`/mochi stats\` — Statistik live MOCHI\n` +
    `• \`/mochi check\` — Cek eligibility .ai Agent ID & kuota free share\n` +
    `• \`/mochi quote <shares>\` — Kalkulasi biaya & calldata (1–10 shares)\n` +
    `• \`/mochi mint <shares>\` — Simulasi preview BAW & buat ID approval\n` +
    `• \`/mochi history\` — Riwayat mint MOCHI terbaru di BSC\n\n` +
    `🧩 **Universal Skill Loader & Multi-Project:**\n` +
    `• \`/skills\` — Daftar skill yang terdaftar di registry\n` +
    `• \`/addskill <url>\` — Import & validasi SKILL.md / website baru\n` +
    `• \`/removeskill <name>\` — Hapus skill dari registry\n` +
    `• \`/check <project>\` — Cek eligibility project (contoh: \`/check mochi\`)\n` +
    `• \`/quote <project> <amount>\` — Estimasi biaya (contoh: \`/quote mochi 1\`)\n\n` +
    `🛡️ **Transaction Guard & Security:**\n` +
    `• \`/pending\` — Daftar transaksi menunggu persetujuan\n` +
    `• \`/confirm <id>\` — Setujui & eksekusi transaksi berdasarkan ID\n` +
    `• \`/cancel [id]\` — Batalkan transaksi pending\n` +
    `• \`/cek <0x...>\` — Audit keamanan kontrak (GoPlus + DexScreener)\n` +
    `• \`/killswitch [on|off]\` — Kunci darurat seluruh transaksi\n\n` +
    `🧠 **AI Reasoning Layer:**\n` +
    `• \`/task <instruksi>\` — Jalankan instruksi bahasa alami\n` +
    `💡 *Tips:* Anda juga dapat langsung menempelkan alamat \`0x...\` atau URL \`https://...\` ke chat!`
  );
}

function createTelegramBot({ config, security, orchestrator }) {
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN belum diatur di environment atau file .env.");
  }

  const bot = new Telegraf(config.telegramBotToken);

  const ensureAuthorized = async (ctx) => {
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    if (!security.isUserAllowed(userId, chatType)) {
      security.logAudit("UNAUTHORIZED_ACCESS_BLOCKED", {
        userId,
        username: ctx.from?.username,
        chatType,
        text: ctx.message?.text,
      });
      await ctx.reply(
        `⛔ Akses ditolak. Telegram User ID Anda (\`${userId}\`) belum terdaftar di TELEGRAM_ALLOWED_USER_IDS (atau bukan di Private Chat).`,
        { parse_mode: "Markdown" }
      );
      return false;
    }
    return true;
  };

  const safeHandler = (fn) => async (ctx) => {
    if (!(await ensureAuthorized(ctx))) return;
    try {
      await ctx.sendChatAction("typing").catch(() => {});
      await fn(ctx);
    } catch (err) {
      security.logAudit("COMMAND_ERROR", {
        userId: ctx.from?.id,
        error: err.message,
      });
      await replyInChunks(ctx, `❌ **Error:** ${err.message || "Terjadi kesalahan internal."}`);
    }
  };

  // /id (Bisa diakses untuk mengetahui Telegram User ID sendiri di private chat)
  bot.command("id", async (ctx) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return;
    await ctx.reply(`🆔 Telegram User ID Anda: \`${ctx.from.id}\``, {
      parse_mode: "Markdown",
    });
  });

  bot.command("start", safeHandler(async (ctx) => {
    await replyInChunks(ctx, getHelpMessage());
  }));

  bot.command("help", safeHandler(async (ctx) => {
    await replyInChunks(ctx, getHelpMessage());
  }));

  bot.command("status", safeHandler(async (ctx) => {
    const msg = await orchestrator.getSystemStatus();
    await replyInChunks(ctx, msg);
  }));

  bot.command(["wallet", "address", "settings"], safeHandler(async (ctx) => {
    const msg = await orchestrator.getWalletInfo();
    await replyInChunks(ctx, msg);
  }));

  bot.command("balance", safeHandler(async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const symbol = parts[1] || null;
    const msg = await orchestrator.getBalances(symbol);
    await replyInChunks(ctx, msg);
  }));

  bot.command("chains", safeHandler(async (ctx) => {
    const msg = await orchestrator.getSupportedChains();
    await replyInChunks(ctx, msg);
  }));

  bot.command("skills", safeHandler(async (ctx) => {
    const msg = orchestrator.listSkillsFormatted();
    await replyInChunks(ctx, msg);
  }));

  bot.command("addskill", safeHandler(async (ctx) => {
    const url = ctx.message.text.replace(/^\/addskill(@\S+)?/i, "").trim();
    if (!url) {
      return replyInChunks(
        ctx,
        "Format: `/addskill <https://example.xyz/SKILL.md>`\nContoh: `/addskill https://agenticmochi.xyz/skill.md`"
      );
    }
    await ctx.reply(`📥 Mengambil & memvalidasi dokumentasi skill dari \`${url}\` ...`, {
      parse_mode: "Markdown",
    });
    const msg = await orchestrator.addSkillFromUrl(url);
    await replyInChunks(ctx, msg);
  }));

  bot.command("removeskill", safeHandler(async (ctx) => {
    const name = ctx.message.text.replace(/^\/removeskill(@\S+)?/i, "").trim();
    if (!name) {
      return replyInChunks(ctx, "Format: `/removeskill <nama_skill>`");
    }
    const removed = orchestrator.skillRegistry.removeSkill(name);
    if (!removed) {
      return replyInChunks(ctx, `❌ Skill "${name}" tidak ditemukan di registry.`);
    }
    await replyInChunks(ctx, `🗑️ Skill **${name}** berhasil dihapus dari registry.`);
  }));

  bot.command("check", safeHandler(async (ctx) => {
    const args = ctx.message.text.replace(/^\/check(@\S+)?/i, "").trim().split(/\s+/).filter(Boolean);
    const project = args[0] || "mochi";
    const explicitAddr = args[1] || null;
    const msg = await orchestrator.checkProjectEligibility(project, explicitAddr);
    await replyInChunks(ctx, msg);
  }));

  bot.command("quote", safeHandler(async (ctx) => {
    const args = ctx.message.text.replace(/^\/quote(@\S+)?/i, "").trim().split(/\s+/).filter(Boolean);
    const project = args[0] || "mochi";
    const amount = Number(args[1] || 1);
    const msg = await orchestrator.getProjectQuote(project, amount);
    await replyInChunks(ctx, msg);
  }));

  // /mochi & subcommands: stats, check, quote, mint, history
  bot.command("mochi", safeHandler(async (ctx) => {
    const rawArgs = ctx.message.text.replace(/^\/mochi(@\S+)?/i, "").trim().split(/\s+/).filter(Boolean);
    const sub = (rawArgs[0] || "stats").toLowerCase();

    if (sub === "stats") {
      const stats = await orchestrator.mochiAdapter.getStats();
      return replyInChunks(ctx, formatMochiStats(stats));
    }

    if (sub === "check") {
      const explicitAddr = rawArgs[1] || null;
      const msg = await orchestrator.checkProjectEligibility("mochi", explicitAddr);
      return replyInChunks(ctx, msg);
    }

    if (sub === "quote") {
      const shares = Number(rawArgs[1] || 1);
      const msg = await orchestrator.getProjectQuote("mochi", shares);
      return replyInChunks(ctx, msg);
    }

    if (sub === "mint") {
      const shares = Number(rawArgs[1] || 1);
      await ctx.reply(`⏳ Menyiapkan simulasi & preview BAW untuk mint **${shares} share MOCHI**...`, {
        parse_mode: "Markdown",
      });
      const msg = await orchestrator.prepareMochiMint(shares, ctx.from.id);
      return replyInChunks(ctx, msg);
    }

    if (sub === "history") {
      const addr = await orchestrator.walletService.getAddressForChain("56");
      const hist = await orchestrator.mochiAdapter.getHistory(addr, 15);
      let msg = `📜 **MOCHI On-Chain Mint Activity**\n`;
      msg += `• Total Mints Tercatat: \`${hist.count || 0}\` (\`${hist.totalShares || 0} shares\` | \`${hist.totalUsdt || 0} USDT\`)\n\n`;

      if (hist.myMints && hist.myMints.length > 0) {
        msg += `👤 **Riwayat Mint Wallet Anda (${addr}):**\n`;
        for (const m of hist.myMints.slice(0, 5)) {
          msg += `• \`${m.shares} share\` (\`${m.cost} USDT\`) -> \`${m.tokens} MOCHI\` | [Tx](https://bscscan.com/tx/${m.txHash})\n`;
        }
        msg += `\n`;
      }

      msg += `🌐 **5 Mint Terbaru Global:**\n`;
      for (const m of (hist.mints || []).slice(0, 5)) {
        msg += `• \`${m.buyer.slice(0, 8)}...${m.buyer.slice(-4)}\`: \`${m.shares} share\` (\`${m.cost} USDT\`) | [Tx](https://bscscan.com/tx/${m.txHash})\n`;
      }
      return replyInChunks(ctx, msg);
    }

    return replyInChunks(
      ctx,
      "Subcommand `/mochi` yang tersedia:\n" +
        "• `/mochi stats`\n" +
        "• `/mochi check`\n" +
        "• `/mochi quote <shares>`\n" +
        "• `/mochi mint <shares>`\n" +
        "• `/mochi history`"
    );
  }));

  bot.command("pending", safeHandler(async (ctx) => {
    const list = orchestrator.txGuard.listPendingForUser(ctx.from.id);
    if (list.length === 0) {
      return replyInChunks(ctx, "✅ Tidak ada transaksi yang menunggu persetujuan saat ini.");
    }
    let msg = `⏳ **Daftar Transaksi Menunggu Persetujuan (${list.length}):**\n\n`;
    for (const item of list) {
      msg += formatPendingTransaction(item) + "\n\n---\n\n";
    }
    await replyInChunks(ctx, msg.trim());
  }));

  bot.command("confirm", safeHandler(async (ctx) => {
    const txId = ctx.message.text.replace(/^\/confirm(@\S+)?/i, "").trim();
    await ctx.reply(`⚡ Memproses eksekusi transaksi yang disetujui...`);
    const msg = await orchestrator.confirmTransaction(txId, ctx.from.id, ctx.chat.id);
    await replyInChunks(ctx, msg);
  }));

  bot.command("cancel", safeHandler(async (ctx) => {
    const txId = ctx.message.text.replace(/^\/cancel(@\S+)?/i, "").trim();
    const count = orchestrator.txGuard.cancelPending(txId || null, ctx.from.id);
    if (count === 0) {
      return replyInChunks(ctx, "ℹ️ Tidak ada transaksi pending yang cocok untuk dibatalkan.");
    }
    await replyInChunks(ctx, `🚫 Berhasil membatalkan **${count}** transaksi pending.`);
  }));

  bot.command("history", safeHandler(async (ctx) => {
    const [txRes, localHistory] = await Promise.all([
      orchestrator.walletService.getTxHistory({ size: 10 }),
      Promise.resolve(orchestrator.txMonitor ? orchestrator.txMonitor.getRecentActivity(10) : []),
    ]);

    let msg = `📜 **Riwayat Aktivitas & Transaksi Wallet**\n\n`;
    if (localHistory.length > 0) {
      msg += `⚡ **Aktivitas Engine Lokal Terbaru:**\n`;
      for (const act of localHistory.slice(0, 5)) {
        msg += `• \`${act.timestamp}\` — **${act.type}**: ${act.title || act.txId || ""}\n`;
      }
      msg += `\n`;
    }

    const txs = txRes.data?.transactions || [];
    if (txs.length > 0) {
      msg += `⛓️ **Riwayat On-Chain BAW (10 Terbaru):**\n`;
      for (const t of txs.slice(0, 10)) {
        msg += `• **${t.txType || "tx"}** (\`${t.status}\`) — Chain \`${t.binanceChainId}\`\n`;
        msg += `  Hash: \`${t.txHash}\`\n`;
        msg += `  Waktu: \`${t.txTime || "-"}\`\n`;
      }
    } else {
      msg += `ℹ️ Belum ada riwayat transaksi on-chain yang dikembalikan oleh BAW CLI.`;
    }

    await replyInChunks(ctx, msg);
  }));

  bot.command("task", safeHandler(async (ctx) => {
    const instruction = ctx.message.text.replace(/^\/task(@\S+)?/i, "").trim();
    if (!instruction) {
      return replyInChunks(
        ctx,
        "Format: `/task <instruksi bahasa alami>`\nContoh:\n• `/task cek apakah wallet saya eligible untuk free mint mochi`\n• `/task siapkan mint 1 share mochi`"
      );
    }
    const msg = await orchestrator.handleNaturalLanguageTask(instruction, ctx.from.id);
    await replyInChunks(ctx, msg);
  }));

  bot.command("cek", safeHandler(async (ctx) => {
    const target = ctx.message.text.replace(/^\/cek(@\S+)?/i, "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(target)) {
      return replyInChunks(ctx, "Format: `/cek 0xAlamatKontrakAtauWallet`");
    }
    const res = await inspectBscAddress(target, config.bscRpcUrl);
    await replyInChunks(ctx, res.report);
  }));

  bot.command("auth", safeHandler(async (ctx) => {
    const res = await orchestrator.walletService.authSignIn();
    if (!res.ok) {
      return replyInChunks(ctx, `❌ Gagal memulai auth signin: \`${res.error?.message || res.raw}\``);
    }
    if (res.data?.status === "ALREADY_CONNECTED") {
      return replyInChunks(ctx, "✅ Wallet BAW sudah terhubung (`ALREADY_CONNECTED`).");
    }
    const { pairingCode, urlForWeb, qrCodeId } = res.data || {};
    await replyInChunks(
      ctx,
      `🔐 **BAW Wallet Sign-In**\n\n` +
        `1. **Pairing Code (Wajib Cocok):** \`${pairingCode}\`\n` +
        `2. **Buka Link QR di Browser:**\n${urlForWeb}\n` +
        `3. Scan & setujui di **Binance App (Web3 Wallet)**.\n` +
        `4. Setelah memulai scan, jalankan:\n\`/verify ${qrCodeId}\``
    );
  }));

  bot.command("verify", safeHandler(async (ctx) => {
    const qrCodeId = ctx.message.text.replace(/^\/verify(@\S+)?/i, "").trim();
    if (!qrCodeId) {
      return replyInChunks(ctx, "Format: `/verify <qrCodeId>`");
    }
    await ctx.reply("⏳ Menunggu konfirmasi dari Binance App (maksimal 5 menit)...");
    const res = await orchestrator.walletService.authVerify(qrCodeId);
    if (!res.ok) {
      return replyInChunks(ctx, `❌ Verifikasi gagal: \`${res.error?.message || res.raw}\``);
    }
    await replyInChunks(ctx, `✅ **Login BAW Berhasil!** Status: \`${res.data?.status || "SUCCESS"}\`\nKetik \`/wallet\` untuk melihat detail dompet Anda.`);
  }));

  bot.command("killswitch", safeHandler(async (ctx) => {
    const arg = ctx.message.text.replace(/^\/killswitch(@\S+)?/i, "").trim().toLowerCase();
    if (arg === "on" || arg === "true" || arg === "1") {
      security.setKillSwitch(true, ctx.from.id);
      orchestrator.txGuard.cancelPending(null, ctx.from.id);
      return replyInChunks(ctx, "🛑 **KILL SWITCH DIAKTIFKAN!** Seluruh transaksi pending dibatalkan dan eksekusi baru dikunci.");
    }
    if (arg === "off" || arg === "false" || arg === "0") {
      security.setKillSwitch(false, ctx.from.id);
      return replyInChunks(ctx, "🟢 **Kill Switch Dinonaktifkan.** Sistem kembali normal.");
    }
    return replyInChunks(
      ctx,
      `Status Kill Switch saat ini: **${security.isKillSwitchActive() ? "🛑 AKTIF" : "🟢 NONAKTIF"}**\nGunakan \`/killswitch on\` atau \`/killswitch off\`.`
    );
  }));

  // Handler otomatis saat user paste Address (0x...) atau URL Website/SKILL.md langsung di chat
  bot.on("text", safeHandler(async (ctx) => {
    const text = (ctx.message?.text || "").trim();
    if (!text || text.startsWith("/")) return;

    // 1. Jika user langsung paste alamat 0x... -> jalankan BSC Security Scanner
    const exactAddrMatch = text.match(/^(0x[a-fA-F0-9]{40})$/);
    if (exactAddrMatch) {
      const scan = await inspectBscAddress(exactAddrMatch[1], config.bscRpcUrl);
      return replyInChunks(ctx, scan.report);
    }

    // 2. Jika user kirim link https://... -> jalankan Universal Skill Loader & Contract Scanner
    if (text.startsWith("https://") || text.startsWith("http://")) {
      await ctx.reply(`🔍 Memproses URL melalui **Universal Skill Loader**: \`${text}\` ...`, {
        parse_mode: "Markdown",
      });
      const skillReport = await orchestrator.addSkillFromUrl(text);
      return replyInChunks(ctx, skillReport);
    }
  }));

  return bot;
}

module.exports = {
  createTelegramBot,
  replyInChunks,
  getHelpMessage,
};
