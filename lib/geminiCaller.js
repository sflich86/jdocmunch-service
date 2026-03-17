/**
 * @file geminiCaller.js
 * @description Wrapper robusto para llamadas a la API de Gemini.
 * Gestiona reintentos con backoff adaptativo (basado en Retry-After si existe)
 * e integración directa con el KeyManager para rotación de llaves.
 */

const { keyManager } = require('./keyManager');
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Ejecuta una función que llama a Gemini con reintentos y gestión de cuota.
 * 
 * @param {Function} fn - Función que recibe la apiKey y retorna el resultado (ej: () => model.generateContent(...))
 * @param {Object} options - Opciones de la llamada
 * @param {string} options.tier - 'live' | 'batch' | 'embedding'
 * @param {number} [options.maxRetries=5] - Máximo de reintentos
 * @param {string} [options.description=''] - Descripción para logs
 * @returns {Promise<any>}
 */
async function callGemini(fn, options) {
  const { tier, maxRetries = 5, description = 'unknown' } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const apiKey = await keyManager.getKey(tier);

    try {
      // Nota: El cliente de genAI debe inicializarse con la llave obtenida
      return await fn(apiKey);
    } catch (error) {
      const status = error.status || (error.response && error.response.status);
      const isQuota = status === 429 || 
                      error.message?.includes('RESOURCE_EXHAUSTED') || 
                      error.message?.includes('429');

      if (isQuota && attempt < maxRetries) {
        // Extraer Retry-After si Gemini lo provee (en segundos)
        const retryAfter = error.headers?.get?.('Retry-After') || 
                           (error.errorDetails && error.errorDetails[0]?.metadata?.retryAfter);
        
        // Notificar al KeyManager para que rotación y pausa ocurran
        keyManager.handleRateLimit(tier, retryAfter);

        // Calcular delay: proporcional a los segundos de Retry-After o backoff exponencial base
        const baseDelay = retryAfter 
          ? (parseInt(retryAfter) * 1000) 
          : (2000 * Math.pow(2, attempt - 1));

        // Jitter ±25% para evitar "thundering herd"
        const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
        const delay = Math.min(baseDelay + jitter, 120000); // Tope de 2 minutos

        console.warn(
          `[GeminiCaller] 🚨 Cuota agotada en "${description}" (Nivel: ${tier}). ` +
          `Intento ${attempt}/${maxRetries}. Esperando ${Math.round(delay/1000)}s...`
        );

        await new Promise(resolve => setTimeout(resolve, delay));
        continue; // Reintentar con la siguiente llave del pool
      }

      // Si no es un error de cuota o agotamos reintentos, lanzamos el error
      console.error(`[GeminiCaller] ❌ Error fatal en "${description}":`, error.message);
      throw error;
    }
  }

  throw new Error(`[GeminiCaller] Agotados ${maxRetries} reintentos para "${description}" en nivel "${tier}"`);
}

module.exports = { callGemini };
