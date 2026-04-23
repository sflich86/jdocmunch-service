/**
 * @file geminiCaller.js
 * @description Wrapper robusto para llamadas a Gemini.
 * Distingue cuota diaria vs ventana corta y coordina la rotacion de llaves.
 */

const { keyManager } = require("./keyManager");

function parseDelayMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000;

    const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
    if (match) {
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (!Number.isFinite(amount)) return 0;
      if (unit === "ms") return Math.round(amount);
      if (unit === "s") return Math.round(amount * 1000);
      if (unit === "m") return Math.round(amount * 60000);
      if (unit === "h") return Math.round(amount * 3600000);
    }
  }

  return 0;
}

function extractRetryDelayMs(error) {
  const retryHeader = error && error.headers && typeof error.headers.get === "function"
    ? error.headers.get("Retry-After")
    : null;
  if (retryHeader) {
    return {
      retryAfterHeader: retryHeader,
      retryDelayMs: parseDelayMs(retryHeader),
    };
  }

  const details = Array.isArray(error && error.errorDetails) ? error.errorDetails : [];
  for (const detail of details) {
    if (detail && detail.retryDelay) {
      return {
        retryAfterHeader: detail.retryDelay,
        retryDelayMs: parseDelayMs(detail.retryDelay),
      };
    }

    if (detail && detail.metadata && detail.metadata.retryAfter) {
      return {
        retryAfterHeader: detail.metadata.retryAfter,
        retryDelayMs: parseDelayMs(detail.metadata.retryAfter),
      };
    }
  }

  return {
    retryAfterHeader: null,
    retryDelayMs: 0,
  };
}

function extractQuotaViolations(error) {
  const details = Array.isArray(error && error.errorDetails) ? error.errorDetails : [];
  const violations = [];

  for (const detail of details) {
    const list = detail && Array.isArray(detail.violations) ? detail.violations : [];
    for (const violation of list) {
      violations.push(violation || {});
    }
  }

  return violations;
}

function classifyQuotaScope(parts) {
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return "window";
  if (haystack.includes("perday") || haystack.includes("per day") || haystack.includes("requestsperday")) {
    return "daily";
  }
  return "window";
}

function extractQuotaErrorInfo(error) {
  const status = error && (error.status || (error.response && error.response.status));
  const message = String((error && error.message) || "");
  const isQuota =
    status === 429 ||
    status === 503 ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("Service Unavailable");

  const retry = extractRetryDelayMs(error);
  const violations = extractQuotaViolations(error);
  const primaryViolation = violations[0] || {};
  const quotaId = primaryViolation.quotaId || "";
  const quotaMetric = primaryViolation.quotaMetric || "";
  const scope = classifyQuotaScope([quotaId, quotaMetric, message]);

  return {
    isQuota,
    status,
    message,
    quotaId,
    quotaMetric,
    scope,
    retryAfterHeader: retry.retryAfterHeader,
    retryDelayMs: retry.retryDelayMs,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(fn, options) {
  const { tier, maxRetries = 5, description = "unknown", sleepFn = sleep } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const apiKey = await keyManager.getKey(tier);

    try {
      return await fn(apiKey);
    } catch (error) {
      const quotaInfo = extractQuotaErrorInfo(error);

      if (quotaInfo.isQuota && attempt < maxRetries) {
        keyManager.handleRateLimit(tier, quotaInfo.retryAfterHeader, {
          scope: quotaInfo.scope,
        });

        const baseDelay =
          quotaInfo.scope === "daily"
            ? 0
            : quotaInfo.retryDelayMs || 2000 * Math.pow(2, attempt - 1);
        const jitter = baseDelay > 0 ? baseDelay * 0.25 * (Math.random() * 2 - 1) : 0;
        const delay = Math.max(0, Math.min(baseDelay + jitter, 120000));

        console.warn(
          `[GeminiCaller] 🚨 Cuota agotada en "${description}" (Nivel: ${tier}, scope: ${quotaInfo.scope}). ` +
            `Intento ${attempt}/${maxRetries}. Esperando ${Math.round(delay / 1000)}s...`
        );

        if (delay > 0) {
          await sleepFn(delay);
        }
        continue;
      }

      console.error(`[GeminiCaller] ❌ Error fatal en "${description}":`, error.message);
      throw error;
    }
  }

  throw new Error(`[GeminiCaller] Agotados ${maxRetries} reintentos para "${description}" en nivel "${tier}"`);
}

module.exports = {
  callGemini,
  extractQuotaErrorInfo,
  extractRetryDelayMs,
};
