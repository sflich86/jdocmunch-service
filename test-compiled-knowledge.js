const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBookKnowledgeFromRow,
  buildBookSetKnowledgeFromRows,
} = require("./lib/compiledKnowledge");

test("buildBookKnowledgeFromRow exposes normalized compiled knowledge for a single book", () => {
  const record = buildBookKnowledgeFromRow("user-1", {
    id: "book-score",
    title: "The Score",
    author: "C. Thi Nguyen",
    pedagogical_compendium: "Compendio util para enseñar value capture.",
    central_thesis: "Los scores estrechan la agencia.",
    argumentative_arc: JSON.stringify(["proxy", "value capture"]),
    key_concepts: JSON.stringify(["scores", "captura de valor"]),
    chapters: JSON.stringify([{ chapter_num: 4, title: "Standardized Values" }]),
    context_core_json: JSON.stringify({
      id: "ctx-book-score",
      scope: "book",
      bookIds: ["book-score"],
      version: "ctx-v2-existing",
      generatedAt: "2026-04-05T00:00:00.000Z",
      sourceFingerprint: "book-score:existing",
      books: [
        {
          bookId: "book-score",
          title: "The Score",
          author: "C. Thi Nguyen",
          centralThesis: "Los scores estrechan la agencia.",
          keyConcepts: ["scores", "captura de valor"],
          chapterCards: [{ id: "chapter-4", chapterTitle: "Standardized Values" }],
          sectionCards: [{ id: "section-4", sectionTitle: "Metricas y agencia" }],
        },
      ],
      retrievalHints: {
        factualPrioritySignals: ["Standardized Values"],
        conceptualPrioritySignals: ["scores"],
        knownWeakSpots: [],
      },
    }),
  });

  assert.equal(record.bookId, "book-score");
  assert.equal(record.knowledgeStatus, "complete");
  assert.equal(record.contextCoreLite.books[0].title, "The Score");
  assert.equal(record.contextCoreLite.books[0].chapterCards[0].chapterTitle, "Standardized Values");
});

test("buildBookSetKnowledgeFromRows aggregates cross-book synthesis and retrieval hints", () => {
  const payload = buildBookSetKnowledgeFromRows("user-1", [
    {
      id: "book-score",
      title: "The Score",
      author: "C. Thi Nguyen",
      pedagogical_compendium: "Un libro sobre scores y value capture.",
      central_thesis: "Los scores estrechan la agencia.",
      argumentative_arc: JSON.stringify(["proxy", "value capture"]),
      key_concepts: JSON.stringify(["scores", "captura de valor"]),
      chapters: JSON.stringify([{ chapter_num: 4, title: "Standardized Values" }]),
      context_core_json: JSON.stringify({
        id: "ctx-book-score",
        scope: "book",
        bookIds: ["book-score"],
        version: "ctx-v2-score",
        generatedAt: "2026-04-05T00:00:00.000Z",
        sourceFingerprint: "book-score:existing",
        books: [{ bookId: "book-score", title: "The Score", keyConcepts: ["scores"] }],
        crossBookSynthesis: [
          {
            theme: "colonizacion del juicio por una grilla externa",
            summary: "Nguyen y Alegre comparten una sospecha sobre la sustitucion del valor.",
            supportingBookIds: ["book-score", "book-poetas"],
            bridgeType: "complements",
          },
        ],
        retrievalHints: {
          factualPrioritySignals: ["Standardized Values"],
          conceptualPrioritySignals: ["scores"],
          knownWeakSpots: [],
        },
      }),
    },
    {
      id: "book-poetas",
      title: "El lugar de los poetas",
      author: "Luis Alegre Zahonero",
      pedagogical_compendium: "Un libro sobre juicio estetico y autonomia.",
      central_thesis: "La experiencia estética no debe reducirse a una función externa.",
      argumentative_arc: JSON.stringify(["autonomia", "juicio"]),
      key_concepts: JSON.stringify(["autonomia del arte", "juicio estetico"]),
      chapters: JSON.stringify([{ chapter_num: 1, title: "Poetas" }]),
      context_core_json: JSON.stringify({
        id: "ctx-book-poetas",
        scope: "book",
        bookIds: ["book-poetas"],
        version: "ctx-v2-poetas",
        generatedAt: "2026-04-05T00:00:00.000Z",
        sourceFingerprint: "book-poetas:existing",
        books: [{ bookId: "book-poetas", title: "El lugar de los poetas", keyConcepts: ["autonomia del arte"] }],
        retrievalHints: {
          factualPrioritySignals: ["Poetas"],
          conceptualPrioritySignals: ["autonomia del arte"],
          knownWeakSpots: [],
        },
      }),
    },
  ]);

  assert.equal(payload.knowledgeStatus, "partial");
  assert.equal(payload.books.length, 2);
  assert.equal(payload.contextCoreLite.scope, "book_set");
  assert.ok(payload.crossBookSynthesis.length >= 1);
  assert.match(payload.crossBookSynthesis[0].theme, /juicio|colonizacion/i);
  assert.ok(payload.contextCoreLite.retrievalHints.conceptualPrioritySignals.includes("scores"));
});
