const { Telegraf } = require("telegraf");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_LENGTH = 4000;
const BSC_RPC_URL = "https://bsc-dataseed.binance.org";

async function executeBaw(args = []) {
  try {
    const { stdout, stderr } = await execFileAsync("baw", args.map(String), {
      timeout: 45000,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
    });
    return (stdout || stderr || "Eksekusi selesai tanpa output.").trim();
  } catch (error) {
    return `Error CLI BAW: ${(error.stderr || error.message || "Unknown error").trim()}`;
  }
}

async function rpcCall(method, params = []) {
  const res = await fetch(BSC_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  return data.result;
}

// Fungsi Cek Detail Address (Kontrak / Token / Wallet Biasa) di BNB Chain
async function inspectBscAddress(address) {
  const addr = address.toLowerCase();
  const [balanceHex, codeHex, goplusRes, dexRes] = await Promise.allSettled([
    rpcCall("eth_getBalance", [addr, "latest"]),
    rpcCall("eth_getCode", [addr, "latest"]),
    fetch(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${addr}`, {
      signal: AbortSignal.timeout(10000),
    }).then((r) => r.json()),
    fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
      signal: AbortSignal.timeout(10000),
    }).then((r) => r.json()),
  ]);

  const bnbBalance =
    balanceHex.status === "fulfilled" && balanceHex.value
      ? (Number(BigInt(balanceHex.value)) / 1e18).toFixed(4)
      : "0.0000";

  const isContract =
    codeHex.status === "fulfilled" && codeHex.value && codeHex.value !== "0x" && codeHex.value !== "0x0";

  let report = `🔎 **Hasil Cek Address (BNB Chain)**\n`;
  report += `• Address: \`${address}\`\n`;
  report += `• Tipe: ${isContract ? "📄 Smart Contract" : "👤 Wallet Biasa (EOA)"}\n`;
  report += `• Saldo BNB: \`${bnbBalance} BNB\`\n`;

  // Data Keamanan dari GoPlus (Khusus Kontrak Token)
  if (isContract && goplusRes.status === "fulfilled") {
    const sec = goplusRes.value?.result?.[addr];
    if (sec) {
      const buyTax = sec.buy_tax ? `${(Number(sec.buy_tax) * 100).toFixed(1)}%` : "0%";
      const sellTax = sec.sell_tax ? `${(Number(sec.sell_tax) * 100).toFixed(1)}%` : "0%";
      const honeypot = sec.is_honeypot === "1" ? "🚨 YA (BAHAYA!)" : "✅ Aman (Bukan Honeypot)";
      const openSource = sec.is_open_source === "1" ? "✅ Verified" : "⚠️ Unverified";

      report += `\n🛡️ **Keamanan Kontrak (GoPlus):**\n`;
      if (sec.token_name || sec.token_symbol) {
        report += `• Token: **${sec.token_name || "?"} (${sec.token_symbol || "?"})**\n`;
      }
      report += `• Honeypot: ${honeypot}\n`;
      report += `• Tax Beli / Jual: \`${buyTax}\` / \`${sellTax}\`\n`;
      report += `• Source Code: ${openSource}\n`;
    }
  }

  // Data Harga & Likuiditas dari DexScreener
  if (isContract && dexRes.status === "fulfilled") {
    const bscPairs = (dexRes.value?.pairs || []).filter((p) => p.chainId === "bsc");
    if (bscPairs.length > 0) {
      const pair = bscPairs[0];
      report += `\n📈 **Info Market (${pair.dexId}):**\n`;
      report += `• Harga: \`$${pair.priceUsd || "0"}\`\n`;
      report += `• Likuiditas: \`$${Number(pair.liquidity?.usd || 0).toLocaleString("en-US")}\`\n`;
      report += `• FDV / MCap: \`$${Number(pair.fdv || 0).toLocaleString("en-US")}\`\n`;
    }
  }

  report += `\n🔗 [Lihat di BscScan](https://bscscan.com/address/${address})\n`;

  if (isContract) {
    report += `\n⚡ **Aksi Cepat:**\n`;
    report += `• Mint: \`/mint ${address} mint() 0\`\n`;
    report += `• Buy: \`/swap 0.005 ${address}\`\n`;
    report += `• Sell: \`/sell ${address} all\``;
  }

  return report;
}

async function fetchContractFromUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const matches = html.match(/0x[a-fA-F0-9]{40}/g);
    return matches ? [...new Set(matches)] : [];
  } catch {
    return [];
  }
}

function getAllowedUserIds(value = "") {
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS harus berupa angka ID Telegram.");
  }
  return new Set(ids.map(Number));
}

async function replyInChunks(ctx, text) {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += MAX_MESSAGE_LENGTH) {
    await ctx.reply(chars.slice(i, i + MAX_MESSAGE_LENGTH).join(""), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }).catch(() => ctx.reply(chars.slice(i, i + MAX_MESSAGE_LENGTH).join("")));
  }
}

function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum diatur.");

  const allowedUsers = getAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  const bot = new Telegraf(token);
  const pendingActions = new Map();

  const isAllowed = (ctx) => ctx.chat?.type === "private" && ctx.from && allowedUsers.has(ctx.from.id);

  bot.command("id", async (ctx) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return;
    await ctx.reply(`Telegram User ID Anda: \`${ctx.from.id}\``, { parse_mode: "Markdown" });
  });

  bot.command("start", async (ctx) => {
    if (!isAllowed(ctx)) return ctx.reply(`Akses ditolak. ID Anda: ${ctx.from?.id}`);
    await replyInChunks(
      ctx,
      "🚀 **Bot Binance Agentic Direct Bridge**\n\n" +
        "⚡ **Perintah Dompet & Cek Address:**\n" +
        "• `/address` - Cek alamat dompet BAW Anda sendiri\n" +
        "• `/cek <0x...>` - Cek kontrak/token/wallet di BNB Chain (Honeypot, Tax, Likuiditas, Saldo)\n" +
        "• `/status` - Cek koneksi wallet\n" +
        "• `/balance` - Cek saldo dompet BAW Anda\n" +
        "• `/settings` - Cek pengaturan & Developer Mode\n\n" +
        "🔥 **Perintah Eksekusi:**\n" +
        "• `/mint <0x_kontrak> <fungsi> [bnb]` - Eksekusi mint\n" +
        "• `/swap <bnb> <0x_kontrak>` - Beli / Swap token\n" +
        "• `/sell <0x_kontrak> all` - Jual token ke BNB\n" +
        "• `/confirm` - Jalankan transaksi tertunda\n" +
        "• `/cancel` - Batalkan transaksi\n\n" +
        "💡 **Tips Cepat:** Paste langsung alamat `0x...` atau link `https://...` ke chat untuk langsung dipindai otomatis!"
    );
  });

  // Cek Address Dompet BAW Sendiri
  bot.command("address", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await executeBaw(["wallet", "address", "--json"]);
    const match = out.match(/0x[a-fA-F0-9]{40}/);
    const cleanAddr = match ? `\n\nTap untuk salin: \`${match[0]}\`\n🔗 [BscScan](https://bscscan.com/address/${match[0]})` : "";
    await replyInChunks(ctx, `📍 **Alamat Dompet BAW Anda:**\n\`\`\`json\n${out}\n\`\`\`${cleanAddr}`);
  });

  // Cek Address Eksternal (Kontrak Token / NFT / Wallet Orang)
  bot.command("cek", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const target = ctx.message.text.replace("/cek", "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(target)) {
      return ctx.reply("Format salah! Gunakan: `/cek 0xAlamatKontrakAtauWallet`", { parse_mode: "Markdown" });
    }
    await ctx.sendChatAction("typing");
    const report = await inspectBscAddress(target);
    await replyInChunks(ctx, report);
  });

  bot.command("status", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await executeBaw(["wallet", "status", "--json"]);
    await replyInChunks(ctx, `📡 **Status Wallet:**\n\`\`\`json\n${out}\n\`\`\``);
  });

  bot.command("balance", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await executeBaw(["wallet", "balance", "--json"]);
    await replyInChunks(ctx, `💰 **Saldo Wallet:**\n\`\`\`json\n${out}\n\`\`\``);
  });

  bot.command("settings", async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.sendChatAction("typing");
    const out = await executeBaw(["wallet", "settings", "--json"]);
    await replyInChunks(ctx, `⚙️ **Wallet Settings:**\n\`\`\`json\n${out}\n\`\`\``);
  });

  bot.command("confirm", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const action = pendingActions.get(ctx.from.id);
    if (!action) return ctx.reply("❌ Tidak ada transaksi yang menunggu konfirmasi.");

    pendingActions.delete(ctx.from.id);
    await ctx.reply(`⚡ Mengeksekusi: baw ${action.join(" ")} ...`);
    const out = await executeBaw(action);
    await replyInChunks(ctx, `📋 **Hasil Eksekusi:**\n\`\`\`\n${out}\n\`\`\``);
  });

  bot.command("cancel", async (ctx) => {
    if (!isAllowed(ctx)) return;
    pendingActions.delete(ctx.from.id);
    await ctx.reply("🚫 Transaksi dibatalkan.");
  });

  bot.command("mint", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const text = ctx.message.text.replace("/mint", "").trim();
    const args = text.split(/\s+/);
    if (args.length < 1 || !args[0].startsWith("0x")) {
      return replyInChunks(ctx, "Format salah!\nGunakan: `/mint <0x_kontrak> [fungsi] [value_bnb]`\nContoh: `/mint 0x123... mint() 0`");
    }
    const contract = args[0];
    const func = args[1] || "mint()";
    const val = args[2] || "0";

    const bawArgs = ["contract-call", "--address", contract, "--data", func, "--value", val, "--json"];
    pendingActions.set(ctx.from.id, bawArgs);
    await replyInChunks(
      ctx,
      `⚠️ **Preview Transaksi Mint**\n` +
        `• Kontrak: \`${contract}\`\n` +
        `• Fungsi: \`${func}\`\n` +
        `• Value: \`${val} BNB\`\n\n` +
        `Ketik **\`/confirm\`** untuk mengeksekusi, atau **\`/cancel\`** untuk batal.`
    );
  });

  bot.command("swap", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const text = ctx.message.text.replace("/swap", "").trim();
    const args = text.split(/\s+/);
    if (args.length < 2) {
      return replyInChunks(ctx, "Format salah!\nGunakan: `/swap <jumlah_bnb> <0x_kontrak_token>`");
    }
    const amount = args[0];
    const token = args[1];

    const bawArgs = ["swap", "--amount", amount, "--token", token, "--json"];
    pendingActions.set(ctx.from.id, bawArgs);
    await replyInChunks(
      ctx,
      `⚠️ **Preview Swap / Buy**\n` +
        `• Beli senilai: \`${amount} BNB\`\n` +
        `• Token: \`${token}\`\n\n` +
        `Ketik **\`/confirm\`** untuk mengeksekusi, atau **\`/cancel\`** untuk batal.`
    );
  });

  bot.command("sell", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const text = ctx.message.text.replace("/sell", "").trim();
    const args = text.split(/\s+/);
    if (args.length < 1 || !args[0].startsWith("0x")) {
      return replyInChunks(ctx, "Format salah!\nGunakan: `/sell <0x_kontrak_token> [jumlah/all]`");
    }
    const token = args[0];
    const amount = args[1] || "all";

    const bawArgs = ["swap", "--sell", token, "--amount", amount, "--json"];
    pendingActions.set(ctx.from.id, bawArgs);
    await replyInChunks(
      ctx,
      `⚠️ **Preview Sell**\n` +
        `• Jual Token: \`${token}\`\n` +
        `• Jumlah: \`${amount}\`\n\n` +
        `Ketik **\`/confirm\`** untuk mengeksekusi, atau **\`/cancel\`** untuk batal.`
    );
  });

  // Handler otomatis saat user paste Address (0x...) atau URL Website langsung di chat
  bot.on("text", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    // 1. Jika user langsung paste alamat 0x... di chat -> otomatis cek address tersebut!
    const exactAddrMatch = text.match(/^(0x[a-fA-F0-9]{40})$/);
    if (exactAddrMatch) {
      await ctx.sendChatAction("typing");
      const report = await inspectBscAddress(exactAddrMatch[1]);
      return replyInChunks(ctx, report);
    }

    // 2. Jika user kirim link website -> tarik alamat 0x... dan langsung cek kontrak utamanya
    if (text.startsWith("http://") || text.startsWith("https://")) {
      await ctx.sendChatAction("typing");
      await ctx.reply(`🔍 Memindai kontrak dari URL: ${text} ...`);

      const addresses = await fetchContractFromUrl(text);
      if (addresses.length === 0) {
        return ctx.reply(`❌ Tidak ditemukan alamat kontrak (0x...) di halaman HTML statis web tersebut.`);
      }

      let msg = `✅ **Ditemukan ${addresses.length} Alamat Kontrak di Web:**\n`;
      addresses.slice(0, 3).forEach((addr, i) => {
        msg += `${i + 1}. \`${addr}\`\n`;
      });
      await replyInChunks(ctx, msg);

      // Otomatis cek detail alamat kontrak pertama yang ditemukan
      const firstContractReport = await inspectBscAddress(addresses[0]);
      await replyInChunks(ctx, firstContractReport);
    }
  });

  bot.launch({ dropPendingUpdates: true });
  console.log("✅ Bot Zero-Gimmick + Address Scanner AKTIF!");
}

if (require.main === module) {
  startBot();
}