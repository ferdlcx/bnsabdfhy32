const crypto = require("node:crypto");
const { redactText } = require("../security/redactor");

/**
 * Deterministic Natural Language Intent Parser (Fallback ketika AI tidak dikonfigurasi atau terkena limit).
 * Memastikan instruksi bahasa alami umum tetap berjalan 100% tanpa biaya token AI.
 */
function parseDeterministicIntent(instruction = "") {
  const text = String(instruction || "").trim();
  const lower = text.toLowerCase();

  // 1. URL / Skill import
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch && (lower.includes("skill") || lower.includes("import") || lower.includes("pelajari") || lower.includes("baca"))) {
    return {
      provider: "deterministic-fallback",
      intent: "ADD_SKILL",
      project: null,
      params: { url: urlMatch[0] },
      explanation: `Mendeteksi permintaan import skill dari URL ${urlMatch[0]}.`,
    };
  }

  // 2. MOCHI Mint
  if (lower.includes("mochi") && lower.includes("mint")) {
    const numMatch = lower.match(/\b(\d+)\s*(share|shares)?\b/);
    const shares = numMatch ? Number(numMatch[1]) : 1;
    return {
      provider: "deterministic-fallback",
      intent: "MOCHI_MINT_PREVIEW",
      project: "mochi",
      params: { shares },
      explanation: `Menyiapkan preview transaksi mint ${shares} share MOCHI (memerlukan konfirmasi pengguna).`,
    };
  }

  // 3. MOCHI Quote
  if (lower.includes("mochi") && (lower.includes("quote") || lower.includes("harga") || lower.includes("biaya"))) {
    const numMatch = lower.match(/\b(\d+)\s*(share|shares)?\b/);
    const shares = numMatch ? Number(numMatch[1]) : 1;
    return {
      provider: "deterministic-fallback",
      intent: "PROJECT_QUOTE",
      project: "mochi",
      params: { shares },
      explanation: `Menghitung estimasi biaya mint ${shares} share MOCHI.`,
    };
  }

  // 4. MOCHI Eligibility / Check
  if (lower.includes("mochi") && (lower.includes("cek") || lower.includes("check") || lower.includes("eligible") || lower.includes("syarat"))) {
    return {
      provider: "deterministic-fallback",
      intent: "PROJECT_CHECK",
      project: "mochi",
      params: {},
      explanation: "Memeriksa status eligibility wallet dan .ai Agent ID untuk project MOCHI.",
    };
  }

  // 5. MOCHI Stats
  if (lower.includes("mochi")) {
    return {
      provider: "deterministic-fallback",
      intent: "MOCHI_STATS",
      project: "mochi",
      params: {},
      explanation: "Menampilkan statistik live project MOCHI.",
    };
  }

  // 6. Wallet Balance
  if (lower.includes("saldo") || lower.includes("balance") || lower.includes("aset")) {
    return {
      provider: "deterministic-fallback",
      intent: "WALLET_BALANCE",
      project: null,
      params: {},
      explanation: "Memeriksa saldo aset di Binance Agentic Wallet.",
    };
  }

  // 7. Wallet Info / Agent ID
  if (lower.includes("wallet") || lower.includes("dompet") || lower.includes("address") || lower.includes("agent id")) {
    return {
      provider: "deterministic-fallback",
      intent: "WALLET_INFO",
      project: null,
      params: {},
      explanation: "Menampilkan informasi alamat wallet dan status .ai Agent ID.",
    };
  }

  // 8. Check EVM Contract Address
  const addrMatch = text.match(/\b(0x[a-fA-F0-9]{40})\b/);
  if (addrMatch) {
    return {
      provider: "deterministic-fallback",
      intent: "INSPECT_ADDRESS",
      project: null,
      params: { address: addrMatch[1] },
      explanation: `Memindai keamanan dan informasi on-chain untuk alamat ${addrMatch[1]}.`,
    };
  }

  return {
    provider: "deterministic-fallback",
    intent: "UNKNOWN",
    project: null,
    params: {},
    explanation:
      "Instruksi tidak dikenali oleh parser deterministik dan AI provider sedang tidak aktif/limit. Gunakan command langsung seperti `/mochi check`, `/mochi quote 1`, `/mochi mint 1`, `/wallet`, atau `/balance`.",
  };
}

class AIRouter {
  constructor(options = {}) {
    this.geminiApiKey = options.geminiApiKey || process.env.GEMINI_API_KEY || "";
    this.geminiModel = options.geminiModel || process.env.GEMINI_MODEL || "gemini-2.5-flash";
    this.openaiCompatApiKey = options.openaiCompatApiKey || process.env.OPENAI_COMPAT_API_KEY || "";
    this.openaiCompatBaseUrl =
      options.openaiCompatBaseUrl ||
      process.env.OPENAI_COMPAT_BASE_URL ||
      "https://api.groq.com/openai/v1";
    this.openaiCompatModel =
      options.openaiCompatModel || process.env.OPENAI_COMPAT_MODEL || "llama-3.3-70b-versatile";

    this.timeoutMs = Number(options.timeoutMs || 20000);
    this.maxCallsPerHour = Number(options.maxCallsPerHour || 30);
    this.maxTokensPerCall = Number(options.maxTokensPerCall || 1024);
    this.fetchFn = options.fetchFn || fetch;

    this.callTimestamps = [];
    this.cache = new Map();
    this.providerCooldownUntil = new Map();
  }

  getStatus() {
    this.pruneCallTimestamps();
    return {
      geminiConfigured: Boolean(this.geminiApiKey),
      geminiModel: this.geminiModel,
      secondaryConfigured: Boolean(this.openaiCompatApiKey),
      secondaryModel: this.openaiCompatModel,
      callsLastHour: this.callTimestamps.length,
      maxCallsPerHour: this.maxCallsPerHour,
      cacheSize: this.cache.size,
    };
  }

  pruneCallTimestamps() {
    const oneHourAgo = Date.now() - 3600 * 1000;
    this.callTimestamps = this.callTimestamps.filter((ts) => ts > oneHourAgo);
  }

  canSpendQuota() {
    this.pruneCallTimestamps();
    return this.callTimestamps.length < this.maxCallsPerHour;
  }

  isProviderCoolingDown(name) {
    const until = this.providerCooldownUntil.get(name) || 0;
    return Date.now() < until;
  }

  setProviderCooldown(name, durationMs = 60000) {
    this.providerCooldownUntil.set(name, Date.now() + durationMs);
  }

  /**
   * Menyusun konteks minimal dari Skill Registry agar hemat token.
   */
  buildCompactContext(skills = []) {
    return skills.map((s) => ({
      slug: s.slug,
      name: s.projectName,
      chainId: s.network?.chainId,
      adapter: s.adapter,
      conditions: s.requiredConditions,
    }));
  }

  /**
   * Menganalisis instruksi natural language (/task <instruction>) dan mengembalikan rencana terstruktur.
   * AI tidak pernah mengeksekusi transaksi secara langsung.
   */
  async routeTaskInstruction(instruction, registeredSkills = []) {
    const cleanInstruction = redactText(String(instruction || "").trim()).slice(0, 600);
    if (!cleanInstruction) {
      return parseDeterministicIntent("");
    }

    // 1. Cek apakah instruksi sudah sangat jelas secara deterministik (menghemat 100% token AI!)
    const det = parseDeterministicIntent(cleanInstruction);
    if (det.intent !== "UNKNOWN") {
      return det;
    }

    // 2. Cek Cache
    const cacheKey = crypto.createHash("sha256").update(cleanInstruction.toLowerCase()).digest("hex");
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
      return { ...cached.value, cached: true };
    }

    // 3. Cek Token / Call Budget
    if (!this.canSpendQuota()) {
      return {
        ...det,
        explanation: "Kuota panggilan AI per jam telah mencapai batas hemat budget. Menggunakan fallback deterministik.",
      };
    }

    const compactSkills = this.buildCompactContext(registeredSkills);
    const systemPrompt = [
      "You are the AI Reasoning Planner for the Binance Agentic Wallet Automation Engine.",
      "You NEVER sign or execute transactions directly. You only classify the user request into a safe JSON plan.",
      `Registered skills: ${JSON.stringify(compactSkills)}`,
      "Respond ONLY with valid JSON matching this schema:",
      '{"intent":"WALLET_INFO|WALLET_BALANCE|MOCHI_STATS|PROJECT_CHECK|PROJECT_QUOTE|MOCHI_MINT_PREVIEW|ADD_SKILL|INSPECT_ADDRESS|GENERAL_HELP","project":"mochi|null","params":{"shares":1,"url":"","address":""},"explanation":"Penjelasan singkat dalam Bahasa Indonesia"}',
    ].join("\n");

    const providers = [];
    if (this.geminiApiKey && !this.isProviderCoolingDown("gemini")) {
      providers.push({ name: "gemini", fn: () => this.callGemini(systemPrompt, cleanInstruction) });
    }
    if (this.openaiCompatApiKey && !this.isProviderCoolingDown("openai-compat")) {
      providers.push({
        name: "openai-compat",
        fn: () => this.callOpenAICompat(systemPrompt, cleanInstruction),
      });
    }

    for (const provider of providers) {
      try {
        this.callTimestamps.push(Date.now());
        const rawJson = await this.withRetry(provider.fn, 1);
        const parsed = this.extractJson(rawJson);
        if (parsed && parsed.intent) {
          const result = {
            provider: provider.name,
            intent: String(parsed.intent),
            project: parsed.project || null,
            params: parsed.params || {},
            explanation: parsed.explanation || "Rencana task berhasil disusun.",
          };
          this.cache.set(cacheKey, { timestamp: Date.now(), value: result });
          return result;
        }
      } catch (err) {
        if (String(err.message).includes("429") || String(err.message).toLowerCase().includes("rate")) {
          this.setProviderCooldown(provider.name, 120000);
        }
      }
    }

    return det;
  }

  async withRetry(fn, retries = 1) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  async callGemini(systemPrompt, userPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.geminiModel
    )}:generateContent?key=${encodeURIComponent(this.geminiApiKey)}`;

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: this.maxTokensPerCall,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Gemini API HTTP ${res.status}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) throw new Error("Empty response from Gemini API");
    return text;
  }

  async callOpenAICompat(systemPrompt, userPrompt) {
    const base = this.openaiCompatBaseUrl.replace(/\/+$/, "");
    const url = `${base}/chat/completions`;

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.openaiCompatApiKey}`,
      },
      body: JSON.stringify({
        model: this.openaiCompatModel,
        temperature: 0.1,
        max_tokens: this.maxTokensPerCall,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Secondary AI HTTP ${res.status}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("Empty response from Secondary AI");
    return text;
  }

  extractJson(rawText) {
    const text = String(rawText || "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

module.exports = {
  AIRouter,
  parseDeterministicIntent,
};
