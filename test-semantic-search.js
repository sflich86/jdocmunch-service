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
  const axiosPath = require.resolve("axios");
  const originalSemantic = require.cache[semanticPath];
  const originalGeminiCaller = require.cache[geminiCallerPath];
  const originalDb = require.cache[dbPath];
  const originalAxios = require.cache[axiosPath];

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
  require.cache[axiosPath] = {
    id: axiosPath,
    filename: axiosPath,
    loaded: true,
    exports: stubs.axios || {
      post: async function() {
        throw new Error("axios.post stub not provided");
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
      if (originalAxios) {
        require.cache[axiosPath] = originalAxios;
      } else {
        delete require.cache[axiosPath];
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
          JDOCMUNCH_EMBED_CHECKPOINT_EVERY: "1",
          JDOCMUNCH_EMBED_DOCUMENT_BATCH_SIZE: "1"
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

test("refreshUserSemanticIndex scopes document embeddings to requested doc paths and batches requests", async function() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdocmunch-semantic-"));
  let geminiCalls = 0;

  writeUserIndex(root, "reader", {
    sections: [
      {
        id: "sec-target-1",
        doc_path: "target-a.md",
        title: "Capitulo 1",
        content: "Primer tramo"
      },
      {
        id: "sec-target-2",
        doc_path: "target-b.md",
        title: "Capitulo 2",
        content: "Segundo tramo"
      },
      {
        id: "sec-other",
        doc_path: "other-book.md",
        title: "Capitulo ajeno",
        content: "No deberia embeberse"
      }
    ]
  });

  const { semanticSearch, restore } = loadSemanticSearchWithStubs({
    callGemini: async function() {
      geminiCalls += 1;
      return [
        [0.1, 0.9],
        [0.2, 0.8]
      ];
    }
  });

  try {
    const result = await semanticSearch.refreshUserSemanticIndex("reader", {
      env: {
        DOC_INDEX_PATH: path.join(root, "doc-index"),
        GEMINI_EMBEDDING_MODEL: "models/gemini-embedding-001",
        JDOCMUNCH_EMBED_DOCUMENT_BATCH_SIZE: "8"
      },
      booksDir: path.join(root, "books"),
      docPaths: ["target-a.md", "target-b.md"]
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(root, "doc-index", "local", "reader.json"), "utf8")
    );

    assert.equal(geminiCalls, 1);
    assert.equal(result.sections, 2);
    assert.equal(result.embedded_sections, 2);
    assert.deepEqual(saved.sections[0].embedding, [0.1, 0.9]);
    assert.deepEqual(saved.sections[1].embedding, [0.2, 0.8]);
    assert.equal(saved.sections[2].embedding, undefined);
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildSectionEmbedText trims long content to the configured char budget", function() {
  const { semanticSearch, restore } = loadSemanticSearchWithStubs({
    callGemini: async function() {
      return [1, 0];
    }
  });

  try {
    const text = semanticSearch.buildSectionEmbedText(
      {
        title: "Capitulo 1",
        summary: "Resumen breve",
        content: "x".repeat(5000)
      },
      "reader",
      "",
      {
        JDOCMUNCH_EMBED_TEXT_CHAR_LIMIT: "1200"
      }
    );

    assert.ok(text.startsWith("Capitulo 1\nResumen breve\n"));
    assert.equal(text.split("\n").pop().length, 1200);
  } finally {
    restore();
  }
});

test("refreshUserSemanticIndex uses OpenAI embeddings when provider is openai", async function() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdocmunch-semantic-"));
  let geminiCalls = 0;
  let axiosCalls = 0;

  writeUserIndex(root, "reader", {
    sections: [
      {
        id: "sec-1",
        doc_path: "target-a.md",
        title: "Capitulo 1",
        content: "Primer tramo"
      },
      {
        id: "sec-2",
        doc_path: "target-a.md",
        title: "Capitulo 2",
        content: "Segundo tramo"
      }
    ]
  });

  const { semanticSearch, restore } = loadSemanticSearchWithStubs({
    callGemini: async function() {
      geminiCalls += 1;
      return [1, 0];
    },
    axios: {
      post: async function(url, payload, options) {
        axiosCalls += 1;
        assert.equal(url, "https://api.openai.com/v1/embeddings");
        assert.equal(payload.model, "text-embedding-3-small");
        assert.deepEqual(payload.input, ["Capitulo 1\nPrimer tramo", "Capitulo 2\nSegundo tramo"]);
        assert.match(options.headers.Authorization, /^Bearer /);
        return {
          data: {
            data: [
              { embedding: [0.1, 0.9] },
              { embedding: [0.2, 0.8] }
            ]
          }
        };
      }
    }
  });

  try {
    const result = await semanticSearch.refreshUserSemanticIndex("reader", {
      env: {
        DOC_INDEX_PATH: path.join(root, "doc-index"),
        JDOCMUNCH_EMBEDDING_PROVIDER: "openai",
        OPENAI_API_KEY: "test-openai-key",
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
        JDOCMUNCH_EMBED_TEXT_CHAR_LIMIT: "1200"
      },
      booksDir: path.join(root, "books"),
      docPaths: ["target-a.md"]
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(root, "doc-index", "local", "reader.json"), "utf8")
    );

    assert.equal(geminiCalls, 0);
    assert.equal(axiosCalls, 1);
    assert.equal(result.embedding_model, "text-embedding-3-small");
    assert.ok(Math.abs(saved.sections[0].embedding[0] - 0.11043152607484655) < 1e-12);
    assert.ok(Math.abs(saved.sections[0].embedding[1] - 0.9938837346736189) < 1e-12);
    assert.ok(Math.abs(saved.sections[1].embedding[0] - 0.24253562503633294) < 1e-12);
    assert.ok(Math.abs(saved.sections[1].embedding[1] - 0.9701425001453318) < 1e-12);
    assert.equal(saved.embedding_model, "text-embedding-3-small");
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("searchUserIndex returns semantically relevant chunks without lexical-author boosting", async function() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdocmunch-semantic-"));
  const booksRoot = path.join(root, "books", "reader");
  fs.mkdirSync(booksRoot, { recursive: true });

  const suitsPath = path.join(booksRoot, "score.md");
  const scottPath = path.join(booksRoot, "state.md");
  fs.writeFileSync(
    suitsPath,
    "Bernard Suits explains that games voluntarily take on unnecessary obstacles to make possible the activity of struggling to overcome them.",
    "utf8"
  );
  fs.writeFileSync(
    scottPath,
    "James Scott describes state legibility as the drive to simplify the world for centralized control through standardized categories.",
    "utf8"
  );

  writeUserIndex(root, "reader", {
    sections: [
      {
        id: "sec-suits",
        doc_path: "score.md",
        title: "The Art of Agency",
        summary: "Bernard Suits on games",
        chapter_title: "The Art of Agency",
        section_title: "Games",
        book_title: "The Score",
        author: "C. Thi Nguyen",
        embedding: [1, 0],
        byte_start: 0,
        byte_end: fs.readFileSync(suitsPath, "utf8").length
      },
      {
        id: "sec-scott",
        doc_path: "state.md",
        title: "Centralizing Values",
        summary: "James Scott on legibility",
        chapter_title: "Centralizing Values",
        section_title: "State legibility",
        book_title: "The Score",
        author: "C. Thi Nguyen",
        embedding: [0.98, 0.02],
        byte_start: 0,
        byte_end: fs.readFileSync(scottPath, "utf8").length
      }
    ]
  });

  const { semanticSearch, restore } = loadSemanticSearchWithStubs({
    callGemini: async function() {
      return [1, 0];
    }
  });

  try {
    const results = await semanticSearch.searchUserIndex(
      "James Scott legibility versus Bernard Suits game motivation",
      "reader",
      {
        env: {
          DOC_INDEX_PATH: path.join(root, "doc-index")
        },
        booksDir: path.join(root, "books"),
        maxResults: 2
      }
    );

    assert.equal(results.length, 2);
    const scottResult = results.find(function(entry) {
      return entry.id === "sec-scott";
    });
    assert.ok(scottResult);
    assert.match(scottResult.content, /James Scott/i);
    assert.ok(Number(scottResult.score || 0) > 0);
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
