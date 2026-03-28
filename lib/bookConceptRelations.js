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

  return {
    conceptNodes: conceptNodes,
    relationEdges: relationEdges,
    pedagogicalRisks: pedagogicalRisks,
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
  if (!compendium) {
    return heuristic;
  }

  var chapterMap = normalizeChapterMap(input.chapters);
  var prompt = [
    "Devuelve SOLO JSON valido.",
    "Transforma esta comprension pedagogica en un grafo conceptual operable para un profesor.",
    "Maximo 8 conceptNodes, 12 relationEdges, 6 pedagogicalRisks.",
    "Usa relation types de este conjunto: supports, contrasts_with, prerequisite_for, example_of, misread_as, applies_to.",
    "No inventes citas textuales ni paginas.",
    "",
    "JSON shape exacto:",
    '{"conceptNodes":[{"id":"concept:...","label":"...","summary":"...","aliases":["..."],"pedagogicalRole":"core"}],"relationEdges":[{"id":"edge:...","type":"supports","from":"concept:...","to":"concept:...","summary":"...","teachingUse":"...","confidenceLabel":"high","evidenceHints":[{"chapterNumber":2,"chapterTitle":"..."}]}],"pedagogicalRisks":[{"label":"...","summary":"...","severity":"medium","relatedConceptIds":["concept:..."]}]}',
    "",
    "TITULO: " + cleanText(input.title),
    "AUTOR: " + cleanText(input.author),
    "TESIS: " + cleanText(input.centralThesis),
    "ARGUMENTATIVE ARC: " + JSON.stringify(normalizeStringArray(input.argumentativeArc, 6)),
    "KEY CONCEPTS: " + JSON.stringify(normalizeStringArray(input.keyConcepts, 8)),
    "CHAPTER MAP: " + JSON.stringify(chapterMap.slice(0, 8)),
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
    };
  } catch (error) {
    return heuristic;
  }
}

module.exports = {
  buildHeuristicBookConceptStructure,
  generateBookConceptStructure,
};
