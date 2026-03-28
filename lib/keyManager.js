/**
 * @file keyManager.js
 * @description Gestion de API keys por niveles de servicio (Live, Batch, Embedding)
 * para maximizar cuota y priorizar la experiencia en tiempo real.
 */

class KeyManager {
  constructor() {
    this.tiers = new Map();

    this.registerTier("live", {
      keyConfig: {
        prefix: "GEMINI_LIVE_KEY",
        fallbackPrefixes: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      },
      rpmLimit: 10,
    });

    this.registerTier("batch", {
      keyConfig: {
        prefix: "GEMINI_BATCH_KEY",
        fallbackPrefixes: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      },
      rpmLimit: 15,
    });

    this.registerTier("embedding", {
      keyConfig: {
        prefix: "GEMINI_EMBED_KEY",
        fallbackPrefixes: [
          "GEMINI_EMBED_FALLBACK_KEY",
          "GOOGLE_API_KEY_FALLBACK",
          "GEMINI_API_KEY_FALLBACK",
          "GOOGLE_API_KEY",
          "GEMINI_API_KEY",
        ],
      },
      rpmLimit: 300,
    });
  }

  loadKeys(configOrPrefix) {
    const keyConfig =
      typeof configOrPrefix === "string"
        ? {
            prefix: configOrPrefix,
            fallbackPrefixes: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
          }
        : configOrPrefix || {};
    const keys = [];
    const seen = new Set();

    const collectPrefix = (prefix) => {
      if (!prefix) return;

      const direct = process.env[prefix];
      if (direct && direct.trim() && !seen.has(direct.trim())) {
        seen.add(direct.trim());
        keys.push(direct.trim());
      }

      for (let i = 1; i <= 10; i++) {
        const numbered = process.env[`${prefix}_${i}`];
        if (!numbered || !numbered.trim() || seen.has(numbered.trim())) continue;
        seen.add(numbered.trim());
        keys.push(numbered.trim());
      }
    };

    collectPrefix(keyConfig.prefix);
    for (const fallbackPrefix of keyConfig.fallbackPrefixes || []) {
      collectPrefix(fallbackPrefix);
    }

    return keys;
  }

  registerTier(name, { keyConfig, rpmLimit }) {
    const keys = this.loadKeys(keyConfig);
    this.tiers.set(name, {
      keyConfig,
      keys,
      keyPausedUntil: keys.map(() => 0),
      rpmLimit,
      currentIndex: 0,
      requestCount: 0,
      windowStart: Date.now(),
    });
  }

  parsePauseMs(value, fallbackMs) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return fallbackMs;
      if (/^\d+$/.test(trimmed)) {
        return parseInt(trimmed, 10) * 1000;
      }

      const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
      if (match) {
        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        if (!Number.isFinite(amount)) return fallbackMs;
        if (unit === "ms") return Math.round(amount);
        if (unit === "s") return Math.round(amount * 1000);
        if (unit === "m") return Math.round(amount * 60000);
        if (unit === "h") return Math.round(amount * 3600000);
      }
    }

    return fallbackMs;
  }

  async waitForAvailableKeyIndex(tier) {
    const t = this.tiers.get(tier);
    if (!t || t.keys.length === 0) return -1;

    const now = Date.now();
    let earliestResumeAt = Infinity;

    for (let offset = 0; offset < t.keys.length; offset++) {
      const index = (t.currentIndex + offset) % t.keys.length;
      const pausedUntil = Number(t.keyPausedUntil[index] || 0);
      if (pausedUntil <= now) {
        return index;
      }
      earliestResumeAt = Math.min(earliestResumeAt, pausedUntil);
    }

    if (!Number.isFinite(earliestResumeAt)) {
      return t.currentIndex;
    }

    const waitMs = Math.max(0, earliestResumeAt - now);
    if (waitMs > 300000) {
      throw new Error(
        `[KeyManager] Todas las llaves del nivel "${tier}" estan pausadas por cuota prolongada. ` +
          `Reintenta en ${Math.round(waitMs / 1000)}s.`
      );
    }

    console.log(
      `[KeyManager] Todas las llaves del nivel "${tier}" estan pausadas, esperando ${Math.round(waitMs / 1000)}s...`
    );
    await this.sleep(waitMs);
    return this.waitForAvailableKeyIndex(tier);
  }

  async getKey(tier) {
    const t = this.tiers.get(tier);
    if (!t || t.keys.length === 0) {
      const keys = this.loadKeys(t && t.keyConfig ? t.keyConfig : tier.toUpperCase() + "_KEY");
      if (keys.length > 0) {
        this.registerTier(tier, {
          keyConfig: t && t.keyConfig ? t.keyConfig : { prefix: tier.toUpperCase() + "_KEY" },
          rpmLimit: (t && t.rpmLimit) || 15,
        });
        return this.getKey(tier);
      }
      throw new Error(`[KeyManager] No hay llaves configuradas para el nivel: ${tier}`);
    }

    if (Date.now() - t.windowStart > 60000) {
      t.requestCount = 0;
      t.windowStart = Date.now();
    }

    if (t.requestCount >= t.rpmLimit * 0.8) {
      this.rotate(tier);
    }

    if (tier === "batch" && this.isLiveActive()) {
      console.log("[KeyManager] Actividad Live detectada - Proceso batch cediendo prioridad 3s...");
      await this.sleep(3000);
    }

    const availableIndex = await this.waitForAvailableKeyIndex(tier);
    if (availableIndex >= 0) {
      t.currentIndex = availableIndex;
    }

    t.requestCount++;
    return t.keys[t.currentIndex] || t.keys[0];
  }

  handleRateLimit(tier, retryAfterHeader, metadata = {}) {
    const t = this.tiers.get(tier);
    if (!t) return;

    const scope = metadata.scope || "window";
    const defaultPauseMs = scope === "daily" ? 6 * 60 * 60 * 1000 : 60000;
    const pauseMs = this.parsePauseMs(
      metadata.pauseMs != null ? metadata.pauseMs : retryAfterHeader,
      defaultPauseMs
    );
    const pausedKeyIndex = Number.isInteger(metadata.keyIndex) ? metadata.keyIndex : t.currentIndex;

    if (Array.isArray(t.keyPausedUntil) && pausedKeyIndex >= 0 && pausedKeyIndex < t.keyPausedUntil.length) {
      t.keyPausedUntil[pausedKeyIndex] = Date.now() + pauseMs;
    }

    this.rotate(tier);

    console.warn(
      `[KeyManager] RATE LIMIT en nivel "${tier}". Llave ${pausedKeyIndex} pausada por ${Math.round(
        pauseMs / 1000
      )}s (${scope}). Rotando a llave ${t.currentIndex}.`
    );
  }

  rotate(tier) {
    const t = this.tiers.get(tier);
    if (t && t.keys.length > 1) {
      t.currentIndex = (t.currentIndex + 1) % t.keys.length;
      t.requestCount = 0;
      t.windowStart = Date.now();
    }
  }

  isLiveActive() {
    const live = this.tiers.get("live");
    if (!live) return false;
    return live.requestCount > 0 && Date.now() - live.windowStart < 30000;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStatus() {
    const status = {};
    this.tiers.forEach((config, name) => {
      const now = Date.now();
      const pausedKeys = (config.keyPausedUntil || []).filter((until) => Number(until || 0) > now).length;
      status[name] = {
        totalKeys: config.keys.length,
        activeKeyIndex: config.currentIndex,
        requestsInWindow: config.requestCount,
        rpmLimit: config.rpmLimit,
        pausedKeys,
        isPaused: pausedKeys >= config.keys.length && config.keys.length > 0,
      };
    });
    return status;
  }
}

const keyManager = new KeyManager();
module.exports = { keyManager };
