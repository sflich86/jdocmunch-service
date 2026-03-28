const { GoogleGenerativeAI } = require("@google/generative-ai");

const { callGemini } = require("./geminiCaller");
const {
  buildConceptId,
  cleanText,
  normalizeChapterMap,
  normalizeStringArray,
  safeJsonParse,
  slugify,
} = require("./contextCoreBuilder");

function buildArtifactId(prefix, bookId, label) {
  return prefix + ":" + String(bookId || "book") + ":" + slugify(label || prefix);
}

function splitSentences(value) {
  return String(value || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map(function(sentence) { return cleanText(sentence); })
    .filter(Boolean);
}

function buildHeuristicBookConceptStructure(input) {
  var bookId = String(input.bookId || "book");
  var keyConcepts = normalizeStringArray(input.keyConcepts, 8);
  var chapterMap = normalizeChapterMap(input.chapters);
  var sectionCandidates = Array.isArray(input.sectionCandidates) ? input.sectionCandidates : [];
  var conceptNodes = keyConcepts.map(function(label, index) {
    return {
      id: buildConceptId(bookId, label),
      label: label,
      summary: index === 0 && cleanText(input.centralThesis)
        ? cleanText(input.centralThesis).slice(0, 220)
        : undefined,
      aliases: [],
      pedagogicalRole: index < 2 ? "core" : "supporting",
    };
  });
  var relationEdges = [];
  var firstConceptId = conceptNodes[0] && conceptNodes[0].id;
  for (var i = 1; i < conceptNodes.length; i++) {
    relationEdges.push({
      id: "edge:supports:" + slugify(firstConceptId || conceptNodes[i].id) + ":" + slugify(conceptNodes[i].id),
      type: "supports",
      from: firstConceptId || conceptNodes[i - 1].id,
      to: conceptNodes[i].id,
      summary: "Este concepto sostiene o desarrolla la tesis operativa del libro.",
      evidenceHints: chapterMap.slice(0, 1),
      teachingUse: "Conviene introducirlo despues del problema central para que el alumno vea la conexion.",
      confidenceLabel: "medium",
    });
  }

  if (conceptNodes.length >= 2 && /antes de entender|prerequisit|para entender/i.test(String(input.pedagogicalCompendium || ""))) {
    relationEdges.push({
      id: "edge:prerequisite:" + slugify(conceptNodes[0].id) + ":" + slugify(conceptNodes[1].id),
      type: "prerequisite_for",
      from: conceptNodes[0].id,
      to: conceptNodes[1].id,
      summary: "El segundo concepto suele requerir haber asentado el primero.",
      evidenceHints: chapterMap.slice(0, 1),
      teachingUse: "Si el alumno se traba, volver al concepto previo antes de avanzar.",
      confidenceLabel: "medium",
    });
  }

  var pedagogicalRisks = splitSentences(input.pedagogicalCompendium)
    .filter(function(sentence) {
      return /confund|trampa|entiend[a-z]* mal|malinterpre|equivoc|mezcla/i.test(sentence);
    })
    .slice(0, 6)
    .map(function(sentence) {
      return {
        label: sentence,
        severity: "medium",
        relatedConceptIds: firstConceptId ? [firstConceptId] : [],
      };
    });

  if (pedagogicalRisks.length === 0 && cleanText(input.centralThesis)) {
    pedagogicalRisks.push({
      label: "El alumno puede repetir la tesis sin distinguir argumento, ejemplo y consecuencia.",
      severity: "low",
      relatedConceptIds: firstConceptId ? [firstConceptId] : [],
    });
  }

  var sectionCards = sectionCandidates
    .map(function(section, index) {
      var chapterNumber = Number.isFinite(Number(section.chapter_num || section.chapterNumber))
        ? Number(section.chapter_num || section.chapterNumber)
        : undefined;
      var chapterTitle = cleanText(section.chapter_title || section.chapterTitle);
      var sectionTitle = cleanText(section.section_title || section.sectionTitle || section.title);
      if (!sectionTitle && !chapterTitle) return null;
      return {
        id: buildArtifactId("section", bookId, [chapterNumber || index + 1, chapterTitle, sectionTitle].join("-")),
        chapterNumber: chapterNumber,
        chapterTitle: chapterTitle || undefined,
        sectionTitle: sectionTitle || chapterTitle || ("Seccion " + String(index + 1)),
        summary: cleanText(section.section_summary || section.summary) || undefined,
        keyConceptIds: conceptNodes.slice(0, 2).map(function(node) { return node.id; }),
        evidenceHints: chapterNumber || chapterTitle
          ? [{ chapterNumber: chapterNumber, chapterTitle: chapterTitle || undefined }]
          : [],
        breadcrumb: cleanText(section.breadcrumb) || undefined,
      };
    })
    .filter(Boolean)
    .slice(0, 12);

  if (sectionCards.length === 0) {
    sectionCards.push.apply(
      sectionCards,
      chapterMap.slice(0, 6).map(function(chapter, index) {
        return {
          id: buildArtifactId("section", bookId, [chapter.chapterNumber || index + 1, chapter.chapterTitle || "seccion"].join("-")),
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.chapterTitle || undefined,
          sectionTitle: chapter.chapterTitle || ("Seccion " + String(index + 1)),
          keyConceptIds: conceptNodes.slice(index, index + 2).map(function(node) { return node.id; }),
          evidenceHints: [chapter],
        };
      })
    );
  }

  var mentalModels = [];
  if (keyConcepts.length > 0 || cleanText(input.centralThesis)) {
    mentalModels.push({
      id: buildArtifactId("mental-model", bookId, keyConcepts[0] || "tesis"),
      label: cleanText(keyConcepts[0] || "marco central del libro"),
      summary: cleanText(input.centralThesis) || "Modelo mental operativo del libro.",
      usedFor: "Ordenar la lectura sin perder la funcion de cada pieza del argumento.",
      commonMisread: pedagogicalRisks[0] ? pedagogicalRisks[0].label : undefined,
      relatedConceptIds: conceptNodes.slice(0, 2).map(function(node) { return node.id; }),
      evidenceHints: chapterMap.slice(0, 2),
    });
  }

  var fundamentalDisagreements = [];
  if (keyConcepts.length > 0 || cleanText(input.centralThesis)) {
    fundamentalDisagreements.push({
      id: buildArtifactId("disagreement", bookId, keyConcepts[0] || "tesis"),
      question: "Donde se vuelve empobrecedora una lectura demasiado estrecha de " + (keyConcepts[0] || "la tesis") + "?",
      sideA: "Una simplificacion mas operativa ayuda a intervenir mejor.",
      sideB: "Una simplificacion excesiva sustituye el fenomeno por un proxy.",
      strongestArgumentA: "Sin cierto recorte, el alumno no logra usar la idea.",
      strongestArgumentB: "Si el proxy domina, la practica pierde lo que queria entender.",
      resolutionStyle: "Mostrar el punto de rendimiento y el punto de deformacion.",
      epistemicStatus: "pedagogical",
      relatedConceptIds: conceptNodes.slice(0, 2).map(function(node) { return node.id; }),
      evidenceHints: chapterMap.slice(0, 2),
    });
  }

  var depthProbes = [];
  if (conceptNodes.length > 0) {
    depthProbes.push({
      id: buildArtifactId("depth-probe", bookId, conceptNodes[0].label),
      question: "Como mostrarias que entendes " + conceptNodes[0].label + " sin repetir la definicion del libro?",
      testsConceptIds: conceptNodes.slice(0, 2).map(function(node) { return node.id; }),
      failureSignals: [
        "Repite terminos sin distinguir funcion y consecuencia",
        "No conecta el concepto con una situacion concreta",
      ],
      goodAnswerShape: "Distingue definicion, contraste y efecto practico.",
      followUpIfWeak: "Pedir una escena donde el concepto ilumina y otra donde confunde.",
      difficulty: "medium",
      evidenceHints: chapterMap.slice(0, 2),
    });
  }

  var chapterCards = chapterMap.slice(0, 12).map(function(chapter, index) {
    return {
      id: buildArtifactId("chapter", bookId, [chapter.chapterNumber || index + 1, chapter.chapterTitle || "capitulo"].join("-")),
      chapterNumber: chapter.chapterNumber,
      chapterTitle: chapter.chapterTitle || undefined,
      roleInBook: index === 0
        ? "Abre el problema y fija el marco de lectura."
        : index === chapterMap.length - 1
          ? "Reordena la apuesta del libro y deja visible su consecuencia."
          : "Desarrolla una pieza necesaria del argumento.",
      localThesis: undefined,
      keyConceptIds: conceptNodes.slice(index, index + 2).map(function(node) { return node.id; }),
      sectionIds: sectionCards
        .filter(function(section) { return section.chapterNumber === chapter.chapterNumber; })
        .slice(0, 4)
        .map(function(section) { return section.id; }),
      mentalModelIds: mentalModels.slice(0, 1).map(function(model) { return model.id; }),
      disagreementIds: fundamentalDisagreements.slice(0, 1).map(function(item) { return item.id; }),
      depthProbeIds: depthProbes.slice(0, 1).map(function(item) { return item.id; }),
      evidenceHints: [chapter],
      teachingUse: "Ubicar este capitulo dentro del arco completo antes de bajar al detalle.",
    };
  });

  return {
    conceptNodes: conceptNodes,
    relationEdges: relationEdges,
    pedagogicalRisks: pedagogicalRisks,
    chapterCards: chapterCards,
    sectionCards: sectionCards,
    mentalModels: mentalModels,
    fundamentalDisagreements: fundamentalDisagreements,
    depthProbes: depthProbes,
  };
}

function extractJsonCandidate(text, fallback) {
  var cleaned = String(text || "").replace(/```json|```/gi, "").trim();
  var objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objectMatch) return fallback;
  return safeJsonParse(objectMatch[0], fallback);
}

async function generateBookConceptStructure(input) {
  var heuristic = buildHeuristicBookConceptStructure(input);
  var compendium = cleanText(input.pedagogicalCompendium);
  var sectionCandidates = Array.isArray(input.sectionCandidates) ? input.sectionCandidates : [];
  if (!compendium) {
    return heuristic;
  }

  var chapterMap = normalizeChapterMap(input.chapters);
  var prompt = [
    "Devuelve SOLO JSON valido.",
    "Transforma esta comprension pedagogica en un grafo conceptual operable para un profesor.",
    "Maximo 8 conceptNodes, 12 relationEdges, 6 pedagogicalRisks, 10 chapterCards, 16 sectionCards, 6 mentalModels, 4 fundamentalDisagreements, 6 depthProbes.",
    "Usa relation types de este conjunto: supports, contrasts_with, prerequisite_for, example_of, misread_as, applies_to.",
    "No inventes citas textuales ni paginas.",
    "",
    "JSON shape exacto:",
    '{"conceptNodes":[{"id":"concept:...","label":"...","summary":"...","aliases":["..."],"pedagogicalRole":"core"}],"relationEdges":[{"id":"edge:...","type":"supports","from":"concept:...","to":"concept:...","summary":"...","teachingUse":"...","confidenceLabel":"high","evidenceHints":[{"chapterNumber":2,"chapterTitle":"..."}]}],"pedagogicalRisks":[{"label":"...","summary":"...","severity":"medium","relatedConceptIds":["concept:..."]}],"chapterCards":[{"id":"chapter:...","chapterNumber":2,"chapterTitle":"...","roleInBook":"...","localThesis":"...","keyConceptIds":["concept:..."],"sectionIds":["section:..."],"mentalModelIds":["mental-model:..."],"disagreementIds":["disagreement:..."],"depthProbeIds":["depth-probe:..."],"teachingUse":"...","evidenceHints":[{"chapterNumber":2,"chapterTitle":"..."}]}],"sectionCards":[{"id":"section:...","chapterNumber":2,"chapterTitle":"...","sectionTitle":"...","summary":"...","purpose":"...","keyConceptIds":["concept:..."],"mentalModelIds":["mental-model:..."],"teachingUse":"...","breadcrumb":"...","evidenceHints":[{"chapterNumber":2,"chapterTitle":"..."}]}],"mentalModels":[{"id":"mental-model:...","label":"...","summary":"...","usedFor":"...","commonMisread":"...","relatedConceptIds":["concept:..."],"evidenceHints":[{"chapterNumber":2,"chapterTitle":"..."}]}],"fundamentalDisagreements":[{"id":"disagreement:...","question":"...","sideA":"...","sideB":"...","strongestArgumentA":"...","strongestArgumentB":"...","resolutionStyle":"...","epistemicStatus":"pedagogical","relatedConceptIds":["concept:..."],"evidenceHints":[{"chapterNumber":2,"chapterTitle":"..."}]}],"depthProbes":[{"id":"depth-probe:...","question":"...","testsConceptIds":["concept:..."],"failureSignals":["..."],"goodAnswerShape":"...","followUpIfWeak":"...","difficulty":"medium","evidenceHints":[{"chapterNumber":2,"chapterTitle":"..."}]}]}',
    "",
    "TITULO: " + cleanText(input.title),
    "AUTOR: " + cleanText(input.author),
    "TESIS: " + cleanText(input.centralThesis),
    "ARGUMENTATIVE ARC: " + JSON.stringify(normalizeStringArray(input.argumentativeArc, 6)),
    "KEY CONCEPTS: " + JSON.stringify(normalizeStringArray(input.keyConcepts, 8)),
    "CHAPTER MAP: " + JSON.stringify(chapterMap.slice(0, 8)),
    "SECTION CANDIDATES: " + JSON.stringify(sectionCandidates.slice(0, 12)),
    "COMPENDIO: " + compendium.slice(0, 12000),
  ].join("\n");

  try {
    var raw = await callGemini(async function(apiKey) {
      var genAI = new GoogleGenerativeAI(apiKey);
      var model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
      var result = await model.generateContent(prompt);
      return result.response.text();
    }, { tier: "batch", description: "bookConceptStructure:" + input.bookId });

    var parsed = extractJsonCandidate(raw, null);
    if (!parsed || typeof parsed !== "object") {
      return heuristic;
    }

    return {
      conceptNodes: Array.isArray(parsed.conceptNodes) && parsed.conceptNodes.length
        ? parsed.conceptNodes
        : heuristic.conceptNodes,
      relationEdges: Array.isArray(parsed.relationEdges) && parsed.relationEdges.length
        ? parsed.relationEdges
        : heuristic.relationEdges,
      pedagogicalRisks: Array.isArray(parsed.pedagogicalRisks) && parsed.pedagogicalRisks.length
        ? parsed.pedagogicalRisks
        : heuristic.pedagogicalRisks,
      chapterCards: Array.isArray(parsed.chapterCards) && parsed.chapterCards.length
        ? parsed.chapterCards
        : heuristic.chapterCards,
      sectionCards: Array.isArray(parsed.sectionCards) && parsed.sectionCards.length
        ? parsed.sectionCards
        : heuristic.sectionCards,
      mentalModels: Array.isArray(parsed.mentalModels) && parsed.mentalModels.length
        ? parsed.mentalModels
        : heuristic.mentalModels,
      fundamentalDisagreements: Array.isArray(parsed.fundamentalDisagreements) && parsed.fundamentalDisagreements.length
        ? parsed.fundamentalDisagreements
        : heuristic.fundamentalDisagreements,
      depthProbes: Array.isArray(parsed.depthProbes) && parsed.depthProbes.length
        ? parsed.depthProbes
        : heuristic.depthProbes,
    };
  } catch (error) {
    return heuristic;
  }
}

module.exports = {
  buildHeuristicBookConceptStructure,
  generateBookConceptStructure,
};
