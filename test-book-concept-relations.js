const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHeuristicBookConceptStructure } = require("./lib/bookConceptRelations");

test("buildHeuristicBookConceptStructure derives pedagogical risks and relation edges from existing book metadata", () => {
  const structure = buildHeuristicBookConceptStructure({
    bookId: "book-score",
    centralThesis: "Los scores reducen lo valioso a una señal estrecha.",
    keyConcepts: ["scores", "captura de valor", "agencia"],
    pedagogicalCompendium:
      "Muchos alumnos confunden critica de scores con rechazo de toda medicion. Antes de entender captura de valor necesitan entender agencia.",
    chapters: [{ chapter_num: 4, title: "Standardized Values" }],
  });

  assert.ok(structure.conceptNodes.length >= 2);
  assert.ok(structure.relationEdges.some((edge) => edge.type === "supports" || edge.type === "prerequisite_for"));
  assert.ok(structure.pedagogicalRisks.some((risk) => /medicion/i.test(risk.label)));
});
