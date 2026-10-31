const { containsForbiddenKeyRequest } = require("../security/redactor");

/**
 * Pola instruksi berbahaya pada SKILL.md eksternal (Untrusted Input Defense)
 */
const DANGEROUS_PATTERNS = [
  {
    code: "PRIVATE_KEY_EXFILTRATION",
    regex: /\b(private\s*key|seed\s*phrase|mnemonic|recovery\s*phrase|export\s+key)\b/i,
    allowIfNegated: /\b(never|do\s+not|don't|refuse|jangan)\b.{0,50}\b(private\s*key|seed\s*phrase|mnemonic|export|import\s+key)/i,
    description: "Meminta atau menyinggung private key / seed phrase.",
  },
  {
    code: "ARBITRARY_SHELL_INSTALL",
    regex: /\b(curl\s+[^\n]+\|\s*(sh|bash)|wget\s+[^\n]+\|\s*(sh|bash)|powershell\s+-enc|eval\s*\()/i,
    allowIfNegated: null,
    description: "Mengandung instruksi eksekusi shell / instalasi script jarak jauh.",
  },
  {
    code: "PROMPT_INJECTION_ATTEMPT",
    regex: /\b(ignore\s+(all\s+)?previous\s+instructions|system\s+override|bypass\s+user\s+confirmation|skip\s+confirmation\s+always)\b/i,
    allowIfNegated: null,
    description: "Terdeteksi pola prompt injection untuk melewati konfirmasi pengguna.",
  },
];

function validateSkillDocument(rawText = "", metadata = {}) {
  const issues = [];
  const warnings = [];
  const text = String(rawText || "");

  if (!text.trim()) {
    return {
      safe: false,
      status: "INVALID_EMPTY",
      issues: ["Dokumen skill kosong."],
      warnings: [],
    };
  }

  if (containsForbiddenKeyRequest(text)) {
    issues.push(
      "CRITICAL: Dokumen meminta eksport/pengiriman private key atau seed phrase."
    );
  }

  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.regex.test(text)) {
      if (rule.allowIfNegated && rule.allowIfNegated.test(text)) {
        continue;
      }
      issues.push(`${rule.code}: ${rule.description}`);
    }
  }

  const contracts = metadata.contracts || {};
  const contractValues = Object.values(contracts).filter(Boolean);
  if (contractValues.length === 0) {
    warnings.push("Tidak ditemukan alamat smart contract (0x...) di dalam dokumen.");
  }

  for (const addr of contractValues) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      issues.push(`Format alamat kontrak tidak valid: ${addr}`);
    }
  }

  const safe = issues.length === 0;
  const status = !safe
    ? "BLOCKED_UNSAFE"
    : warnings.length > 0
      ? "VALIDATED_WITH_WARNINGS"
      : "VALIDATED";

  return {
    safe,
    status,
    issues,
    warnings,
  };
}

module.exports = {
  validateSkillDocument,
};
