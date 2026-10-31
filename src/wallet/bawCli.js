const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { redactText, redactObject } = require("../security/redactor");

const execFileAsync = promisify(execFile);

/**
 * Daftar subcommand tingkat pertama yang diizinkan untuk dijalankan pada BAW CLI.
 * Mencegah injeksi argumen berbahaya.
 */
const ALLOWED_TOP_COMMANDS = new Set([
  "skill-check",
  "cli-check",
  "auth",
  "wallet",
  "approvals",
  "market-order",
  "limit-order",
  "contract-call",
  "sign-message",
  "prediction",
  "x402-payment",
  "defi",
  "--version",
  "-v",
  "--help",
]);

class BawCli {
  constructor(options = {}) {
    this.bin = options.bin || process.env.BAW_BIN || "baw";
    this.timeoutMs = options.timeoutMs || Number(process.env.BAW_TIMEOUT_MS || 45000);
    this.executor = options.executor || execFileAsync;
  }

  /**
   * Validasi argumen CLI sebelum dieksekusi via execFile (tanpa shell).
   */
  validateArgs(args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error("Argumen BAW CLI tidak boleh kosong.");
    }

    const sanitized = args.map((arg) => {
      const s = String(arg);
      if (s.includes("\0")) {
        throw new Error("Argumen BAW CLI mengandung karakter null byte ilegal.");
      }
      return s;
    });

    const topCmd = sanitized[0];
    if (!ALLOWED_TOP_COMMANDS.has(topCmd)) {
      throw new Error(`Subcommand BAW CLI tidak dikenal atau tidak diizinkan: "${topCmd}"`);
    }

    // Pastikan selalu menggunakan --json untuk command operasional
    if (
      topCmd !== "--version" &&
      topCmd !== "-v" &&
      topCmd !== "--help" &&
      !sanitized.includes("--json")
    ) {
      sanitized.push("--json");
    }

    return sanitized;
  }

  /**
   * Menjalankan perintah BAW CLI dan mengembalikan hasil terstruktur:
   * { ok, data, error, raw, exitCode }
   */
  async run(args, customTimeoutMs) {
    const finalArgs = this.validateArgs(args);
    const timeout = customTimeoutMs || this.timeoutMs;

    try {
      const { stdout, stderr } = await this.executor(this.bin, finalArgs, {
        timeout,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      });

      const rawOutput = (stdout || stderr || "").trim();
      return this.parseOutput(rawOutput, 0);
    } catch (err) {
      const rawErr = (err.stdout || err.stderr || err.message || "Unknown CLI error").trim();
      const parsed = this.parseOutput(rawErr, err.code || 1);
      return {
        ...parsed,
        ok: false,
      };
    }
  }

  /**
   * Mem-parsing output JSON dari BAW CLI.
   * Sesuai dokumentasi resmi BAW, jika CLI mengembalikan JSON:
   * { "success": true, "data": ... } atau { "success": false, "error": { "code", "name", "message" } }
   */
  parseOutput(rawOutput, exitCode = 0) {
    const safeRaw = redactText(rawOutput);
    if (!safeRaw) {
      return {
        ok: exitCode === 0,
        data: null,
        error: exitCode === 0 ? null : { message: "Empty output from BAW CLI" },
        raw: "",
        exitCode,
      };
    }

    // Cari blok JSON jika ada log tambahan sebelum/sesudah JSON
    let jsonCandidate = safeRaw;
    const firstBrace = safeRaw.indexOf("{");
    const lastBrace = safeRaw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonCandidate = safeRaw.slice(firstBrace, lastBrace + 1);
    }

    try {
      const parsed = JSON.parse(jsonCandidate);
      const cleanParsed = redactObject(parsed);

      if (typeof cleanParsed.success === "boolean") {
        return {
          ok: cleanParsed.success,
          data: cleanParsed.data ?? null,
          error: cleanParsed.error ?? (cleanParsed.success ? null : { message: safeRaw }),
          raw: safeRaw,
          exitCode,
        };
      }

      return {
        ok: exitCode === 0,
        data: cleanParsed,
        error: null,
        raw: safeRaw,
        exitCode,
      };
    } catch {
      return {
        ok: exitCode === 0,
        data: null,
        error: exitCode === 0 ? null : { message: safeRaw },
        raw: safeRaw,
        exitCode,
      };
    }
  }
}

module.exports = {
  BawCli,
  ALLOWED_TOP_COMMANDS,
};
