const test = require("node:test");
const assert = require("node:assert/strict");

const { buildContextCoreLite } = require("./lib/contextCoreBuilder");

test("buildContextCoreLite includes enriched concept nodes, relation edges and risks in ctx v2 payloads", () => {
  const contextCore = buildContextCoreLite("book-score", {
    title: "The Score",
    author: "C. Thi Nguyen",
    chapters: [
      { chapter_num: 4, title: "Standardized Values" },
    ],
    centralThesis: "Los scores pueden reducir lo valioso a una señal estrecha.",
    argumentativeArc: ["deformacion de agencia", "captura de valor"],
    keyConcepts: ["scores", "captura de valor"],
    pedagogicalCompendium: "Muchos alumnos confunden critica de scores con rechazo de toda medicion.",
    conceptNodes: [
      {
        id: "concept:score",
        label: "scores",
        pedagogicalRole: "core",
      },
    ],
    relationEdges: [
      {
        id: "edge:score:value-capture",
        type: "supports",
        from: "concept:score",
        to: "concept:value-capture",
        summary: "Los scores facilitan la captura de valor.",
        evidenceHints: [{ chapterNumber: 4, chapterTitle: "Standardized Values" }],
      },
    ],
    pedagogicalRisks: [
      {
        label: "Confundir critica de scores con rechazo de toda medicion.",
        severity: "medium",
      },
    ],
    crossBookSynthesis: [
      {
        theme: "reduccion de lo valioso a una metrica",
        summary: "Puente con Alegre.",
        supportingBookIds: ["book-score", "book-poetas"],
        bridgeType: "complements",
      },
    ],
  });

  assert.equal(contextCore.books[0].conceptNodes[0].label, "scores");
  assert.equal(contextCore.books[0].relationEdges[0].type, "supports");
  assert.equal(contextCore.books[0].pedagogicalRisks[0].severity, "medium");
  assert.equal(contextCore.crossBookSynthesis[0].bridgeType, "complements");
});
