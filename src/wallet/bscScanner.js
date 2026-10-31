/**
 * Modul On-Chain Scanner untuk BNB Smart Chain (dipertahankan & ditingkatkan dari mint_bot.js lama).
 * Menyediakan RPC call langsung, GoPlus Security Audit, dan DexScreener Market Info.
 */

const DEFAULT_BSC_RPC = "https://bsc-rpc.publicnode.com";
const FALLBACK_BSC_RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://1rpc.io/bnb",
  "https://bsc-dataseed.binance.org",
];

async function bscRpcCall(method, params = [], rpcUrl = DEFAULT_BSC_RPC) {
  const candidates = [rpcUrl, ...FALLBACK_BSC_RPCS.filter((u) => u !== rpcUrl)];
  let lastErr = null;

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error.message || "BSC RPC Error");
      }
      return data.result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All BSC RPC endpoints failed");
}

/**
 * Membaca allowance ERC-20/BEP-20 secara on-chain: allowance(address owner, address spender) -> selector 0xdd62ed3e
 */
async function getErc20Allowance(tokenAddress, ownerAddress, spenderAddress, rpcUrl = DEFAULT_BSC_RPC) {
  const cleanOwner = ownerAddress.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const cleanSpender = spenderAddress.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const data = `0xdd62ed3e${cleanOwner}${cleanSpender}`;
  const hexResult = await bscRpcCall(
    "eth_call",
    [{ to: tokenAddress, data }, "latest"],
    rpcUrl
  );
  if (!hexResult || hexResult === "0x") return 0n;
  return BigInt(hexResult);
}

/**
 * Membaca saldo ERC-20/BEP-20 secara on-chain: balanceOf(address owner) -> selector 0x70a08231
 */
async function getErc20Balance(tokenAddress, ownerAddress, rpcUrl = DEFAULT_BSC_RPC) {
  const cleanOwner = ownerAddress.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const data = `0x70a08231${cleanOwner}`;
  const hexResult = await bscRpcCall(
    "eth_call",
    [{ to: tokenAddress, data }, "latest"],
    rpcUrl
  );
  if (!hexResult || hexResult === "0x") return 0n;
  return BigInt(hexResult);
}

/**
 * Inspeksi lengkap suatu alamat di BNB Chain (Wallet / Kontrak, GoPlus Security, DexScreener).
 */
async function inspectBscAddress(address, rpcUrl = DEFAULT_BSC_RPC) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Alamat EVM tidak valid.");
  }

  const addr = address.toLowerCase();
  const [balanceHex, codeHex, goplusRes, dexRes] = await Promise.allSettled([
    bscRpcCall("eth_getBalance", [addr, "latest"], rpcUrl),
    bscRpcCall("eth_getCode", [addr, "latest"], rpcUrl),
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
    codeHex.status === "fulfilled" &&
    codeHex.value &&
    codeHex.value !== "0x" &&
    codeHex.value !== "0x0";

  let report = `🔎 **Hasil Cek Address (BNB Smart Chain)**\n`;
  report += `• Address: \`${address}\`\n`;
  report += `• Tipe: ${isContract ? "📄 Smart Contract" : "👤 Wallet Biasa (EOA)"}\n`;
  report += `• Saldo BNB: \`${bnbBalance} BNB\`\n`;

  let isHoneypot = false;
  if (isContract && goplusRes.status === "fulfilled") {
    const sec = goplusRes.value?.result?.[addr];
    if (sec) {
      const buyTax = sec.buy_tax ? `${(Number(sec.buy_tax) * 100).toFixed(1)}%` : "0%";
      const sellTax = sec.sell_tax ? `${(Number(sec.sell_tax) * 100).toFixed(1)}%` : "0%";
      isHoneypot = sec.is_honeypot === "1";
      const honeypot = isHoneypot ? "🚨 YA (BAHAYA!)" : "✅ Aman (Bukan Honeypot)";
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

  report += `\n🔗 [Lihat di BscScan](https://bscscan.com/address/${address})`;

  return {
    address,
    isContract,
    bnbBalance,
    isHoneypot,
    report,
  };
}

module.exports = {
  bscRpcCall,
  getErc20Allowance,
  getErc20Balance,
  inspectBscAddress,
};
