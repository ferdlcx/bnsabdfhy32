/**
 * Formatter pesan Telegram yang rapi, menampilkan full contract address (tidak dipotong),
 * dan memformat nilai USD dengan 2 desimal sesuai aturan resmi BAW SKILL.md.
 */

function formatUsd(value) {
  const num = Number(value || 0);
  if (Number.isNaN(num) || num === 0) return "$0.00";
  if (num > 0 && num < 0.01) return `$${value}`;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatWalletOverview({ statusRes, addressRes, agentIdRes, settingsRes }) {
  const status = statusRes?.data?.status || (statusRes?.ok ? "CONNECTED" : "UNCONNECTED");
  const addresses = addressRes?.addresses || [];
  const agentData = agentIdRes?.data || {};
  const settings = settingsRes?.data || {};
  const devMode = settings.devMode || {};

  let msg = `👛 **Binance Agentic Wallet Overview**\n\n`;
  msg += `• **Status Koneksi:** \`${status}\`\n`;

  if (agentData.claimed) {
    msg += `• **.ai Agent ID:** ✅ \`${agentData.agentId || agentData.handle + ".ai"}\`\n`;
  } else {
    msg += `• **.ai Agent ID:** ❌ Belum diklaim (Klaim di Binance App -> Web3 -> Agent ID)\n`;
  }

  msg += `• **Developer Mode:** ${
    settingsRes?.devModeReady
      ? "✅ Aktif"
      : "⚠️ Nonaktif / Kedaluwarsa (Aktifkan di Binance App -> Settings)"
  }\n`;

  if (settings.quotaLeft !== undefined) {
    msg += `• **Sisa Kuota Harian:** \`${formatUsd(settings.quotaLeft)}\` / \`${formatUsd(settings.dailyLimit)}\`\n`;
  }
  if (settings.sessionExpireTime) {
    msg += `• **Sesi Berakhir:** \`${settings.sessionExpireTime}\`\n`;
  }

  if (addresses.length > 0) {
    msg += `\n📍 **Daftar Alamat Wallet:**\n`;
    for (const item of addresses) {
      msg += `• **${item.chainName || item.binanceChainId} (${item.binanceChainId}):**\n  \`${item.address}\`\n`;
    }
  } else if (addressRes?.bscAddress) {
    msg += `\n📍 **BSC Address (Chain 56):**\n\`${addressRes.bscAddress}\`\n`;
  }

  return msg;
}

function formatBalances(balanceRes) {
  if (!balanceRes.ok) {
    return `❌ **Gagal membaca saldo:**\n\`${balanceRes.error?.message || balanceRes.raw}\``;
  }

  const items = Array.isArray(balanceRes.data) ? balanceRes.data : [];
  if (items.length === 0) {
    return `💰 **Saldo Wallet:**\nTidak ada token dengan saldo > 0 yang ditemukan.`;
  }

  let msg = `💰 **Saldo Aset Binance Agentic Wallet**\n\n`;
  for (const token of items) {
    const valStr =
      token.value && token.value !== "0" ? formatUsd(token.value) : "Harga belum tercatat";
    msg += `• **${token.symbol}** (Chain \`${token.binanceChainId}\`)\n`;
    msg += `  Saldo: \`${token.balance}\` (${valStr})\n`;
    msg += `  Contract: \`${token.address}\`\n\n`;
  }
  return msg.trim();
}

function formatMochiStats(stats) {
  const freeLeft =
    stats.freeSharesRemaining !== undefined
      ? stats.freeSharesRemaining
      : Math.max(0, Number(stats.freeShareCap || 5000) - Number(stats.freeSharesGiven || 0));
  const priceUsdt = (Number(BigInt(stats.pricePerShare || "1000000000000000000")) / 1e18).toFixed(2);
  const perShare = (Number(BigInt(stats.tokensPerShare || "21000000000000000000000000") / 10n ** 18n)).toLocaleString("en-US");

  return (
    `🍡 **MOCHI Live Stats (BNB Smart Chain - 56)**\n\n` +
    `• **Status Mint:** ${stats.mintOpen && !stats.paused ? "✅ OPEN" : "🔴 CLOSED / PAUSED"}\n` +
    `• **Settlement:** ${stats.instantDelivery ? "⚡ Instant (Langsung masuk di tx yang sama)" : "Claimable"}\n` +
    `• **Total Terjual:** \`${stats.sold} / ${stats.totalShares} shares\` (Sisa: \`${stats.remainingShares}\`)\n` +
    `• **Alokasi Free Share:** \`${freeLeft} / ${stats.freeShareCap} tersisa\` (${
      stats.freeSharePoolExhausted ? "Habis" : "✅ Tersedia"
    })\n` +
    `• **Harga per Share:** \`${priceUsdt} USDT\` (Share #1 GRATIS untuk pemilik .ai Agent ID)\n` +
    `• **Reward per Share:** \`${perShare} MOCHI\`\n` +
    `• **Kuota per Agent ID:** \`Max ${stats.baseQuota} shares\` (Max \`${stats.maxPerTx}\` per tx)\n\n` +
    `📄 **Kontrak Resmi (Full Address):**\n` +
    `• Mint Contract: \`${stats.contract}\`\n` +
    `• MOCHI Token: \`${stats.token}\`\n` +
    `• Payment USDT: \`${stats.paymentToken}\``
  );
}

function formatMochiEligibility(verify) {
  const statusIcon = verify.eligible ? "✅ ELIGIBLE (Memenuhi Syarat)" : "❌ NOT ELIGIBLE";
  const agentLabel = verify.handle
    ? `${verify.handle}.ai (ID: ${verify.agentId})`
    : verify.agentId || "Tidak memiliki .ai Agent ID";

  let msg = `🔍 **MOCHI Eligibility Check**\n\n`;
  msg += `• **Wallet:** \`${verify.address}\`\n`;
  msg += `• **Status:** **${statusIcon}**\n`;
  msg += `• **Agent ID:** \`${agentLabel}\`\n`;
  if (verify.reasons && verify.reasons.length > 0) {
    msg += `• **Alasan:** \`${verify.reasons.join(", ")}\`\n`;
  }
  msg += `• **Kuota Tersisa:** \`${verify.quotaRemaining} / ${verify.quotaTotal} shares\`\n`;
  msg += `• **Free First Share:** ${
    verify.firstShareFree || verify.freeShareAvailable
      ? "🎁 **TERSEDIA (0 USDT untuk share pertama!)**"
      : "Sudah digunakan / Tidak tersedia"
  }\n`;
  msg += `• **Biaya Share Pertama Berikutnya:** \`${verify.firstShareCost} USDT\`\n`;
  msg += `• **Saldo USDT Terdeteksi:** \`${ Number(verify.usdt || 0).toFixed(4)} USDT\`\n`;
  msg += `• **Allowance USDT ke Mint Contract:** \`${verify.allowance} USDT\`\n\n`;

  if (verify.eligible && Number(verify.quotaRemaining) > 0) {
    msg += `💡 Ketik \`/mochi quote 1\` untuk cek estimasi atau \`/mochi mint 1\` untuk menyiapkan transaksi mint.`;
  }
  return msg;
}

function formatMochiQuote(quote) {
  return (
    `🧮 **MOCHI Mint Quote (${quote.shares} Share${quote.shares > 1 ? "s" : ""})**\n\n` +
    `• **Jumlah Share:** \`${quote.shares}\` (${quote.freeSharesApplied} Free + ${quote.paidShares} Paid)\n` +
    `• **Total Biaya:** \`${quote.costUsdt} USDT\`\n` +
    `• **Max Cost (Slippage Cap):** \`${quote.maxCostUsdt} USDT\` (\`${quote.maxCostWei} wei\`)\n` +
    `• **Estimasi Token Diterima:** \`${quote.tokensOut} MOCHI\` (Instant Delivery)\n` +
    `• **Perlu USDT Approve:** ${quote.needsApproval ? "Ya (Otomatis disiapkan di Step 1)" : "Tidak (Langsung Mint)"}\n\n` +
    `📄 **Kontrak Tujuan:**\n` +
    `• Mint Contract: \`0x045398ef956b4787c782f77319ab0a20cb637da0\`\n` +
    `• Selector: \`0x836a1040\` (\`mint(uint256,address,uint256)\`)\n\n` +
    `💡 Ketik \`/mochi mint ${quote.shares}\` untuk melakukan simulasi preview BAW dan meminta ID konfirmasi.`
  );
}

function formatPendingTransaction(record) {
  const ttlSec = Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000));
  let msg = `🛡️ **TRANSACTION PREVIEW & APPROVAL REQUIRED**\n\n`;
  msg += `• **Transaction ID:** \`${record.txId}\`\n`;
  msg += `• **Project / Aksi:** **${record.title}**\n`;
  msg += `• **Wallet Pengirim:** \`${record.walletAddress}\`\n`;
  msg += `• **Chain ID:** \`${record.chainId}\`\n`;
  msg += `• **Estimasi Biaya:** \`${formatUsd(record.estimatedSpendUsd)} USDT\`\n`;

  if (record.summary?.tokensReceived) {
    msg += `• **Aset Diterima:** \`${record.summary.tokensReceived}\`\n`;
  }

  msg += `\n📋 **Tahapan Eksekusi On-Chain (${record.steps.length} Step):**\n`;
  for (const step of record.steps) {
    msg += `${step.stepNumber}. **${step.label}**\n`;
    msg += `   • To: \`${step.to}\`\n`;
    msg += `   • Value: \`${step.valueWei} wei\`\n`;
    msg += `   • BAW Request ID: \`${step.requestId || "Akan di-preview setelah Approve"}\`\n`;

    const risks = step.previewData?.risks?.riskDetails || [];
    if (risks.length > 0) {
      msg += `   • ⚠️ Risk Notice: ${risks.map((r) => `${r.title} (${r.description})`).join("; ")}\n`;
    } else if (step.previewData) {
      msg += `   • Simulasi BAW: ✅ Passed (Zero High-Risk Flags)\n`;
    }
  }

  msg += `\n⏳ **Berlaku selama:** \`${ttlSec} detik\`\n`;
  msg += `✅ Ketik **\`/confirm ${record.txId}\`** untuk mengeksekusi transaksi ini.\n`;
  msg += `🚫 Ketik **\`/cancel ${record.txId}\`** untuk membatalkan.`;
  return msg;
}

module.exports = {
  formatUsd,
  formatWalletOverview,
  formatBalances,
  formatMochiStats,
  formatMochiEligibility,
  formatMochiQuote,
  formatPendingTransaction,
};
