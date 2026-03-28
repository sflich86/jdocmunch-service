const test = require("node:test");
const assert = require("node:assert/strict");

const { buildContextCoreLite } = require("./lib/contextCoreBuilder");

test("buildContextCoreLite includes enriched concept nodes, relation edges and risks in ctx v2 payloads", () => {
  const contextCore = buildContextCoreLite("book-score", {
    title: "The Score",
    author: "C. Thi Nguyen",
    chapters: [{ chapter_num: 4, title: "Standardized Values" }],
    centralThesis: "Los scores pueden reducir lo valioso a una senal estrecha.",
    argumentativeArc: ["deformacion de agencia", "captura de valor"],
    keyConcepts: ["scores", "captura de valor"],
    pedagogicalCompendium:
      "Muchos alumnos confunden critica de scores con rechazo de toda medicion.",
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

test("buildContextCoreLite preserves hierarchical cards and expert-facing study scaffolds", () => {
  const contextCore = buildContextCoreLite("book-score", {
    title: "The Score",
    author: "C. Thi Nguyen",
    chapters: [{ chapter_num: 4, title: "Standardized Values" }],
    centralThesis: "Los scores pueden reducir lo valioso a una senal estrecha.",
    argumentativeArc: ["deformacion de agencia", "captura de valor"],
    keyConcepts: ["scores", "captura de valor"],
    pedagogicalCompendium:
      "Muchos alumnos confunden critica de scores con rechazo de toda medicion.",
    conceptNodes: [
      {
        id: "concept:score",
        label: "scores",
        pedagogicalRole: "core",
      },
      {
        id: "concept:value-capture",
        label: "captura de valor",
        pedagogicalRole: "core",
      },
    ],
    chapterCards: [
      {
        id: "chapter:4",
        chapterNumber: 4,
        chapterTitle: "Standardized Values",
        roleInBook: "Vuelve explicita la reduccion de valor a una senal.",
        localThesis: "El score reorganiza la agencia alrededor de un proxy.",
        keyConceptIds: ["concept:score", "concept:value-capture"],
      },
    ],
    sectionCards: [
      {
        id: "section:4:metrica-y-agencia",
        chapterNumber: 4,
        chapterTitle: "Standardized Values",
        sectionTitle: "Metrica y agencia",
        summary: "Como una grilla externa estrecha el juicio practico.",
        keyConceptIds: ["concept:score"],
      },
    ],
    mentalModels: [
      {
        id: "mental-model:proxy-colonization",
        label: "colonizacion por proxy",
        summary: "Un indicador empieza a reemplazar al bien que deberia servir.",
        usedFor: "Distinguir medir de dejarse gobernar por la metrica.",
        commonMisread: "Pensar que toda cuantificacion es el problema.",
      },
    ],
    fundamentalDisagreements: [
      {
        id: "disagreement:measurement",
        question: "Cuando una metrica orienta y cuando coloniza la practica?",
        sideA: "Las metricas solo ordenan mejor la decision.",
        sideB: "Las metricas reconfiguran lo que el agente aprende a valorar.",
        strongestArgumentA: "Permiten comparar cursos de accion de modo estable.",
        strongestArgumentB: "El proxy pasa a sustituir el bien original.",
      },
    ],
    depthProbes: [
      {
        id: "probe:proxy-vs-good",
        question: "Como distinguis una metrica util de una metrica que ya colonizo la practica?",
        testsConceptIds: ["concept:score", "concept:value-capture"],
        failureSignals: ["Definir score solo como numero", "No distinguir proxy y bien"],
        goodAnswerShape: "Distingue indicador, bien perseguido y cambio de agencia.",
      },
    ],
  });

  assert.equal(contextCore.books[0].chapterCards[0].chapterTitle, "Standardized Values");
  assert.equal(contextCore.books[0].sectionCards[0].sectionTitle, "Metrica y agencia");
  assert.equal(contextCore.books[0].mentalModels[0].label, "colonizacion por proxy");
  assert.match(contextCore.books[0].fundamentalDisagreements[0].question, /metrica/i);
  assert.match(contextCore.books[0].depthProbes[0].question, /distinguis/i);
});
