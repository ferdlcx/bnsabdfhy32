"use strict";

const SITE_URL = "https://agenticmochi.xyz";
const MINT_CONTRACT = "0x045398ef956b4787c782f77319ab0a20cb637da0";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const MOCHI_CONTRACT = "0x0Eb18EA6Bd86F994FEC4F3580B5206F972433364";
const MINT_SELECTOR = "0x836a1040";
const APPROVE_SELECTOR = "0x095ea7b3";
const QUOTE_FOR_SELECTOR = "0x207c8371";
const BSC_RPC_URLS = [
  process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.binance.org",
  "https://1rpc.io/bnb",
];
const USDT_DECIMALS = 18;

async function fetchResponse(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Request gagal (${response.status}): ${url}`);
  return response;
}

async function fetchMochiGuide(fetchImpl = fetch) {
  const response = await fetchResponse(`${SITE_URL}/skill.md`, fetchImpl);
  const guide = await response.text();
  const requiredValues = [
    MINT_CONTRACT.toLowerCase(),
    USDT_CONTRACT.toLowerCase(),
    MOCHI_CONTRACT.toLowerCase(),
    MINT_SELECTOR,
    APPROVE_SELECTOR,
    QUOTE_FOR_SELECTOR,
  ];
  const normalizedGuide = guide.toLowerCase();
  if (requiredValues.some((value) => !normalizedGuide.includes(value))) {
    throw new Error(
      "Panduan MOCHI berubah atau tidak cocok dengan kontrak yang diizinkan; transaksi dihentikan untuk ditinjau."
    );
  }
  return guide;
}

async function rpcCall(method, params, fetchImpl = fetch) {
  let lastError = null;
  const urls = [...new Set(BSC_RPC_URLS.filter(Boolean))];
  for (const rpcUrl of urls) {
    try {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`RPC gagal (${response.status}).`);
      const payload = await response.json();
      if (payload.error) {
        throw new Error(`RPC ${method} gagal: ${payload.error.message || payload.error.code}`);
      }
      if (payload.result === undefined || payload.result === null) {
        throw new Error(`RPC ${method} tidak mengembalikan hasil.`);
      }
      return payload.result;
    } catch (err) {
      lastError = err;
      // Jika fetchImpl adalah mock function di dalam unit test, jangan retry ke URL lain jika error memang disengaja
      if (fetchImpl !== fetch) break;
    }
  }
  throw lastError || new Error(`RPC ${method} gagal.`);
}

function encodeWord(value) {
  const number = BigInt(value);
  if (number < 0n || number >= 1n << 256n) throw new Error("Nilai ABI uint256 tidak valid.");
  return number.toString(16).padStart(64, "0");
}

function encodeAddress(address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Alamat EVM tidak valid.");
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function buildMintCalldata(shares, maxCost) {
  return `${MINT_SELECTOR}${encodeWord(shares)}${encodeAddress(
    "0x0000000000000000000000000000000000000000"
  )}${encodeWord(maxCost)}`;
}

function buildApprovalCalldata(amount) {
  return `${APPROVE_SELECTOR}${encodeAddress(MINT_CONTRACT)}${encodeWord(amount)}`;
}

function formatUnits(rawValue, decimals = USDT_DECIMALS) {
  const raw = BigInt(rawValue);
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = (raw % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseAgentId(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("API eligibility tidak mengembalikan Agent ID yang valid.");
  }
  let agentId;
  try {
    agentId = BigInt(value);
  } catch {
    throw new Error("API eligibility tidak mengembalikan Agent ID yang valid.");
  }
  if (agentId <= 0n || agentId >= 1n << 256n) {
    throw new Error("API eligibility tidak mengembalikan Agent ID yang valid.");
  }
  return agentId;
}

function timestampMilliseconds(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const number = Number(value);
    return number < 1e12 ? number * 1000 : number;
  }
  return Date.parse(value);
}

function assertDeveloperMode(settings) {
  const devMode = settings?.devMode;
  const expiresAt = timestampMilliseconds(devMode?.expiresAt);
  if (devMode?.enabled !== true || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error(
      "Developer Mode tidak aktif atau sudah kedaluwarsa. Aktifkan di Binance App sebelum membuat preview transaksi."
    );
  }
}

async function getUintBalance(tokenAddress, walletAddress, fetchImpl) {
  const data = `0x70a08231${encodeAddress(walletAddress)}`;
  const result = await rpcCall("eth_call", [{ to: tokenAddress, data }, "latest"], fetchImpl);
  return BigInt(result);
}

async function getMochiStatus({ runBawJson, fetchImpl = fetch }) {
  const [guide, walletStatus, settings, addresses] = await Promise.all([
    fetchMochiGuide(fetchImpl),
    runBawJson(["wallet", "status", "--json"]),
    runBawJson(["wallet", "settings", "--json"]),
    runBawJson(["wallet", "address", "--json"]),
  ]);
  if (walletStatus.data?.status !== "CONNECTED") {
    throw new Error("Wallet BAW belum terhubung. Hubungkan wallet sebelum memakai fitur MOCHI.");
  }
  const wallet = addresses.data?.addresses?.find(
    (entry) => String(entry.binanceChainId) === "56"
  );
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet.address)) {
    throw new Error("Alamat wallet BSC tidak ditemukan dari BAW.");
  }

  const verifyUrl = `${SITE_URL}/api/verify?address=${encodeURIComponent(wallet.address)}`;
  const [verifyResponse, bnbHex, usdtRaw, codeHex] = await Promise.all([
    fetchResponse(verifyUrl, fetchImpl),
    rpcCall("eth_getBalance", [wallet.address, "latest"], fetchImpl),
    getUintBalance(USDT_CONTRACT, wallet.address, fetchImpl),
    rpcCall("eth_getCode", [MINT_CONTRACT, "latest"], fetchImpl),
  ]);
  const eligibility = await verifyResponse.json();
  if (eligibility.address?.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("Alamat dari API eligibility tidak cocok dengan wallet BAW.");
  }
  if (codeHex === "0x" || codeHex === "0x0") {
    throw new Error("Kontrak mint MOCHI tidak ditemukan di BNB Chain.");
  }

  const allowanceData = `0xdd62ed3e${encodeAddress(wallet.address)}${encodeAddress(MINT_CONTRACT)}`;
  const allowanceHex = await rpcCall(
    "eth_call",
    [{ to: USDT_CONTRACT, data: allowanceData }, "latest"],
    fetchImpl
  );
  const bnbRaw = BigInt(bnbHex);
  const allowanceRaw = BigInt(allowanceHex);

  return {
    guide,
    walletAddress: wallet.address,
    settings: settings.data,
    eligibility,
    bnbRaw,
    usdtRaw,
    allowanceRaw,
    fetchedAt: new Date().toISOString(),
    sourceUrl: `${SITE_URL}/skill.md`,
  };
}

async function quoteMochiCost(agentId, shares, fetchImpl = fetch) {
  const data = `${QUOTE_FOR_SELECTOR}${encodeWord(agentId)}${encodeWord(shares)}`;
  const result = await rpcCall("eth_call", [{ to: MINT_CONTRACT, data }, "latest"], fetchImpl);
  return BigInt(result);
}

async function estimateGasFee({ from, to, data, bnbRaw }, fetchImpl = fetch) {
  const [estimateHex, gasPriceHex] = await Promise.all([
    rpcCall("eth_estimateGas", [{ from, to, value: "0x0", data }], fetchImpl),
    rpcCall("eth_gasPrice", [], fetchImpl),
  ]);
  const estimate = BigInt(estimateHex);
  const bufferedGas = (estimate * 120n + 99n) / 100n;
  const feeRaw = bufferedGas * BigInt(gasPriceHex);
  if (bnbRaw < feeRaw) {
    throw new Error(
      `BNB untuk gas belum cukup. Estimasi dengan buffer 20%: ${formatUnits(
        feeRaw
      )} BNB; saldo wallet: ${formatUnits(bnbRaw)} BNB. Tidak ada transaksi yang dibuat.`
    );
  }
  return { estimate, bufferedGas, feeRaw };
}

async function prepareMochiTransaction({ shares, runBawJson, fetchImpl = fetch }) {
  if (!Number.isInteger(shares) || shares < 1 || shares > 10) {
    throw new Error("Jumlah share harus bilangan bulat 1–10.");
  }
  const status = await getMochiStatus({ runBawJson, fetchImpl });
  const { eligibility } = status;
  if (eligibility.mintOpen !== true) throw new Error("Mint MOCHI sedang tidak dibuka.");
  if (eligibility.eligible !== true) {
    const reasons = Array.isArray(eligibility.reasons)
      ? eligibility.reasons.join(", ")
      : "tidak memenuhi syarat";
    throw new Error(`Wallet belum eligible untuk mint MOCHI: ${reasons}.`);
  }
  const quotaRemaining = Number(eligibility.quotaRemaining);
  if (!Number.isInteger(quotaRemaining) || shares > quotaRemaining) {
    throw new Error(
      `Kuota tersisa tidak cukup. Kuota saat ini: ${
        eligibility.quotaRemaining ?? "tidak tersedia"
      } share.`
    );
  }
  assertDeveloperMode(status.settings);

  const agentId = parseAgentId(eligibility.agentId);
  const maxCost = await quoteMochiCost(agentId, shares, fetchImpl);
  if (status.usdtRaw < maxCost) {
    throw new Error(
      `Saldo USDT tidak cukup. Quote ${shares} share: ${formatUnits(
        maxCost
      )} USDT; saldo: ${formatUnits(status.usdtRaw)} USDT. Tidak ada transaksi yang dibuat.`
    );
  }

  const approvalRequired = status.allowanceRaw < maxCost;
  if (approvalRequired && maxCost > 0n) {
    const calldata = buildApprovalCalldata(maxCost);
    const gas = await estimateGasFee(
      {
        from: status.walletAddress,
        to: USDT_CONTRACT,
        data: calldata,
        bnbRaw: status.bnbRaw,
      },
      fetchImpl
    );
    const preview = await runBawJson([
      "contract-call",
      "preview",
      "--binanceChainId",
      "56",
      "--from",
      status.walletAddress,
      "--to",
      USDT_CONTRACT,
      "--value",
      "0",
      "--inputData",
      calldata,
      "--json",
    ]);
    return {
      protocol: "mochi",
      action: "approve",
      chainId: "56",
      to: USDT_CONTRACT,
      calldata,
      value: "0",
      shares,
      maxCost,
      gas,
      preview: requirePreview(preview),
      walletAddress: status.walletAddress,
      sourceUrl: status.sourceUrl,
      fetchedAt: status.fetchedAt,
    };
  }

  const calldata = buildMintCalldata(shares, maxCost);
  const gas = await estimateGasFee(
    {
      from: status.walletAddress,
      to: MINT_CONTRACT,
      data: calldata,
      bnbRaw: status.bnbRaw,
    },
    fetchImpl
  );
  const preview = await runBawJson([
    "contract-call",
    "preview",
    "--binanceChainId",
    "56",
    "--from",
    status.walletAddress,
    "--to",
    MINT_CONTRACT,
    "--value",
    "0",
    "--inputData",
    calldata,
    "--json",
  ]);
  return {
    protocol: "mochi",
    action: "mint",
    chainId: "56",
    to: MINT_CONTRACT,
    calldata,
    value: "0",
    shares,
    maxCost,
    gas,
    preview: requirePreview(preview),
    walletAddress: status.walletAddress,
    sourceUrl: status.sourceUrl,
    fetchedAt: status.fetchedAt,
  };
}

function requirePreview(response) {
  if (response.success !== true || !response.data?.requestId) {
    throw new Error("Preview BAW tidak berhasil atau tidak memiliki requestId; execute dibatalkan.");
  }
  return response.data;
}

async function executeMochiPreview({ requestId, runBawJson }) {
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("Preview requestId tidak valid.");
  }
  const settings = await runBawJson(["wallet", "settings", "--json"]);
  assertDeveloperMode(settings.data);
  const response = await runBawJson([
    "contract-call",
    "execute",
    "--requestId",
    requestId,
    "--json",
  ]);
  if (response.success !== true) {
    throw new Error(response.error?.message || "Eksekusi BAW gagal.");
  }
  return response.data;
}

function summarizeMochiStatus(status) {
  const { eligibility, walletAddress, bnbRaw, usdtRaw, allowanceRaw, settings } = status;
  const reason =
    Array.isArray(eligibility.reasons) && eligibility.reasons.length
      ? eligibility.reasons.join(", ")
      : "tidak ada";
  const devMode = settings?.devMode?.enabled ? "aktif" : "nonaktif";
  return [
    "MOCHI di BNB Chain (Chain ID 56)",
    `Sumber panduan: ${SITE_URL}/skill.md (diambil: ${status.fetchedAt || new Date().toISOString()})`,
    `Wallet: ${walletAddress}`,
    `Mint terbuka: ${eligibility.mintOpen === true ? "ya" : "tidak"}`,
    `Eligible: ${eligibility.eligible === true ? "ya" : "tidak"} (${reason})`,
    `Agent ID: ${eligibility.agentId ?? "tidak terdeteksi"}`,
    `Kuota tersisa: ${eligibility.quotaRemaining ?? 0} share`,
    `Harga quote share pertama: ${eligibility.firstShareCost ?? "tidak tersedia"} USDT`,
    `Saldo: ${formatUnits(bnbRaw)} BNB; ${formatUnits(usdtRaw)} USDT`,
    `Allowance USDT ke kontrak mint: ${formatUnits(allowanceRaw)} USDT`,
    `Developer Mode: ${devMode}`,
    `Kontrak mint: ${MINT_CONTRACT}`,
    `Kontrak USDT: ${USDT_CONTRACT}`,
    `Kontrak MOCHI: ${MOCHI_CONTRACT}`,
    "Tidak ada transaksi yang dibuat.",
  ].join("\n");
}

function summarizeMochiPreview(prepared) {
  const { action, shares, maxCost, gas, preview, previewId, expiresAt } = prepared;
  const lines = [
    action === "approve" ? "PREVIEW APPROVAL USDT" : "PREVIEW MINT MOCHI",
    ...(previewId ? [`Preview ID: ${previewId}`] : []),
    `Wallet: ${prepared.walletAddress}`,
    `Chain ID: 56 (BNB Smart Chain)`,
    `Kontrak tujuan: ${action === "approve" ? USDT_CONTRACT : MINT_CONTRACT}`,
    `Fungsi / Selector: ${
      action === "approve"
        ? `approve(address,uint256) (${APPROVE_SELECTOR})`
        : `mint(uint256,address,uint256) (${MINT_SELECTOR})`
    }`,
    action === "approve"
      ? `Izin tepat: ${formatUnits(maxCost)} USDT untuk kontrak mint ${MINT_CONTRACT}`
      : `Jumlah: ${shares} share (${shares * 21000000} MOCHI); quote maksimum: ${formatUnits(maxCost)} USDT`,
    `Estimasi gas + buffer 20%: ${formatUnits(gas.feeRaw)} BNB`,
    `Simulasi: ${JSON.stringify(preview.simulationResult || {})}`,
    `Risiko: ${JSON.stringify(preview.risks || {})}`,
    `Perubahan otorisasi: ${JSON.stringify(
      preview.authorityChanges || preview.simulationResult?.authorityChanges || []
    )}`,
    `Konfirmasi Binance App diperlukan: ${preview.requireConfirmation === true ? "ya" : "tidak"}`,
    ...(expiresAt ? [`Berlaku hingga: ${new Date(expiresAt).toISOString()}`] : []),
    "",
    "Preview ini belum mengirim transaksi.",
    action === "approve"
      ? "Catatan: Konfirmasi ini HANYA menyetujui Approval USDT, bukan Mint. Setelah approval selesai, minta preview mint terpisah."
      : "Catatan: Konfirmasi ini hanya berlaku satu kali untuk preview mint di atas.",
    previewId
      ? `Ketik /confirm ${previewId} (atau /confirm) untuk menyetujui transaksi ini, atau /cancel untuk membatalkan.`
      : "Ketik /confirm untuk menyetujui transaksi ini, atau /cancel untuk membatalkan.",
  ];
  return lines.join("\n");
}

/**
 * Implementasi antarmuka Protocol Adapter sesuai implementation.md:
 * discover, checkEligibility, quote, buildTransaction, summarizePreview
 */
const mochiProtocolAdapter = {
  id: "mochi",
  name: "MOCHI (BNB Smart Chain)",
  chainId: "56",
  matches(target = "") {
    const clean = String(target || "").trim().toLowerCase();
    return (
      clean === "mochi" ||
      clean.includes("agenticmochi.xyz") ||
      clean === MINT_CONTRACT.toLowerCase() ||
      clean === MOCHI_CONTRACT.toLowerCase()
    );
  },
  async discover({ fetchImpl = fetch } = {}) {
    const guide = await fetchMochiGuide(fetchImpl);
    return {
      protocol: "mochi",
      chainId: "56",
      siteUrl: SITE_URL,
      guideUrl: `${SITE_URL}/skill.md`,
      fetchedAt: new Date().toISOString(),
      contracts: {
        mint: MINT_CONTRACT,
        paymentToken: USDT_CONTRACT,
        token: MOCHI_CONTRACT,
      },
      selectors: {
        mint: MINT_SELECTOR,
        approve: APPROVE_SELECTOR,
        quoteFor: QUOTE_FOR_SELECTOR,
      },
      guideExcerpt: guide.slice(0, 1500),
    };
  },
  async checkEligibility({ runBawJson, fetchImpl = fetch }) {
    const status = await getMochiStatus({ runBawJson, fetchImpl });
    return {
      ...status,
      summary: summarizeMochiStatus(status),
    };
  },
  async quote({ shares = 1, runBawJson, fetchImpl = fetch }) {
    if (!Number.isInteger(Number(shares)) || Number(shares) < 1 || Number(shares) > 10) {
      throw new Error("Jumlah share harus bilangan bulat 1–10.");
    }
    const status = await getMochiStatus({ runBawJson, fetchImpl });
    const agentId = parseAgentId(status.eligibility.agentId);
    const maxCost = await quoteMochiCost(agentId, Number(shares), fetchImpl);
    return {
      protocol: "mochi",
      shares: Number(shares),
      maxCostRaw: maxCost.toString(),
      maxCostUsdt: formatUnits(maxCost),
      tokensOut: `${Number(shares) * 21000000} MOCHI`,
      approvalRequired: status.allowanceRaw < maxCost && maxCost > 0n,
      walletAddress: status.walletAddress,
      bnbBalance: formatUnits(status.bnbRaw),
      usdtBalance: formatUnits(status.usdtRaw),
      allowanceUsdt: formatUnits(status.allowanceRaw),
    };
  },
  async buildTransaction({ shares = 1, runBawJson, fetchImpl = fetch }) {
    return prepareMochiTransaction({
      shares: Number(shares),
      runBawJson,
      fetchImpl,
    });
  },
  summarizePreview(prepared) {
    return summarizeMochiPreview(prepared);
  },
};

module.exports = {
  APPROVE_SELECTOR,
  MINT_CONTRACT,
  MINT_SELECTOR,
  MOCHI_CONTRACT,
  QUOTE_FOR_SELECTOR,
  SITE_URL,
  USDT_CONTRACT,
  buildApprovalCalldata,
  buildMintCalldata,
  executeMochiPreview,
  fetchMochiGuide,
  formatUnits,
  getMochiStatus,
  prepareMochiTransaction,
  summarizeMochiStatus,
  summarizeMochiPreview,
  mochiProtocolAdapter,
};
