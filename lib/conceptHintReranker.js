const { cleanText, safeJsonParse } = require("./contextCoreBuilder");
const { normalizeSearchText } = require("./textUtils");

function normalizeText(value) {
  return normalizeSearchText(value);
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map(function(token) { return token.trim(); })
    .filter(function(token) { return token.length >= 4; });
}

function parseContextCore(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  return safeJsonParse(value, null);
}

function buildConceptHintPack(query, metadataMap) {
  var queryTokens = new Set(tokenize(query));
  var phrases = [];
  var seen = {};
  var values = metadataMap && typeof metadataMap === "object" ? Object.values(metadataMap) : [];
  for (var i = 0; i < values.length; i++) {
    var metadata = values[i] || {};
    var core = parseContextCore(metadata.contextCore);
    if (!core || !Array.isArray(core.books)) continue;

    core.books.forEach(function(book) {
      []
        .concat(book.keyConcepts || [])
        .concat((book.conceptNodes || []).map(function(node) { return node.label; }))
        .concat((book.relationEdges || []).map(function(edge) { return edge.summary; }))
        .concat((book.pedagogicalRisks || []).map(function(risk) { return risk.label; }))
        .concat((core.crossBookSynthesis || []).map(function(bridge) { return bridge.theme; }))
        .forEach(function(value) {
          var phrase = cleanText(value);
          if (!phrase) return;
          var key = normalizeText(phrase);
          if (!key || seen[key]) return;
          var overlap = tokenize(phrase).filter(function(token) { return queryTokens.has(token); }).length;
          if (overlap === 0 && queryTokens.size > 0) return;
          seen[key] = true;
          phrases.push({ phrase: phrase, overlap: overlap });
        });
    });
  }

  phrases.sort(function(left, right) {
    return right.overlap - left.overlap || right.phrase.length - left.phrase.length;
  });

  return {
    phrases: phrases.slice(0, 8).map(function(entry) { return entry.phrase; }),
  };
}

function rerankChunksWithConceptHints(query, chunks, hintPack) {
  var hintPhrases = Array.isArray(hintPack && hintPack.phrases) ? hintPack.phrases : [];
  if (hintPhrases.length === 0) return Array.isArray(chunks) ? chunks : [];

  return (Array.isArray(chunks) ? chunks : [])
    .map(function(chunk) {
      var haystack = [
        cleanText(chunk.title),
        cleanText(chunk.summary),
        cleanText(chunk.content).slice(0, 1600),
        cleanText(chunk.chapter_title),
        cleanText(chunk.section_title),
      ].join(" \n ");
      var bonus = 0;
      for (var i = 0; i < hintPhrases.length; i++) {
        var phrase = hintPhrases[i];
        if (!phrase) continue;
        if (normalizeText(haystack).indexOf(normalizeText(phrase)) !== -1) {
          bonus += 0.06;
        }
      }
      return Object.assign({}, chunk, {
        score: Number(chunk.score || 0) + bonus,
      });
    })
    .sort(function(left, right) {
      return Number(right.score || 0) - Number(left.score || 0);
    });
}

module.exports = {
  buildConceptHintPack,
  rerankChunksWithConceptHints,
};
