
const { callGemini } = require("./geminiCaller");
const { cleanText, normalizeCrossBookSynthesis, normalizeStringArray, safeJsonParse } = require("./contextCoreBuilder");

function firstBookConcepts(book) {
  var core = book.contextCore || {};
  var first = Array.isArray(core.books) && core.books.length ? core.books[0] : {};
  return normalizeStringArray(first.keyConcepts || [], 6);
}

function buildHeuristicCrossBookSynthesis(input) {
  var books = Array.isArray(input.books) ? input.books : [];
  if (books.length < 2) return [];
  var supportingBookIds = books.map(function(book) { return String(book.id); });
  var concepts = books
    .map(function(book) { return firstBookConcepts(book); })
    .reduce(function(acc, next) { return acc.concat(next); }, [])
    .slice(0, 6);
  var summary = cleanText(input.synthesisText) || "Los libros comparten una tension conceptual util para la comparacion pedagogica.";
  var theme = cleanText(summary.split(/[.!?]/)[0]) || concepts.join(" / ") || "puente conceptual";
  return normalizeCrossBookSynthesis([
    {
      theme: theme,
      summary: summary,
      supportingBookIds: supportingBookIds,
      bridgeType: books.length === 2 ? "complements" : "cluster",
      teachingUse:
        books.length === 2
          ? "Usar " + cleanText(books[0].title) + " para iluminar " + cleanText(books[1].title) + " sin convertir la conexion en equivalencia total."
          : "Presentar primero la tension compartida y despues mostrar donde cada libro la resuelve distinto.",
      riskNote: "Mantener esta sintesis como hipotesis pedagogica y no como apoyo textual literal.",
      confidenceLabel: cleanText(input.synthesisText) ? "medium" : "low",
    },
  ]);
}

function extractJsonArray(text) {
  var cleaned = String(text || "").replace(/```json|```/gi, "").trim();
  var match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return null;
  return safeJsonParse(match[0], null);
}

async function generateCrossBookGraphSynthesis(input) {
  var heuristic = buildHeuristicCrossBookSynthesis(input);
  if (!cleanText(input.synthesisText)) {
    return heuristic;
  }

  try {
    var prompt = [
      "Devuelve SOLO JSON valido.",
      "Convierte esta sintesis pedagógica entre libros en bridges estructurados.",
      "Maximo 6 objetos.",
      "Campos exactos: theme, summary, supportingBookIds, bridgeType, teachingUse, riskNote, confidenceLabel.",
      "bridgeType puede ser: complements, contrasts, tension, analogy, prerequisite.",
      "No inventes paginas ni citas.",
      "",
      "BOOKS: " + JSON.stringify((input.books || []).map(function(book) {
        return {
          id: book.id,
          title: book.title,
          concepts: firstBookConcepts(book),
        };
      })),
      "",
      "SYNTHESIS TEXT:",
      cleanText(input.synthesisText).slice(0, 12000),
    ].join("\n");

    var raw = await callGemini(async function(apiKey) {
      const mod = await import("@google/generative-ai");
      const GoogleGenerativeAI = mod.GoogleGenerativeAI;
      var genAI = new GoogleGenerativeAI(apiKey);
      var model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
      var result = await model.generateContent(prompt);
      return result.response.text();
    }, { tier: "batch", description: "crossBookGraphSynthesis" });

    var parsed = extractJsonArray(raw);
    return parsed && Array.isArray(parsed) && parsed.length
      ? normalizeCrossBookSynthesis(parsed)
      : heuristic;
  } catch (error) {
    return heuristic;
  }
}

function applyCrossBookSynthesisToContextCores(contextCores, bridges) {
  var sourceCores = Array.isArray(contextCores) ? contextCores : [];
  var normalizedBridges = normalizeCrossBookSynthesis(bridges);
  return sourceCores.map(function(core) {
    var next = Object.assign({}, core);
    var bookIds = Array.isArray(core.bookIds) ? core.bookIds : [];
    next.crossBookSynthesis = normalizedBridges.filter(function(bridge) {
      return bridge.supportingBookIds.some(function(bookId) {
        return bookIds.indexOf(bookId) !== -1;
      });
    });
    return next;
  });
}

module.exports = {
  applyCrossBookSynthesisToContextCores,
  buildHeuristicCrossBookSynthesis,
  generateCrossBookGraphSynthesis,
};
