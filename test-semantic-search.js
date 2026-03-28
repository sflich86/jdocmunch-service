const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

  try {
    return run();
  } finally {
    for (const key of keys) {
      if (original[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

function loadSemanticSearchWithStubs(stubs) {
  const semanticPath = require.resolve("./lib/semanticSearch");
  const geminiCallerPath = require.resolve("./lib/geminiCaller");
  const dbPath = require.resolve("./lib/db");
  const originalSemantic = require.cache[semanticPath];
  const originalGeminiCaller = require.cache[geminiCallerPath];
  const originalDb = require.cache[dbPath];

  delete require.cache[semanticPath];
  require.cache[geminiCallerPath] = {
    id: geminiCallerPath,
    filename: geminiCallerPath,
    loaded: true,
    exports: {
      callGemini: stubs.callGemini
    }
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      db: stubs.db || {
        execute: async function() {
          return { rows: [] };
        }
      }
    }
  };

  const semanticSearch = require("./lib/semanticSearch");
  return {
    semanticSearch,
    restore: function() {
      delete require.cache[semanticPath];
      if (originalSemantic) {
        require.cache[semanticPath] = originalSemantic;
      }
      if (originalGeminiCaller) {
        require.cache[geminiCallerPath] = originalGeminiCaller;
      } else {
        delete require.cache[geminiCallerPath];
      }
      if (originalDb) {
        require.cache[dbPath] = originalDb;
      } else {
        delete require.cache[dbPath];
      }
    }
  };
}

function writeUserIndex(root, userId, data) {
  const indexPath = path.join(root, "doc-index", "local", String(userId) + ".json");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf8");
  return indexPath;
}

test("embedding retry limit gives recovery more budget than query lookups", function() {
  withEnv(
    {
      GEMINI_EMBED_KEY_1: "primary-embed",
      GEMINI_EMBED_KEY_2: "fallback-embed",
      GOOGLE_API_KEY: "",
      GOOGLE_API_KEY_FALLBACK: ""
    },
    function() {
      const { semanticSearch, restore } = loadSemanticSearchWithStubs({
        callGemini: async function() {
          return [1, 0];
        }
      });

      try {
        assert.equal(semanticSearch.getEmbeddingRetryLimit("RETRIEVAL_QUERY"), 4);
        assert.equal(
          semanticSearch.getEmbeddingRetryLimit("RETRIEVAL_DOCUMENT", process.env, { mode: "recovery" }),
          8
        );
      } finally {
        restore();
      }
    }
  );
});

test("refreshUserSemanticIndex reuses existing embeddings for the current model", async function() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdocmunch-semantic-"));
  let geminiCalls = 0;

  writeUserIndex(root, "reader", {
    sections: [
      {
        id: "sec-1",
        title: "Capitulo 1",
        content: "Contenido ya vectorizado",
        embedding: [0.6, 0.8]
      }
    ],
    embedding_model: "models/gemini-embedding-001"
  });

  const { semanticSearch, restore } = loadSemanticSearchWithStubs({
    callGemini: async function() {
      geminiCalls += 1;
      return [1, 0];
    }
  });

  try {
    const result = await semanticSearch.refreshUserSemanticIndex("reader", {
      env: {
        DOC_INDEX_PATH: path.join(root, "doc-index"),
        GEMINI_EMBEDDING_MODEL: "models/gemini-embedding-001"
      },
      booksDir: path.join(root, "books")
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(root, "doc-index", "local", "reader.json"), "utf8")
    );

    assert.equal(geminiCalls, 0);
    assert.equal(result.embedded_sections, 0);
    assert.equal(result.reused_sections, 1);
    assert.equal(saved.sections[0].embedding_model, "models/gemini-embedding-001");
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refreshUserSemanticIndex checkpoints partial progress before failing on quota", async function() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdocmunch-semantic-"));
  let geminiCalls = 0;

  writeUserIndex(root, "reader", {
    sections: [
      {
        id: "sec-1",
        title: "Capitulo 1",
        content: "Primer tramo"
      },
      {
        id: "sec-2",
        title: "Capitulo 2",
        content: "Segundo tramo"
      }
    ]
  });

  const { semanticSearch, restore } = loadSemanticSearchWithStubs({
    callGemini: async function() {
      geminiCalls += 1;
      if (geminiCalls === 1) return [0.1, 0.9];
      const err = new Error("quota");
      err.status = 429;
      throw err;
    }
  });

  try {
    await assert.rejects(
      semanticSearch.refreshUserSemanticIndex("reader", {
        env: {
          DOC_INDEX_PATH: path.join(root, "doc-index"),
          GEMINI_EMBEDDING_MODEL: "models/gemini-embedding-001",
          JDOCMUNCH_EMBED_CHECKPOINT_EVERY: "1"
        },
        booksDir: path.join(root, "books")
      }),
      /progreso embeddings: 1 nuevas, 0 reutilizadas, 0 omitidas de 2/
    );

    const saved = JSON.parse(
      fs.readFileSync(path.join(root, "doc-index", "local", "reader.json"), "utf8")
    );

    assert.deepEqual(saved.sections[0].embedding, [0.1, 0.9]);
    assert.equal(saved.sections[0].embedding_model, "models/gemini-embedding-001");
    assert.equal(saved.embedding_progress.target_model, "models/gemini-embedding-001");
    assert.equal(saved.embedding_progress.embedded_sections, 1);
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});