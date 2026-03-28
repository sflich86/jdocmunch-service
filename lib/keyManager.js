/**
 * @file keyManager.js
 * @description Gestion de API keys por niveles de servicio (Live, Batch, Embedding)
 * para maximizar cuota y priorizar la experiencia en tiempo real.
 */

class KeyManager {
  constructor() {
    this.tiers = new Map();

    // Configuracion de los niveles segun la recomendacion del arquitecto
    this.registerTier("live", {
      keyConfig: {
        prefix: "GEMINI_LIVE_KEY",
        fallbackPrefixes: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      },
      rpmLimit: 10, // Altamente protegido para la voz
    });

    this.registerTier("batch", {
      keyConfig: {
        prefix: "GEMINI_BATCH_KEY",
        fallbackPrefixes: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      },
      rpmLimit: 15, // Para DNA y resumenes
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
      rpmLimit: 300, // Para vectores (GEMINI-EMBEDDING-2-PREVIEW)
    });
  }

  /**
   * Carga llaves del entorno siguiendo el patron PREFIX y PREFIX_N.
   * @param {string | { prefix?: string, fallbackPrefixes?: string[] }} configOrPrefix
   * @returns {string[]}
   */
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
    this.tiers.set(name, {
      keyConfig,
      keys: this.loadKeys(keyConfig),
      rpmLimit,
      currentIndex: 0,
      requestCount: 0,
      windowStart: Date.now(),
      pausedUntil: 0,
    });
  }

  /**
   * Obtiene la llave menos saturada para un nivel dado.
   * @param {string} tier
   * @returns {Promise<string>}
   */
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

    // Verificar si el nivel esta bajo un "Circuit Breaker" temporal
    if (Date.now() < t.pausedUntil) {
      const waitMs = t.pausedUntil - Date.now();
      console.log(
        `[KeyManager] Nivel "${tier}" pausado por rate limit, esperando ${Math.round(waitMs / 1000)}s...`
      );
      await this.sleep(waitMs);
    }

    // Resetear ventana de cuota cada 60 segundos
    if (Date.now() - t.windowStart > 60000) {
      t.requestCount = 0;
      t.windowStart = Date.now();
    }

    // Rotar llave preventivamente si estamos cerca del limite de RPM
    if (t.requestCount >= t.rpmLimit * 0.8) {
      this.rotate(tier);
    }

    // Prioridad critica: si es un proceso pesado (batch) y hay actividad de voz (live), ceder paso
    if (tier === "batch" && this.isLiveActive()) {
      console.log("[KeyManager] Actividad Live detectada - Proceso batch cediendo prioridad 3s...");
      await this.sleep(3000);
    }

    t.requestCount++;
    return t.keys[t.currentIndex] || t.keys[0];
  }

  /**
   * Maneja errores de rate limit (429) rotando y pausando el nivel.
   * @param {string} tier
   * @param {string} retryAfterHeader segundos de espera si Gemini los provee
   */
  handleRateLimit(tier, retryAfterHeader) {
    const t = this.tiers.get(tier);
    if (!t) return;

    this.rotate(tier);

    const pauseMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 60000;

    t.pausedUntil = Date.now() + pauseMs;
    console.warn(
      `[KeyManager] RATE LIMIT en nivel "${tier}". Rotando a llave ${t.currentIndex}. Pausando nivel por ${Math.round(
        pauseMs / 1000
      )}s.`
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

  /**
   * Retorna el estado actual de los niveles (para debug).
   */
  getStatus() {
    const status = {};
    this.tiers.forEach((config, name) => {
      status[name] = {
        totalKeys: config.keys.length,
        activeKeyIndex: config.currentIndex,
        requestsInWindow: config.requestCount,
        rpmLimit: config.rpmLimit,
        isPaused: Date.now() < config.pausedUntil,
      };
    });
    return status;
  }
}

const keyManager = new KeyManager();
module.exports = { keyManager };
