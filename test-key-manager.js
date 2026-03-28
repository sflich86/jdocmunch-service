const test = require("node:test");
const assert = require("node:assert/strict");

function withEnv(envPatch, run) {
  const original = {};
  const keys = Object.keys(envPatch);

  for (const key of keys) {
    original[key] = process.env[key];
    if (envPatch[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = envPatch[key];
    }
  }

  delete require.cache[require.resolve("./lib/keyManager")];

  try {
    const module = require("./lib/keyManager");
    return run(module.keyManager);
  } finally {
    delete require.cache[require.resolve("./lib/keyManager")];
    for (const key of keys) {
      if (original[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

test("embedding tier loads fallback keys from additional env vars and rotates after rate limit", async () => {
  await withEnv(
    {
      GEMINI_EMBED_KEY_1: "primary-embed-key",
      GOOGLE_API_KEY: "",
      GOOGLE_API_KEY_FALLBACK: "fallback-embed-key",
      GEMINI_API_KEY: "",
      GEMINI_API_KEY_FALLBACK: "",
    },
    async (keyManager) => {
      const status = keyManager.getStatus();
      assert.equal(status.embedding.totalKeys, 2);

      const firstKey = await keyManager.getKey("embedding");
      assert.equal(firstKey, "primary-embed-key");

      keyManager.handleRateLimit("embedding", "60s", { scope: "window" });

      const secondKey = await keyManager.getKey("embedding");
      assert.equal(secondKey, "fallback-embed-key");
      assert.equal(keyManager.getStatus().embedding.pausedKeys, 1);
    }
  );
});
