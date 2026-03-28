const test = require("node:test");
const assert = require("node:assert/strict");

function loadGeminiCallerWithStubs(stubs) {
  const callerPath = require.resolve("./lib/geminiCaller");
  const keyManagerPath = require.resolve("./lib/keyManager");
  const originalCaller = require.cache[callerPath];
  const originalKeyManager = require.cache[keyManagerPath];

  delete require.cache[callerPath];
  require.cache[keyManagerPath] = {
    id: keyManagerPath,
    filename: keyManagerPath,
    loaded: true,
    exports: {
      keyManager: stubs.keyManager
    }
  };

  const geminiCaller = require("./lib/geminiCaller");
  return {
    geminiCaller,
    restore: function() {
      delete require.cache[callerPath];
      if (originalCaller) {
        require.cache[callerPath] = originalCaller;
      }
      if (originalKeyManager) {
        require.cache[keyManagerPath] = originalKeyManager;
      } else {
        delete require.cache[keyManagerPath];
      }
    }
  };
}

test("extractQuotaErrorInfo classifies daily quotas and parses retry delay", function() {
  const { geminiCaller, restore } = loadGeminiCallerWithStubs({
    keyManager: {
      getKey: async function() {
        return "unused";
      },
      handleRateLimit: function() {}
    }
  });

  try {
    const info = geminiCaller.extractQuotaErrorInfo({
      status: 429,
      errorDetails: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaId: "EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier",
              quotaMetric: "generativelanguage.googleapis.com/embed_content_free_tier_requests"
            }
          ]
        },
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "52s"
        }
      ]
    });

    assert.equal(info.isQuota, true);
    assert.equal(info.scope, "daily");
    assert.equal(info.retryDelayMs, 52000);
    assert.equal(info.quotaId, "EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier");
  } finally {
    restore();
  }
});

test("callGemini rotates immediately to another key on daily quota exhaustion", async function() {
  const handled = [];
  const keys = ["key-a", "key-b"];
  let keyIndex = 0;
  const { geminiCaller, restore } = loadGeminiCallerWithStubs({
    keyManager: {
      getKey: async function() {
        const key = keys[Math.min(keyIndex, keys.length - 1)];
        keyIndex += 1;
        return key;
      },
      handleRateLimit: function(tier, retryAfterHeader, metadata) {
        handled.push({ tier, retryAfterHeader, metadata });
      }
    }
  });

  try {
    const result = await geminiCaller.callGemini(async function(apiKey) {
      if (apiKey === "key-a") {
        const err = new Error("quota");
        err.status = 429;
        err.errorDetails = [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaId: "EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier",
                quotaMetric: "generativelanguage.googleapis.com/embed_content_free_tier_requests"
              }
            ]
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "52s"
          }
        ];
        throw err;
      }
      return "ok";
    }, {
      tier: "embedding",
      maxRetries: 2,
      description: "semantic-batch-embed:RETRIEVAL_DOCUMENT"
    });

    assert.equal(result, "ok");
    assert.equal(handled.length, 1);
    assert.equal(handled[0].metadata.scope, "daily");
    assert.equal(handled[0].retryAfterHeader, "52s");
  } finally {
    restore();
  }
});
