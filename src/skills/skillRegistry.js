const fs = require("node:fs");
const path = require("node:path");

class SkillRegistry {
  constructor(options = {}) {
    this.skillsDir = options.skillsDir || path.resolve(process.cwd(), "skills");
    this.registryPath = path.join(this.skillsDir, "registry.json");
    this.ensureInitialized();
  }

  ensureInitialized() {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    if (!fs.existsSync(this.registryPath)) {
      const initial = {
        schemaVersion: "1.0.0",
        updatedAt: new Date().toISOString(),
        skills: {
          "binance-agentic-wallet": {
            slug: "binance-agentic-wallet",
            projectName: "Binance Agentic Wallet (Official Core)",
            sourceUrl:
              "https://raw.githubusercontent.com/binance/binance-skills-hub/main/skills/binance-web3/binance-agentic-wallet/SKILL.md",
            version: "1.15.0",
            lastUpdated: new Date().toISOString(),
            network: { name: "Multi-Chain (BSC, ETH, Solana, Base, Arbitrum)", chainId: "56" },
            apiEndpoints: {},
            contracts: {
              usdt: "0x55d398326f99059fF775485246999027B3197955",
              usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
            },
            functions: [
              { name: "wallet status", selector: null },
              { name: "wallet balance", selector: null },
              { name: "contract-call preview/execute", selector: null },
            ],
            requiredConditions: ["baw CLI >= 1.12.0", "MPC Session Connected"],
            adapter: "core-wallet",
            validationStatus: "VALIDATED",
            contentHash: "builtin-baw-v1.15.0",
          },
          mochi: {
            slug: "mochi",
            projectName: "MOCHI",
            sourceUrl: "https://agenticmochi.xyz/skill.md",
            version: "1.0.0",
            lastUpdated: new Date().toISOString(),
            network: { name: "BNB Smart Chain", chainId: "56" },
            apiEndpoints: {
              stats: "https://agenticmochi.xyz/api/stats",
              verify: "https://agenticmochi.xyz/api/verify?address={wallet}",
              quote: "https://agenticmochi.xyz/api/quote?shares={shares}",
              activity: "https://agenticmochi.xyz/api/activity",
            },
            contracts: {
              mint: "0x045398ef956b4787c782f77319ab0a20cb637da0",
              paymentToken: "0x55d398326f99059fF775485246999027B3197955",
              token: "0x0Eb18EA6Bd86F994FEC4F3580B5206F972433364",
              treasury: "0x17c09Ccd7Aa0A8CA01d4FaD3E00012E2Bb48E3c8",
            },
            functions: [
              {
                signature: "mint(uint256 shares, address referrer, uint256 maxCost)",
                selector: "0x836a1040",
              },
              {
                signature: "quote(uint256 shares)",
                selector: "0xed1bd76c",
              },
              {
                signature: "quoteFor(uint256 agentId, uint256 shares)",
                selector: "0x207c8371",
              },
              {
                signature: "approve(address spender, uint256 amount)",
                selector: "0x095ea7b3",
              },
            ],
            requiredConditions: [
              "Requires .ai Agent ID on BNB Smart Chain",
              "Max 10 shares per identity & per tx",
              "First share FREE (maxCost = 0, no USDT approve required) while global free pool lasts",
            ],
            adapter: "mochi",
            validationStatus: "VALIDATED",
            contentHash: "builtin-mochi-v1",
          },
        },
      };
      this.saveRegistryData(initial);
    }
  }

  loadRegistryData() {
    try {
      const raw = fs.readFileSync(this.registryPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return { schemaVersion: "1.0.0", updatedAt: new Date().toISOString(), skills: {} };
    }
  }

  saveRegistryData(data) {
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2), "utf8");
  }

  listSkills() {
    const data = this.loadRegistryData();
    return Object.values(data.skills || {});
  }

  getSkill(slugOrName) {
    if (!slugOrName) return null;
    const key = String(slugOrName).trim().toLowerCase();
    const data = this.loadRegistryData();
    if (data.skills[key]) return data.skills[key];

    return (
      Object.values(data.skills).find(
        (s) =>
          s.slug.toLowerCase() === key ||
          (s.projectName && s.projectName.toLowerCase() === key)
      ) || null
    );
  }

  upsertSkill(skillEntry, rawMarkdown = null) {
    const slug = String(skillEntry.slug)
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    if (!slug) {
      throw new Error("Slug skill tidak valid.");
    }

    const data = this.loadRegistryData();
    const existing = data.skills[slug];

    let version = skillEntry.version || "1.0.0";
    if (existing && existing.contentHash && existing.contentHash !== skillEntry.contentHash) {
      const parts = String(existing.version || "1.0.0").split(".").map(Number);
      if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
        version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
      }
    } else if (existing) {
      version = existing.version || version;
    }

    const record = {
      ...existing,
      ...skillEntry,
      slug,
      version,
      lastUpdated: new Date().toISOString(),
    };

    data.skills[slug] = record;
    this.saveRegistryData(data);

    const skillFolder = path.join(this.skillsDir, slug);
    if (!fs.existsSync(skillFolder)) {
      fs.mkdirSync(skillFolder, { recursive: true });
    }

    if (rawMarkdown) {
      fs.writeFileSync(path.join(skillFolder, "SKILL.md"), rawMarkdown, "utf8");
    }
    fs.writeFileSync(
      path.join(skillFolder, "metadata.json"),
      JSON.stringify(record, null, 2),
      "utf8"
    );

    return record;
  }

  removeSkill(slugOrName) {
    const key = String(slugOrName || "").trim().toLowerCase();
    if (key === "binance-agentic-wallet") {
      throw new Error("Core skill 'binance-agentic-wallet' tidak dapat dihapus.");
    }
    const data = this.loadRegistryData();
    const target = this.getSkill(key);
    if (!target) return false;

    delete data.skills[target.slug];
    this.saveRegistryData(data);
    return true;
  }
}

module.exports = {
  SkillRegistry,
};
