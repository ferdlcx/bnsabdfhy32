"use strict";

const SITE_URL = "https://agenticmochi.xyz";
const MINT_CONTRACT = "0x045398ef956b4787c782f77319ab0a20cb637da0";
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const MOCHI_CONTRACT = "0x0Eb18EA6Bd86F994FEC4F3580B5206F972433364";
const MINT_SELECTOR = "0x836a1040";
const APPROVE_SELECTOR = "0x095ea7b3";
const QUOTE_FOR_SELECTOR = "0x207c8371";
const BSC_RPC_URL = "https://bsc-dataseed.binance.org";
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
    throw new Error("Panduan MOCHI berubah atau tidak cocok dengan kontrak yang diizinkan; transaksi dihentikan untuk ditinjau.");
  }
  return guide;
}

async function rpcCall(method, params, fetchImpl = fetch) {
  const response = await fetchImpl(BSC_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`RPC gagal (${response.status}).`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${method} gagal: ${payload.error.message || payload.error.code}`);
  if (payload.result === undefined || payload.result === null) {
    throw new Error(`RPC ${method} tidak mengembalikan hasil.`);
  }
  return payload.result;
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
  return `${MINT_SELECTOR}${encodeWord(shares)}${encodeAddress("0x0000000000000000000000000000000000000000")}${encodeWord(maxCost)}`;
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
    throw new Error("Developer Mode tidak aktif atau sudah kedaluwarsa. Aktifkan di Binance App sebelum membuat preview transaksi.");
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
  const wallet = addresses.data?.addresses?.find((entry) => entry.binanceChainId === "56");
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

  const allowanceData =
    `0xdd62ed3e${encodeAddress(wallet.address)}${encodeAddress(MINT_CONTRACT)}`;
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
      `BNB untuk gas belum cukup. Estimasi dengan buffer 20%: ${formatUnits(feeRaw)} BNB; saldo wallet: ${formatUnits(bnbRaw)} BNB. Tidak ada transaksi yang dibuat.`
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
    const reasons = Array.isArray(eligibility.reasons) ? eligibility.reasons.join(", ") : "tidak memenuhi syarat";
    throw new Error(`Wallet belum eligible untuk mint MOCHI: ${reasons}.`);
  }
  const quotaRemaining = Number(eligibility.quotaRemaining);
  if (!Number.isInteger(quotaRemaining) || shares > quotaRemaining) {
    throw new Error(`Kuota tersisa tidak cukup. Kuota saat ini: ${eligibility.quotaRemaining ?? "tidak tersedia"} share.`);
  }
  assertDeveloperMode(status.settings);

  const agentId = parseAgentId(eligibility.agentId);
  const maxCost = await quoteMochiCost(agentId, shares, fetchImpl);
  if (status.usdtRaw < maxCost) {
    throw new Error(
      `Saldo USDT tidak cukup. Quote ${shares} share: ${formatUnits(maxCost)} USDT; saldo: ${formatUnits(status.usdtRaw)} USDT. Tidak ada transaksi yang dibuat.`
    );
  }

  const approvalRequired = status.allowanceRaw < maxCost;
  if (approvalRequired && maxCost > 0n) {
    const calldata = buildApprovalCalldata(maxCost);
    const gas = await estimateGasFee({
      from: status.walletAddress,
      to: USDT_CONTRACT,
      data: calldata,
      bnbRaw: status.bnbRaw,
    }, fetchImpl);
    const preview = await runBawJson([
      "contract-call", "preview", "--binanceChainId", "56",
      "--from", status.walletAddress, "--to", USDT_CONTRACT,
      "--value", "0", "--inputData", calldata, "--json",
    ]);
    return {
      action: "approve",
      shares,
      maxCost,
      gas,
      preview: requirePreview(preview),
      walletAddress: status.walletAddress,
    };
  }

  const calldata = buildMintCalldata(shares, maxCost);
  const gas = await estimateGasFee({
    from: status.walletAddress,
    to: MINT_CONTRACT,
    data: calldata,
    bnbRaw: status.bnbRaw,
  }, fetchImpl);
  const preview = await runBawJson([
    "contract-call", "preview", "--binanceChainId", "56",
    "--from", status.walletAddress, "--to", MINT_CONTRACT,
    "--value", "0", "--inputData", calldata, "--json",
  ]);
  return {
    action: "mint",
    shares,
    maxCost,
    gas,
    preview: requirePreview(preview),
    walletAddress: status.walletAddress,
  };
}

function requirePreview(response) {
  if (response.success !== true || !response.data?.requestId) {
    throw new Error("Preview BAW tidak berhasil atau tidak memiliki requestId; execute dibatalkan.");
  }
  return response.data;
}

async function executeMochiPreview({ requestId, runBawJson }) {
  if (typeof requestId !== "string" || !requestId) throw new Error("Preview requestId tidak valid.");
  const settings = await runBawJson(["wallet", "settings", "--json"]);
  assertDeveloperMode(settings.data);
  const response = await runBawJson(["contract-call", "execute", "--requestId", requestId, "--json"]);
  if (response.success !== true) throw new Error(response.error?.message || "Eksekusi BAW gagal.");
  return response.data;
}

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
};
