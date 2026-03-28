const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyCrossBookSynthesisToContextCores,
  buildHeuristicCrossBookSynthesis,
} = require("./lib/crossBookGraphSynthesis");

test("buildHeuristicCrossBookSynthesis returns structured bridges with teaching use and confidence", () => {
  const bridges = buildHeuristicCrossBookSynthesis({
    books: [
      {
        id: "book-poetas",
        title: "El lugar de los poetas",
        contextCore: {
          books: [
            {
              keyConcepts: ["autonomia del arte", "juicio estetico"],
            },
          ],
        },
      },
      {
        id: "book-score",
        title: "The Score",
        contextCore: {
          books: [
            {
              keyConcepts: ["scores", "captura de valor"],
            },
          ],
        },
      },
    ],
    synthesisText:
      "Ambos libros discuten como una grilla externa puede colonizar la experiencia valiosa y empobrecer el juicio.",
  });

  assert.ok(bridges.length > 0);
  assert.ok(bridges[0].theme);
  assert.ok(bridges[0].teachingUse);
  assert.ok(bridges[0].confidenceLabel);
});

test("applyCrossBookSynthesisToContextCores injects relevant bridges back into each participating book context", () => {
  const updated = applyCrossBookSynthesisToContextCores([
    {
      id: "ctx-book-poetas",
      scope: "book",
      bookIds: ["book-poetas"],
      version: "ctx-v2-a",
      generatedAt: "2026-03-27T23:00:00.000Z",
      sourceFingerprint: "poetas:v2",
      books: [{ bookId: "book-poetas", title: "El lugar de los poetas" }],
    },
    {
      id: "ctx-book-score",
      scope: "book",
      bookIds: ["book-score"],
      version: "ctx-v2-b",
      generatedAt: "2026-03-27T23:00:00.000Z",
      sourceFingerprint: "score:v2",
      books: [{ bookId: "book-score", title: "The Score" }],
    },
  ], [
    {
      theme: "reduccion de lo valioso a una metrica",
      summary: "Puente entre Alegre y Nguyen.",
      supportingBookIds: ["book-poetas", "book-score"],
      bridgeType: "complements",
      teachingUse: "Usar la crisis del juicio para iluminar el problema del score.",
      confidenceLabel: "medium",
    },
  ]);

  assert.equal(updated[0].crossBookSynthesis.length, 1);
  assert.equal(updated[1].crossBookSynthesis.length, 1);
});
