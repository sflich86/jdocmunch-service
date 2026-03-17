/**
 * @file keyManager.js
 * @description Gestión de API Keys por niveles de servicio (Live, Batch, Embedding) 
 * para maximizar cuota y priorizar la experiencia en tiempo real.
 */

class KeyManager {
  constructor() {
    this.tiers = new Map();
    
    // Configuración de los niveles según la recomendación del arquitecto
    this.registerTier('live', {
      keys: this.loadKeys('GEMINI_LIVE_KEY'),
      rpmLimit: 10 // Altamente protegido para la voz
    });

    this.registerTier('batch', {
      keys: this.loadKeys('GEMINI_BATCH_KEY'),
      rpmLimit: 15 // Para DNA y resúmenes
    });

    this.registerTier('embedding', {
      keys: this.loadKeys('GEMINI_EMBED_KEY'),
      rpmLimit: 300 // Para vectores (GEMINI-EMBEDDING-2-PREVIEW)
    });
  }

  /**
   * Carga llaves del entorno siguiendo el patrón GENRE_KEY_N
   * @param {string} prefix 
   * @returns {string[]}
   */
  loadKeys(prefix) {
    const keys = [];
    for (let i = 1; i <= 10; i++) {
      const key = process.env[`${prefix}_${i}`];
      if (key) keys.push(key.trim());
    }
    
    // Si no hay llaves específicas, intentar con la llave genérica principal
    if (keys.length === 0) {
      const fallback = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (fallback) {
        // En modo fallback, todos los niveles usan la misma llave pero con límites distintos
        keys.push(fallback.trim());
      }
    }
    return keys;
  }

  registerTier(name, { keys, rpmLimit }) {
    this.tiers.set(name, {
      keys,
      rpmLimit,
      currentIndex: 0,
      requestCount: 0,
      windowStart: Date.now(),
      pausedUntil: 0
    });
  }

  /**
   * Obtiene la llave menos saturada para un nivel dado
   * @param {string} tier 
   * @returns {Promise<string>}
   */
  async getKey(tier) {
    const t = this.tiers.get(tier);
    if (!t || t.keys.length === 0) {
      // Intento final: si el tier no tiene llaves, intentar cargar de nuevo (por si se añadieron al env)
      const keys = this.loadKeys(tier.toUpperCase() + '_KEY');
      if (keys.length > 0) {
        this.registerTier(tier, { keys, rpmLimit: t?.rpmLimit || 15 });
        return this.getKey(tier);
      }
      throw new Error(`[KeyManager] No hay llaves configuradas para el nivel: ${tier}`);
    }

    // Verificar si el nivel está bajo un "Circuit Breaker" temporal
    if (Date.now() < t.pausedUntil) {
      const waitMs = t.pausedUntil - Date.now();
      console.log(`[KeyManager] Nivel "${tier}" pausado por rate limit, esperando ${Math.round(waitMs/1000)}s...`);
      await this.sleep(waitMs);
    }

    // Resetear ventana de cuota cada 60 segundos
    if (Date.now() - t.windowStart > 60000) {
      t.requestCount = 0;
      t.windowStart = Date.now();
    }

    // Rotar llave preventivamente si estamos cerca del límite de RPM
    if (t.requestCount >= t.rpmLimit * 0.8) {
      this.rotate(tier);
    }

    // PRIORIDAD CRÍTICA: Si es un proceso pesado (batch) y hay actividad de voz (live), ceder paso
    if (tier === 'batch' && this.isLiveActive()) {
      console.log('[KeyManager] Actividad Live detectada - Proceso batch cediendo prioridad 3s...');
      await this.sleep(3000);
    }

    t.requestCount++;
    return t.keys[t.currentIndex] || t.keys[0];
  }

  /**
   * Maneja errores de Rate Limit (429) rotando y pausando el nivel
   * @param {string} tier 
   * @param {string} retryAfterHeader segundos de espera si Gemini los provee
   */
  handleRateLimit(tier, retryAfterHeader) {
    const t = this.tiers.get(tier);
    if (!t) return;

    this.rotate(tier);
    
    // Pausa por defecto 60s si no hay header
    const pauseMs = retryAfterHeader 
      ? parseInt(retryAfterHeader) * 1000 
      : 60000;

    t.pausedUntil = Date.now() + pauseMs;
    console.warn(`[KeyManager] 🚨 RATE LIMIT en nivel "${tier}". Rotando a llave ${t.currentIndex}. Pausando nivel por ${Math.round(pauseMs/1000)}s.`);
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
    const live = this.tiers.get('live');
    if (!live) return false;
    // Si ha habido llamadas de voz en los últimos 30 segundos, se considera activo
    return live.requestCount > 0 && (Date.now() - live.windowStart) < 30000;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retorna el estado actual de los niveles (para debug)
   */
  getStatus() {
    const status = {};
    this.tiers.forEach((config, name) => {
      status[name] = {
        totalKeys: config.keys.length,
        activeKeyIndex: config.currentIndex,
        requestsInWindow: config.requestCount,
        rpmLimit: config.rpmLimit,
        isPaused: Date.now() < config.pausedUntil
      };
    });
    return status;
  }
}

// Singleton para toda la aplicación
const keyManager = new KeyManager();
module.exports = { keyManager };
