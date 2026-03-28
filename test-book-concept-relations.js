const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHeuristicBookConceptStructure } = require("./lib/bookConceptRelations");

test("buildHeuristicBookConceptStructure derives pedagogical risks and relation edges from existing book metadata", () => {
  const structure = buildHeuristicBookConceptStructure({
    bookId: "book-score",
    centralThesis: "Los scores reducen lo valioso a una senal estrecha.",
    keyConcepts: ["scores", "captura de valor", "agencia"],
    pedagogicalCompendium:
      "Muchos alumnos confunden critica de scores con rechazo de toda medicion. Antes de entender captura de valor necesitan entender agencia.",
    chapters: [{ chapter_num: 4, title: "Standardized Values" }],
  });

  assert.ok(structure.conceptNodes.length >= 2);
  assert.ok(
    structure.relationEdges.some(
      (edge) => edge.type === "supports" || edge.type === "prerequisite_for"
    )
  );
  assert.ok(structure.pedagogicalRisks.some((risk) => /medicion/i.test(risk.label)));
});

test("buildHeuristicBookConceptStructure derives chapter cards, section cards, mental models, disagreements and depth probes", () => {
  const structure = buildHeuristicBookConceptStructure({
    bookId: "book-score",
    title: "The Score",
    author: "C. Thi Nguyen",
    centralThesis: "Los scores reducen lo valioso a una senal estrecha.",
    keyConcepts: ["scores", "captura de valor", "agencia"],
    chapters: [
      { chapter_num: 1, title: "The Goods We Pursue" },
      { chapter_num: 4, title: "Standardized Values" },
    ],
    sectionCandidates: [
      {
        chapter_num: 4,
        chapter_title: "Standardized Values",
        section_title: "Metrica y agencia",
        section_summary: "Como una grilla externa estrecha el juicio practico.",
        breadcrumb: "The Score > Capitulo 4 > Standardized Values > Metrica y agencia",
      },
    ],
    pedagogicalCompendium:
      "Los expertos distinguen entre medir y dejar que una metrica gobierne la practica. Muchos alumnos confunden critica de scores con rechazo de toda medicion. Antes de entender captura de valor necesitan entender agencia.",
  });

  assert.ok(Array.isArray(structure.chapterCards) && structure.chapterCards.length >= 1);
  assert.ok(Array.isArray(structure.sectionCards) && structure.sectionCards.length >= 1);
  assert.ok(Array.isArray(structure.mentalModels) && structure.mentalModels.length >= 1);
  assert.ok(
    Array.isArray(structure.fundamentalDisagreements) &&
      structure.fundamentalDisagreements.length >= 1
  );
  assert.ok(Array.isArray(structure.depthProbes) && structure.depthProbes.length >= 1);
  assert.match(structure.sectionCards[0].sectionTitle, /Metrica y agencia/i);
});
