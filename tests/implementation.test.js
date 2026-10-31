"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MINT_CONTRACT,
  MOCHI_CONTRACT,
  USDT_CONTRACT,
  MINT_SELECTOR,
  APPROVE_SELECTOR,
  QUOTE_FOR_SELECTOR,
  prepareMochiTransaction,
  executeMochiPreview,
  fetchMochiGuide,
} = require("../mochi");
const {
  PendingPreviewStore,
  AgentToolRegistry,
} = require("../src/agent/toolRegistry");
const {
  GeminiAgentOrchestrator,
  resolveGeminiModel,
} = require("../src/agent/geminiOrchestrator");

const VALID_WALLET = "0x7B6805D6dBeE94F3ba4a3fe24Fac87778411bDD2";
const VALID_GUIDE = `
# MOCHI mint guide
Mint contract: ${MINT_CONTRACT}
USDT: ${USDT_CONTRACT}
MOCHI token: ${MOCHI_CONTRACT}
Selectors: ${MINT_SELECTOR}, ${APPROVE_SELECTOR}, ${QUOTE_FOR_SELECTOR}
`;

function createMockEnv({
  eligible = true,
  mintOpen = true,
  quotaRemaining = 10,
  agentId = "12345",
  devModeEnabled = true,
  devModeExpiresAt = Math.floor(Date.now() / 1000) + 3600,
  bnbWei = 10n ** 17n, // 0.1 BNB
  usdtWei = 10n * 10n ** 18n, // 10 USDT
  allowanceWei = 0n,
  quoteCostWei = 0n, // 0 for free first share, >0 for paid share
  guideText = VALID_GUIDE,
  previewSuccess = true,
  previewRequestId = "req-preview-abc",
} = {}) {
  const executedCommands = [];

  const runBawJson = async (args) => {
    executedCommands.push(args);
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "wallet status") {
      return { success: true, data: { status: "CONNECTED" } };
    }
    if (cmd === "wallet settings") {
      return {
        success: true,
        data: {
          devMode: {
            enabled: devModeEnabled,
            expiresAt: devModeExpiresAt,
          },
        },
      };
    }
    if (cmd === "wallet address") {
      return {
        success: true,
        data: {
          addresses: [{ binanceChainId: "56", address: VALID_WALLET }],
        },
      };
    }
    if (cmd === "contract-call preview") {
      if (!previewSuccess) {
        return { success: false, error: { message: "Simulation reverted" } };
      }
      return {
        success: true,
        data: {
          requestId: previewRequestId,
          simulationResult: { simulationCode: "000000000" },
          risks: { riskDetails: [] },
          requireConfirmation: false,
        },
      };
    }
    if (cmd === "contract-call execute") {
      return {
        success: true,
        data: {
          orderId: "order-999",
          status: "BROADCASTED",
          txHash: "0x" + "f".repeat(64),
        },
      };
    }
    return { success: true, data: {} };
  };

  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/skill.md")) {
      return {
        ok: true,
        status: 200,
        text: async () => guideText,
      };
    }
    if (urlStr.includes("/api/verify")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          address: VALID_WALLET,
          eligible,
          reasons: eligible ? [] : ["NO_AGENT_ID"],
          mintOpen,
          quotaRemaining,
          agentId,
          firstShareCost: quoteCostWei === 0n ? "0.0" : "1.0",
        }),
      };
    }
    // RPC call
    const body = JSON.parse(init.body || "{}");
    if (body.method === "eth_getBalance") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + bnbWei.toString(16) }),
      };
    }
    if (body.method === "eth_getCode") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x60806040" }),
      };
    }
    if (body.method === "eth_estimateGas") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (150000n).toString(16) }),
      };
    }
    if (body.method === "eth_gasPrice") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (10n ** 9n).toString(16) }),
      };
    }
    if (body.method === "eth_call") {
      const callData = body.params?.[0]?.data || "";
      if (callData.startsWith("0x70a08231")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: "0x" + usdtWei.toString(16).padStart(64, "0"),
          }),
        };
      }
      if (callData.startsWith("0xdd62ed3e")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: "0x" + allowanceWei.toString(16).padStart(64, "0"),
          }),
        };
      }
      if (callData.startsWith(QUOTE_FOR_SELECTOR)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: "0x" + quoteCostWei.toString(16).padStart(64, "0"),
          }),
        };
      }
    }
    throw new Error(`Unhandled mock URL: ${urlStr}`);
  };

  return { runBawJson, fetchImpl, executedCommands };
}

test("implementation.md: Panduan yang berubah (kontrak/selector tidak cocok) menghentikan transaksi", async () => {
  const { fetchImpl } = createMockEnv({
    guideText: "# Modified guide with malicious contract 0xdeadbeef",
  });
  await assert.rejects(() => fetchMochiGuide(fetchImpl), /Panduan MOCHI berubah/);
});

test("implementation.md: Approval dan Mint memerlukan preview serta konfirmasi terpisah", async () => {
  // 1. Ketika quoteCostWei > 0 dan allowance = 0 -> prepareMochiTransaction HANYA membuat preview 'approve'
  const env1 = createMockEnv({
    quoteCostWei: 2n * 10n ** 18n,
    allowanceWei: 0n,
    previewRequestId: "req-approve-001",
  });
  const prepApprove = await prepareMochiTransaction({
    shares: 2,
    runBawJson: env1.runBawJson,
    fetchImpl: env1.fetchImpl,
  });
  assert.equal(prepApprove.action, "approve");
  assert.equal(prepApprove.to, USDT_CONTRACT);
  assert.equal(prepApprove.preview.requestId, "req-approve-001");

  // 2. Setelah allowance mencukupi (>= maxCost) -> prepareMochiTransaction membuat preview 'mint'
  const env2 = createMockEnv({
    quoteCostWei: 2n * 10n ** 18n,
    allowanceWei: 2n * 10n ** 18n,
    previewRequestId: "req-mint-002",
  });
  const prepMint = await prepareMochiTransaction({
    shares: 2,
    runBawJson: env2.runBawJson,
    fetchImpl: env2.fetchImpl,
  });
  assert.equal(prepMint.action, "mint");
  assert.equal(prepMint.to, MINT_CONTRACT);
  assert.equal(prepMint.preview.requestId, "req-mint-002");
});

test("implementation.md: Kekurangan gas BNB, kurang USDT, Developer Mode mati, atau tidak eligible menghentikan alur", async () => {
  // Developer Mode mati
  const envNoDev = createMockEnv({ devModeEnabled: false });
  await assert.rejects(
    () => prepareMochiTransaction({ shares: 1, runBawJson: envNoDev.runBawJson, fetchImpl: envNoDev.fetchImpl }),
    /Developer Mode tidak aktif/
  );

  // Saldo BNB gas kurang
  const envLowGas = createMockEnv({ bnbWei: 100n });
  await assert.rejects(
    () => prepareMochiTransaction({ shares: 1, runBawJson: envLowGas.runBawJson, fetchImpl: envLowGas.fetchImpl }),
    /BNB untuk gas belum cukup/
  );

  // Saldo USDT kurang
  const envLowUsdt = createMockEnv({ quoteCostWei: 5n * 10n ** 18n, usdtWei: 1n * 10n ** 18n });
  await assert.rejects(
    () => prepareMochiTransaction({ shares: 5, runBawJson: envLowUsdt.runBawJson, fetchImpl: envLowUsdt.fetchImpl }),
    /Saldo USDT tidak cukup/
  );

  // Tidak eligible
  const envIneligible = createMockEnv({ eligible: false });
  await assert.rejects(
    () =>
      prepareMochiTransaction({
        shares: 1,
        runBawJson: envIneligible.runBawJson,
        fetchImpl: envIneligible.fetchImpl,
      }),
    /belum eligible/
  );
});

test("implementation.md: Protokol tidak dikenal menghasilkan 'belum didukung' dan tidak menebak calldata", async () => {
  const env = createMockEnv();
  const registry = new AgentToolRegistry({
    runBawJson: env.runBawJson,
    fetchImpl: env.fetchImpl,
  });

  const checkUnsupported = await registry.executeToolCall("check_asset_or_mint", {
    protocol_or_url: "https://unknown-random-launchpad.xyz",
  });
  assert.equal(checkUnsupported.supported, false);
  assert.match(checkUnsupported.message, /belum didukung/);

  const prepUnsupported = await registry.executeToolCall(
    "prepare_transaction",
    { protocol: "unknown-token", shares: 1 },
    { userId: 1001, chatId: 1001 }
  );
  assert.equal(prepUnsupported.supported, false);
  assert.equal(prepUnsupported.prepared, false);
});

test("implementation.md: Preview Store menolak salah pemilik, expired, replay, dan eksekusi via AI chat", async () => {
  const env = createMockEnv({ quoteCostWei: 0n, previewRequestId: "req-free-mint-77" });
  const store = new PendingPreviewStore({ ttlMs: 5000 });
  const registry = new AgentToolRegistry({
    runBawJson: env.runBawJson,
    fetchImpl: env.fetchImpl,
    previewStore: store,
  });

  // Model mencoba memanggil execute_confirmed_transaction secara langsung -> ditolak!
  const aiExecAttempt = await registry.executeToolCall("execute_confirmed_transaction", {
    previewId: "PV-123456",
  });
  assert.equal(aiExecAttempt.ok, false);
  assert.equal(aiExecAttempt.requiresTelegramConfirmCommand, true);

  // Buat preview valid untuk user 1001
  const prepRes = await registry.executeToolCall(
    "prepare_transaction",
    { protocol: "mochi", shares: 1 },
    { userId: 1001, chatId: 2002 }
  );
  assert.equal(prepRes.prepared, true);
  const { previewId } = prepRes;

  // User 9999 (salah pemilik) mencoba confirm -> ditolak
  await assert.rejects(
    () => registry.confirmAndExecuteForUser({ userId: 9999, chatId: 9999, previewId }),
    /Tidak ada preview/
  );

  // User 1001 tapi dari chatId berbeda -> ditolak
  await assert.rejects(
    () => registry.confirmAndExecuteForUser({ userId: 1001, chatId: 8888, previewId }),
    /Akses ditolak/
  );

  // User 1001 mengonfirmasi dari chatId 2002 -> berhasil!
  const confirmed = await registry.confirmAndExecuteForUser({
    userId: 1001,
    chatId: 2002,
    previewId,
  });
  assert.equal(confirmed.execution.status, "BROADCASTED");

  // Replay (konfirmasi kedua dengan preview yang sama) -> ditolak!
  await assert.rejects(
    () => registry.confirmAndExecuteForUser({ userId: 1001, chatId: 2002, previewId }),
    /Tidak ada preview/
  );
});

test("implementation.md: GeminiAgentOrchestrator menormalisasi model 'gemini-3.8-flash' & menjalankan tool loop", async () => {
  assert.equal(resolveGeminiModel("gemini-3.8-flash"), "gemini-2.5-flash");
  assert.equal(resolveGeminiModel(""), "gemini-2.5-flash");
  assert.equal(resolveGeminiModel("gemini-2.5-pro"), "gemini-2.5-pro");

  const env = createMockEnv({ quoteCostWei: 0n });
  const registry = new AgentToolRegistry({
    runBawJson: env.runBawJson,
    fetchImpl: env.fetchImpl,
  });

  let turnStep = 0;
  const mockAiClient = {
    chats: {
      create: () => ({
        sendMessage: async () => {
          turnStep += 1;
          if (turnStep === 1) {
            return {
              functionCalls: [
                {
                  id: "call-1",
                  name: "check_asset_or_mint",
                  args: { protocol_or_url: "mochi", shares: 1 },
                },
              ],
            };
          }
          return {
            functionCalls: [],
            text: "Wallet Anda eligible untuk MOCHI dengan 10 kuota share tersisa dan share pertama gratis (0 USDT).",
          };
        },
        getHistory: () => [],
      }),
    },
  };

  const orchestrator = new GeminiAgentOrchestrator({
    apiKey: "test-key",
    model: "gemini-3.8-flash",
    toolRegistry: registry,
    aiClient: mockAiClient,
  });

  const reply = await orchestrator.handleUserMessage({
    userId: 501,
    chatId: 501,
    text: "Cek apakah wallet saya eligible untuk MOCHI",
  });

  assert.match(reply, /eligible untuk MOCHI/);
  assert.equal(turnStep, 2);
});
