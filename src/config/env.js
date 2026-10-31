const fs = require("node:fs");
const path = require("node:path");

/**
 * Memuat file .env secara deterministik tanpa membutuhkan dependency eksternal.
 * Tidak menimpa variabel environment yang sudah ada di process.env.
 */
function loadDotEnv(envPath = path.resolve(process.cwd(), ".env")) {
  try {
    if (!fs.existsSync(envPath)) return false;
    const content = fs.readFileSync(envPath, "utf8");
    const lines = content.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;

      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();

      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function parseAllowedUserIds(rawValue = "") {
  const cleaned = String(rawValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const ids = new Set();
  for (const item of cleaned) {
    if (!/^\d+$/.test(item)) {
      throw new Error(
        `TELEGRAM_ALLOWED_USER_IDS tidak valid ("${item}"). Harus berupa angka Telegram User ID.`
      );
    }
    ids.add(Number(item));
  }
  return ids;
}

function getConfig(overrides = {}) {
  loadDotEnv();
  const env = { ...process.env, ...overrides };

  return {
    telegramBotToken: (env.TELEGRAM_BOT_TOKEN || "").trim(),
    allowedUserIds: parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS || ""),
    bawBin: (env.BAW_BIN || "baw").trim(),
    bawTimeoutMs: Number(env.BAW_TIMEOUT_MS || 45000),
    bawRequiredCliVersion: (env.BAW_REQUIRED_CLI_VERSION || "1.12.0").trim(),
    bawSkillVersion: (env.BAW_SKILL_VERSION || "1.15.0").trim(),
    defaultChainId: String(env.DEFAULT_CHAIN_ID || "56").trim(),
    bscRpcUrl: (env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com").trim(),

    dryRun: String(env.DRY_RUN || "false").toLowerCase() === "true",
    killSwitch: String(env.KILL_SWITCH || "false").toLowerCase() === "true",
    maxTxSpendUsd: Number(env.MAX_TX_SPEND_USD || 15),
    maxDailySpendUsd: Number(env.MAX_DAILY_SPEND_USD || 50),
    txConfirmationTtlSeconds: Number(env.TX_CONFIRMATION_TTL_SECONDS || 300),

    geminiApiKey: (env.GEMINI_API_KEY || "").trim(),
    geminiModel: (env.GEMINI_MODEL || "gemini-2.5-flash").trim(),
    openaiCompatApiKey: (env.OPENAI_COMPAT_API_KEY || "").trim(),
    openaiCompatBaseUrl: (
      env.OPENAI_COMPAT_BASE_URL || "https://api.groq.com/openai/v1"
    ).trim(),
    openaiCompatModel: (
      env.OPENAI_COMPAT_MODEL || "llama-3.3-70b-versatile"
    ).trim(),
    aiTimeoutMs: Number(env.AI_TIMEOUT_MS || 20000),
    aiMaxCallsPerHour: Number(env.AI_MAX_CALLS_PER_HOUR || 30),
    aiMaxTokensPerCall: Number(env.AI_MAX_TOKENS_PER_CALL || 1024),

    txMonitorIntervalMs: Number(env.TX_MONITOR_INTERVAL_MS || 15000),
    rootDir: process.cwd(),
    skillsDir: path.resolve(process.cwd(), "skills"),
    dataDir: path.resolve(process.cwd(), "data"),
  };
}

module.exports = {
  loadDotEnv,
  parseAllowedUserIds,
  getConfig,
};
