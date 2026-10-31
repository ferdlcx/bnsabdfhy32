const fs = require("node:fs");
const path = require("node:path");
const { redactObject } = require("./redactor");

class SecurityManager {
  constructor(options = {}) {
    this.allowedUserIds =
      options.allowedUserIds instanceof Set
        ? options.allowedUserIds
        : new Set(options.allowedUserIds || []);
    this.killSwitch = Boolean(options.killSwitch);
    this.dataDir = options.dataDir || path.resolve(process.cwd(), "data");
    this.auditLogPath = path.join(this.dataDir, "audit.log");
  }

  isUserAllowed(userId, chatType = "private") {
    if (chatType !== "private") return false;
    if (!userId) return false;
    return this.allowedUserIds.has(Number(userId));
  }

  isKillSwitchActive() {
    return this.killSwitch;
  }

  setKillSwitch(active, actorId = "system") {
    this.killSwitch = Boolean(active);
    this.logAudit("KILL_SWITCH_CHANGED", {
      active: this.killSwitch,
      actorId,
    });
    return this.killSwitch;
  }

  logAudit(event, details = {}) {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const entry = {
        timestamp: new Date().toISOString(),
        event,
        details: redactObject(details),
      };
      fs.appendFileSync(this.auditLogPath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Jangan gagalkan operasi utama jika disk log gagal
    }
  }
}

module.exports = {
  SecurityManager,
};
