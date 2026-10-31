/**
 * Modul sanitasi untuk mencegah kebocoran informasi sensitif (private key,
 * seed phrase, bot token, API key, session token) ke log, AI, atau Telegram.
 */

const SENSITIVE_KEY_PATTERNS = [
  /private[_-]?key/i,
  /seed[_-]?phrase/i,
  /mnemonic/i,
  /secret/i,
  /password/i,
  /session[_-]?token/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /api[_-]?key/i,
  /client[_-]?id/i,
  /telegram[_-]?bot[_-]?token/i,
];

// Pattern untuk 64-hex private key yang berdiri sendiri (bukan txHash / calldata yang dikenal)
const TELEGRAM_TOKEN_REGEX = /\b\d{8,12}:[A-Za-z0-9_-]{30,40}\b/g;
const BEARER_REGEX = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_VALUE_REGEX = /\b(AIza[0-9A-Za-z_-]{30,50}|gsk_[0-9A-Za-z]{20,60}|sk-[0-9A-Za-z_-]{20,60})\b/g;

function redactText(input) {
  if (typeof input !== "string") return "";
  let out = input;
  out = out.replace(TELEGRAM_TOKEN_REGEX, "[REDACTED_TG_TOKEN]");
  out = out.replace(BEARER_REGEX, "$1[REDACTED_TOKEN]");
  out = out.replace(API_KEY_VALUE_REGEX, "[REDACTED_API_KEY]");
  return out;
}

function redactObject(obj, depth = 0) {
  if (depth > 8 || obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactText(obj);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, depth + 1));
  }

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = redactObject(value, depth + 1);
    }
  }
  return clean;
}

/**
 * Memeriksa apakah suatu teks meminta atau mengandung instruksi ekstraksi private key / seed phrase.
 */
function containsForbiddenKeyRequest(text = "") {
  const lower = String(text).toLowerCase();
  const patterns = [
    /export\s+(your\s+)?private\s+key/i,
    /send\s+(your\s+)?(private\s+key|seed\s+phrase|mnemonic)/i,
    /enter\s+(your\s+)?(private\s+key|seed\s+phrase|mnemonic)/i,
    /import\s+private\s+key/i,
    /eth_private_key/i,
    /wallet_export/i,
  ];
  return patterns.some((re) => re.test(lower));
}

module.exports = {
  redactText,
  redactObject,
  containsForbiddenKeyRequest,
};
