const crypto = require("node:crypto");
const { safeFetchText } = require("../security/ssrfGuard");
const { validateSkillDocument } = require("./skillValidator");

/**
 * Universal Skill Loader:
 * Mengambil, mem-parsing, memvalidasi, dan menyimpan SKILL.md / dokumentasi project Web3 secara deterministik.
 */
class UniversalSkillLoader {
  constructor(options = {}) {
    this.registry = options.registry;
    this.txGuard = options.txGuard || null;
    this.fetchTextFn = options.fetchTextFn || safeFetchText;
  }

  /**
   * Menghasilkan daftar kandidat URL dokumentasi jika pengguna mengirim URL homepage atau /SKILL.md.
   * Menangani kasus seperti https://agenticmochi.xyz di mana /SKILL.md timeout tapi /skill.md aktif.
   */
  buildCandidateUrls(inputUrl) {
    const parsed = new URL(String(inputUrl).trim());
    const candidates = [parsed.toString()];

    if (/\/SKILL\.md$/i.test(parsed.pathname)) {
      const lowerUrl = new URL(parsed.toString());
      lowerUrl.pathname = parsed.pathname.replace(/\/SKILL\.md$/i, "/skill.md");
      if (!candidates.includes(lowerUrl.toString())) {
        candidates.push(lowerUrl.toString());
      }
      const upperUrl = new URL(parsed.toString());
      upperUrl.pathname = parsed.pathname.replace(/\/skill\.md$/i, "/SKILL.md");
      if (!candidates.includes(upperUrl.toString())) {
        candidates.push(upperUrl.toString());
      }
    } else if (parsed.pathname === "/" || parsed.pathname === "") {
      const skillLower = new URL("/skill.md", parsed.origin).toString();
      const skillUpper = new URL("/SKILL.md", parsed.origin).toString();
      candidates.unshift(skillLower, skillUpper);
    }

    return [...new Set(candidates)];
  }

  /**
   * Mengidentifikasi metadata dari teks Markdown atau JSON secara deterministik.
   */
  parseSkillContent(rawText, sourceUrl) {
    const parsedUrl = new URL(sourceUrl);
    const hostSlug = parsedUrl.hostname
      .replace(/^www\./i, "")
      .replace(/\.[a-z]+$/i, "")
      .replace(/^agentic/i, "")
      .toLowerCase();

    // 1. Cek apakah konten berupa JSON langsung
    let jsonObj = null;
    try {
      if (rawText.trim().startsWith("{")) {
        jsonObj = JSON.parse(rawText);
      }
    } catch {
      jsonObj = null;
    }

    if (jsonObj) {
      const slug = (jsonObj.symbol || jsonObj.name || hostSlug || "project").toLowerCase();
      return {
        slug,
        projectName: jsonObj.name || jsonObj.symbol || slug.toUpperCase(),
        sourceUrl,
        network: {
          name: jsonObj.chainId === 56 ? "BNB Smart Chain" : `Chain ${jsonObj.chainId || 56}`,
          chainId: String(jsonObj.chainId || "56"),
        },
        apiEndpoints: {
          stats: new URL("/api/stats", parsedUrl.origin).toString(),
          verify: new URL("/api/verify?address={wallet}", parsedUrl.origin).toString(),
          quote: new URL("/api/quote?shares={shares}", parsedUrl.origin).toString(),
        },
        contracts: {
          mint: jsonObj.contract || null,
          token: jsonObj.token || null,
          paymentToken: jsonObj.paymentToken || null,
          registry: jsonObj.registry || null,
        },
        functions: [],
        requiredConditions: jsonObj.requiresAgentId ? ["Requires .ai Agent ID"] : [],
      };
    }

    // 2. Parsing Markdown (SKILL.md / skill.md)
    const titleMatch = rawText.match(/^#\s+([^\n]+)/m);
    let projectName = titleMatch
      ? titleMatch[1].replace(/\s+(mint\s+guide|skill|documentation).*/i, "").trim()
      : (hostSlug || "CustomSkill").toUpperCase();

    const slug = projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || hostSlug || "custom-skill";

    // Network detection
    let chainId = "56";
    let chainName = "BNB Smart Chain";
    const chainMatch = rawText.match(/chainId\s*[:=]?\s*(\d+)/i);
    if (chainMatch) {
      chainId = chainMatch[1];
    }

    // Extract contract addresses with context (hanya cocokkan tepat 40 karakter hex dengan word boundary \b)
    const contracts = {};
    const mintContractMatch = rawText.match(/Mint\s+contract[^\n`]*`?\b(0x[a-fA-F0-9]{40})\b`?/i);
    if (mintContractMatch) contracts.mint = mintContractMatch[1];

    const usdtMatch = rawText.match(/-\s*USDT[^\n`]*`?\b(0x[a-fA-F0-9]{40})\b`?/i);
    if (usdtMatch) contracts.paymentToken = usdtMatch[1];

    const tokenMatch = rawText.match(/-\s*([A-Z0-9]{2,10})\s+token[^\n`]*`?\b(0x[a-fA-F0-9]{40})\b`?/i);
    if (tokenMatch) contracts.token = tokenMatch[2];

    const treasuryMatch = rawText.match(/Treasury[^\n`]*`?\b(0x[a-fA-F0-9]{40})\b`?/i);
    if (treasuryMatch) contracts.treasury = treasuryMatch[1];

    // Fallback: kumpulkan semua alamat 0x... unik (tepat 40 hex chars, bukan bagian dari calldata panjang)
    const allAddresses = [...new Set(rawText.match(/\b0x[a-fA-F0-9]{40}\b/g) || [])];
    if (Object.keys(contracts).length === 0 && allAddresses.length > 0) {
      allAddresses.forEach((addr, idx) => {
        contracts[`contract_${idx + 1}`] = addr;
      });
    }

    // Extract API endpoints
    const apiEndpoints = {};
    const urlMatches = rawText.match(/https?:\/\/[^\s)`"'>]+/g) || [];
    for (const u of urlMatches) {
      if (u.includes("/api/stats")) apiEndpoints.stats = u;
      else if (u.includes("/api/verify")) apiEndpoints.verify = u;
      else if (u.includes("/api/quote")) apiEndpoints.quote = u;
      else if (u.includes("/api/activity")) apiEndpoints.activity = u;
    }

    // Extract function signatures & 4-byte selectors
    const functions = [];
    const fnRegex = /`([a-zA-Z0-9_]+\([^`]*\))`\s*(?:\(selector\s*`(0x[a-fA-F0-9]{8})`\)|selector\s*`(0x[a-fA-F0-9]{8})`)/gi;
    let match;
    while ((match = fnRegex.exec(rawText)) !== null) {
      functions.push({
        signature: match[1],
        selector: (match[2] || match[3] || "").toLowerCase(),
      });
    }

    // Extract required conditions & limits
    const requiredConditions = [];
    if (/\.ai\s+Agent\s+ID/i.test(rawText)) {
      requiredConditions.push("Requires .ai Agent ID");
    }
    const maxPerTxMatch = rawText.match(/Max\s+(\d+\s+shares\s+per\s+transaction)/i);
    if (maxPerTxMatch) {
      requiredConditions.push(`Max ${maxPerTxMatch[1]}`);
    }
    const quotaMatch = rawText.match(/quota\s+of\s+(\d+\s+shares)/i);
    if (quotaMatch) {
      requiredConditions.push(`Quota ${quotaMatch[1]} per identity`);
    }
    if (/first\s+share\s+[^\n]*free/i.test(rawText)) {
      requiredConditions.push("Free first share available (maxCost = 0)");
    }

    // Adapter matching
    let adapter = "generic-contract-call";
    if (
      slug === "mochi" ||
      parsedUrl.hostname.toLowerCase().includes("agenticmochi.xyz") ||
      (contracts.mint &&
        contracts.mint.toLowerCase() === "0x045398ef956b4787c782f77319ab0a20cb637da0")
    ) {
      adapter = "mochi";
    }

    return {
      slug,
      projectName,
      sourceUrl,
      network: { name: chainName, chainId },
      apiEndpoints,
      contracts,
      functions,
      requiredConditions,
      adapter,
    };
  }

  /**
   * Mengambil dan mendaftarkan skill dari URL eksternal.
   */
  async loadFromUrl(inputUrl, options = {}) {
    const candidates = this.buildCandidateUrls(inputUrl);
    let fetched = null;
    const errors = [];

    for (const candidateUrl of candidates) {
      try {
        const res = await this.fetchTextFn(candidateUrl, { timeoutMs: 8000 });
        if (res && res.text && res.text.trim().length > 0) {
          fetched = res;
          break;
        }
      } catch (err) {
        errors.push(`${candidateUrl}: ${err.message}`);
      }
    }

    if (!fetched) {
      throw new Error(
        `Gagal mengambil dokumentasi skill dari URL yang diberikan.\nDetail: ${errors.join(" | ")}`
      );
    }

    // Jika halaman yang terambil adalah HTML homepage (bukan Markdown), cek apakah ada link ke /skill.md atau /api/stats
    let finalText = fetched.text;
    let finalUrl = fetched.url;
    if (
      (fetched.contentType.includes("text/html") || finalText.trim().startsWith("<!doctype html")) &&
      !options._followedHtmlLink
    ) {
      const origin = new URL(finalUrl).origin;
      const skillLinkMatch = finalText.match(/href=["'](\/skill\.md|\/SKILL\.md)["']/i);
      if (skillLinkMatch) {
        const linkedUrl = new URL(skillLinkMatch[1], origin).toString();
        try {
          const mdRes = await this.fetchTextFn(linkedUrl, { timeoutMs: 8000 });
          finalText = mdRes.text;
          finalUrl = mdRes.url;
        } catch {
          // Lanjutkan menggunakan HTML jika gagal
        }
      } else if (finalText.includes("/api/stats")) {
        try {
          const statsUrl = new URL("/api/stats", origin).toString();
          const statsRes = await this.fetchTextFn(statsUrl, { timeoutMs: 8000 });
          finalText = statsRes.text;
          finalUrl = statsRes.url;
        } catch {
          // Lanjutkan menggunakan HTML
        }
      }
    }

    const contentHash = crypto.createHash("sha256").update(finalText).digest("hex");
    const parsedMeta = this.parseSkillContent(finalText, finalUrl);

    // Cek cache di registry jika konten tidak berubah
    const existing = this.registry ? this.registry.getSkill(parsedMeta.slug) : null;
    if (existing && existing.contentHash === contentHash && !options.force) {
      return {
        cached: true,
        skill: existing,
        validation: {
          safe: existing.validationStatus !== "BLOCKED_UNSAFE",
          status: existing.validationStatus,
          issues: [],
          warnings: [],
        },
      };
    }

    const validation = validateSkillDocument(finalText, parsedMeta);
    const skillEntry = {
      ...parsedMeta,
      contentHash,
      validationStatus: validation.status,
      validationIssues: validation.issues,
      validationWarnings: validation.warnings,
    };

    if (validation.safe && this.registry) {
      const saved = this.registry.upsertSkill(skillEntry, finalText);

      // Daftarkan kontrak yang tervalidasi ke TransactionGuard allowlist
      if (this.txGuard && saved.contracts) {
        for (const [role, addr] of Object.entries(saved.contracts)) {
          if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
            this.txGuard.allowContract(addr, {
              name: `${saved.projectName} (${role})`,
              chainId: saved.network?.chainId || "56",
              type: role,
            });
          }
        }
      }

      return {
        cached: false,
        skill: saved,
        validation,
      };
    }

    return {
      cached: false,
      skill: skillEntry,
      validation,
    };
  }
}

module.exports = {
  UniversalSkillLoader,
};
