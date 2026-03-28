var crypto = require("crypto");

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function normalizeStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  var seen = {};
  var items = [];
  var max = typeof limit === "number" ? limit : 8;
  for (var i = 0; i < value.length; i++) {
    var next = String(value[i] || "").trim();
    if (!next) continue;
    var key = next.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    items.push(next);
    if (items.length >= max) break;
  }
  return items;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildConceptId(bookId, label) {
  return "concept:" + String(bookId || "book") + ":" + slugify(label);
}

function labelFromConceptReference(value) {
  var raw = cleanText(value);
  if (!raw) return "";
  var tail = raw.split(":").pop() || raw;
  return tail
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDetectedChapters(chapters) {
  var input = Array.isArray(chapters) ? chapters : [];
  var seenNumbered = {};
  var normalized = [];

  for (var i = 0; i < input.length; i++) {
    var entry = input[i] || {};
    var chapterNumber = Number.isFinite(Number(entry.chapter_num || entry.chapterNumber))
      ? Number(entry.chapter_num || entry.chapterNumber)
      : undefined;
    var title = cleanText(entry.title || entry.chapterTitle);
    var startsWith = cleanText(entry.starts_with);
    if (!title && !startsWith && !Number.isFinite(Number(chapterNumber))) continue;
    if (Number.isFinite(Number(chapterNumber))) {
      if (seenNumbered[chapterNumber]) continue;
      seenNumbered[chapterNumber] = true;
    }
    normalized.push({
      chapter_num: chapterNumber,
      title: title || undefined,
      starts_with: startsWith || undefined,
    });
  }

  return normalized;
}

function normalizeChapterMap(chapters) {
  return normalizeDetectedChapters(chapters)
    .map(function(entry) {
      var chapterNumber = Number.isFinite(Number(entry.chapter_num))
        ? Number(entry.chapter_num)
        : undefined;
      var chapterTitle = cleanText(entry.title || entry.starts_with);
      if (!chapterTitle && !Number.isFinite(Number(chapterNumber))) {
        return null;
      }
      return {
        chapterNumber: chapterNumber,
        chapterTitle: chapterTitle || undefined,
      };
    })
    .filter(Boolean);
}

function normalizeConceptNodes(value, bookId) {
  var source = Array.isArray(value) ? value : [];
  var seen = {};
  var nodes = [];
  for (var i = 0; i < source.length; i++) {
    var entry = source[i] || {};
    var label = cleanText(entry.label || entry.name || entry.title);
    if (!label) continue;
    var id = cleanText(entry.id) || buildConceptId(bookId, label);
    if (seen[id]) continue;
    seen[id] = true;
    nodes.push({
      id: id,
      label: label,
      summary: cleanText(entry.summary || entry.description) || undefined,
      aliases: normalizeStringArray(entry.aliases, 6),
      pedagogicalRole: cleanText(entry.pedagogicalRole || entry.role) || undefined,
    });
  }
  return nodes.slice(0, 12);
}

function normalizeEvidenceHints(value) {
  return normalizeChapterMap(value).slice(0, 4);
}

function normalizeRelationEdges(value, conceptNodes, chapterMap) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var seen = {};
  var edges = [];
  for (var i = 0; i < conceptNodes.length; i++) {
    knownConceptIds[conceptNodes[i].id] = true;
  }
  for (var j = 0; j < source.length; j++) {
    var entry = source[j] || {};
    var from = cleanText(entry.from || entry.fromId);
    var to = cleanText(entry.to || entry.toId);
    var type = cleanText(entry.type || entry.kind).toLowerCase();
    if (!from || !to || !type || !knownConceptIds[from] || !knownConceptIds[to]) continue;
    var id = cleanText(entry.id) || ("edge:" + type + ":" + slugify(from) + ":" + slugify(to));
    if (seen[id]) continue;
    seen[id] = true;
    edges.push({
      id: id,
      type: type,
      from: from,
      to: to,
      summary: cleanText(entry.summary || entry.description) || undefined,
      evidenceHints: normalizeEvidenceHints(entry.evidenceHints).length > 0
        ? normalizeEvidenceHints(entry.evidenceHints)
        : chapterMap.slice(0, 1),
      teachingUse: cleanText(entry.teachingUse) || undefined,
      confidenceLabel: cleanText(entry.confidenceLabel || entry.confidence) || undefined,
    });
  }
  return edges.slice(0, 18);
}

function normalizePedagogicalRisks(value) {
  var source = Array.isArray(value) ? value : [];
  var seen = {};
  var risks = [];
  for (var i = 0; i < source.length; i++) {
    var entry = source[i];
    var sourceEntry = entry && typeof entry === "object" ? entry : {};
    var label = cleanText(sourceEntry.label || sourceEntry.risk || entry);
    if (!label) continue;
    var key = label.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    var severity = cleanText(sourceEntry.severity).toLowerCase();
    risks.push({
      label: label,
      summary: cleanText(sourceEntry.summary || sourceEntry.description) || undefined,
      severity: severity === "high" || severity === "low" ? severity : "medium",
      relatedConceptIds: normalizeStringArray(sourceEntry.relatedConceptIds, 6),
    });
  }
  return risks.slice(0, 8);
}

function normalizeCrossBookSynthesis(value) {
  var source = Array.isArray(value) ? value : [];
  var bridges = [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    var entry = source[i] || {};
    var theme = cleanText(entry.theme);
    var summary = cleanText(entry.summary);
    var supportingBookIds = normalizeStringArray(entry.supportingBookIds, 8);
    if (!theme || !summary || supportingBookIds.length === 0) continue;
    var key = theme.toLowerCase() + "::" + supportingBookIds.join(",");
    if (seen[key]) continue;
    seen[key] = true;
    bridges.push({
      theme: theme,
      summary: summary,
      supportingBookIds: supportingBookIds,
      bridgeType: cleanText(entry.bridgeType || entry.type) || undefined,
      teachingUse: cleanText(entry.teachingUse) || undefined,
      riskNote: cleanText(entry.riskNote) || undefined,
      confidenceLabel: cleanText(entry.confidenceLabel || entry.confidence) || undefined,
    });
  }
  return bridges.slice(0, 10);
}

function extractHeadingCandidates(content) {
  var text = String(content || "");
  if (!text.trim()) return [];

  var matchesByChapter = {};
  var patterns = [
    /(?:^|\n)\s*(?:chapter|capitulo)\s+(\d{1,3})(?:\s*[:.\-]\s*|\s+)([^\n]{2,180})/gi,
    /(?:^|\n)\s*(\d{1,3})\.\s+([^\n]{2,180})/g,
  ];

  for (var p = 0; p < patterns.length; p++) {
    var pattern = patterns[p];
    var match;
    while ((match = pattern.exec(text)) !== null) {
      var chapterNum = Number(match[1]);
      var title = cleanText(match[2]);
      if (!Number.isFinite(chapterNum) || !title) continue;
      if (!matchesByChapter[chapterNum]) {
        matchesByChapter[chapterNum] = {
          chapter_num: chapterNum,
          title: title,
          starts_with: title,
        };
      }
    }
  }

  return Object.values(matchesByChapter).sort(function(left, right) {
    return Number(left.chapter_num || 0) - Number(right.chapter_num || 0);
  });
}

function mergeChaptersWithCandidates(detectedChapters, headingCandidates) {
  var merged = normalizeDetectedChapters(detectedChapters);
  var byNumber = {};

  for (var i = 0; i < merged.length; i++) {
    var chapter = merged[i];
    if (Number.isFinite(Number(chapter.chapter_num))) {
      byNumber[chapter.chapter_num] = chapter;
    }
  }

  for (var j = 0; j < headingCandidates.length; j++) {
    var candidate = headingCandidates[j];
    var chapterNum = Number(candidate.chapter_num);
    if (!Number.isFinite(chapterNum)) continue;
    if (!byNumber[chapterNum]) {
      var appended = {
        chapter_num: chapterNum,
        title: cleanText(candidate.title) || undefined,
        starts_with: cleanText(candidate.starts_with) || undefined,
      };
      merged.push(appended);
      byNumber[chapterNum] = appended;
      continue;
    }

    if (!cleanText(byNumber[chapterNum].title) && cleanText(candidate.title)) {
      byNumber[chapterNum].title = cleanText(candidate.title);
    }
    if (!cleanText(byNumber[chapterNum].starts_with) && cleanText(candidate.starts_with)) {
      byNumber[chapterNum].starts_with = cleanText(candidate.starts_with);
    }
  }

  return merged.sort(function(left, right) {
    var leftNumber = Number.isFinite(Number(left.chapter_num)) ? Number(left.chapter_num) : Number.MAX_SAFE_INTEGER;
    var rightNumber = Number.isFinite(Number(right.chapter_num)) ? Number(right.chapter_num) : Number.MAX_SAFE_INTEGER;
    return leftNumber - rightNumber;
  });
}

function buildStructureHealth(mergedChapters, sourceChapters, headingCandidates) {
  var normalizedMerged = normalizeDetectedChapters(mergedChapters);
  var normalizedSource = normalizeDetectedChapters(sourceChapters);
  var numberedMerged = normalizedMerged.filter(function(entry) {
    return Number.isFinite(Number(entry.chapter_num));
  });
  var numberedSource = normalizedSource.filter(function(entry) {
    return Number.isFinite(Number(entry.chapter_num));
  });
  var numberedCandidates = normalizeDetectedChapters(headingCandidates).filter(function(entry) {
    return Number.isFinite(Number(entry.chapter_num));
  });

  var mergedNumbers = numberedMerged.map(function(entry) { return Number(entry.chapter_num); });
  var candidateNumbers = numberedCandidates.map(function(entry) { return Number(entry.chapter_num); });
  var maxMergedChapter = mergedNumbers.length > 0 ? Math.max.apply(null, mergedNumbers) : null;
  var maxCandidateChapter = candidateNumbers.length > 0 ? Math.max.apply(null, candidateNumbers) : null;
  var gapCount = 0;

  if (maxMergedChapter && mergedNumbers.length > 0) {
    var present = {};
    for (var i = 0; i < mergedNumbers.length; i++) {
      present[mergedNumbers[i]] = true;
    }
    for (var chapter = 1; chapter <= maxMergedChapter; chapter++) {
      if (!present[chapter]) gapCount += 1;
    }
  }

  var sourceDetectionIncomplete =
    numberedSource.length > 0 &&
    numberedCandidates.length > 0 &&
    (numberedCandidates.length > numberedSource.length ||
      (maxCandidateChapter || 0) > (numberedSource.length > 0 ? Math.max.apply(null, numberedSource.map(function(entry) {
        return Number(entry.chapter_num);
      })) : 0));

  return {
    version: "canonical-structure-v1",
    sourceOutlineEntryCount: normalizedSource.length,
    mergedEntryCount: normalizedMerged.length,
    numberedEntryCount: numberedMerged.length,
    headingCandidateCount: numberedCandidates.length,
    headingCandidateMaxChapter: maxCandidateChapter,
    maxChapterNumber: maxMergedChapter,
    gapCount: gapCount,
    sourceDetectionIncomplete: sourceDetectionIncomplete,
    possiblyIncomplete: sourceDetectionIncomplete,
    isReliableForExactLookup: numberedMerged.length > 0 && gapCount <= 2,
  };
}

function buildCanonicalStructureArtifact(options) {
  var settings = options || {};
  var detectedChapters = normalizeDetectedChapters(settings.detectedChapters);
  var headingCandidates = extractHeadingCandidates(settings.content);
  var mergedChapters = mergeChaptersWithCandidates(detectedChapters, headingCandidates);
  return {
    chapters: mergedChapters,
    health: buildStructureHealth(mergedChapters, detectedChapters, headingCandidates),
    detectionMethod: String(settings.detectionMethod || "unknown"),
    structureVersion: "canonical-structure-v1",
  };
}

function buildContextCoreLite(bookId, payload) {
  var chapters = normalizeDetectedChapters(payload.chapters);
  var chapterMap = normalizeChapterMap(chapters);
  var argumentativeArc = normalizeStringArray(payload.argumentativeArc, 6);
  var keyConcepts = normalizeStringArray(payload.keyConcepts, 8);
  var centralThesis = cleanText(payload.centralThesis);
  var pedagogicalCompendium = cleanText(payload.pedagogicalCompendium);
  var title = cleanText(payload.title) || "Libro desconocido";
  var author = cleanText(payload.author);
  var structureHealth = payload.structureHealth && typeof payload.structureHealth === "object"
    ? payload.structureHealth
    : undefined;
  var conceptSeed = []
    .concat(
      keyConcepts.map(function(label) {
        return {
          id: buildConceptId(bookId, label),
          label: label,
          pedagogicalRole: "core",
        };
      })
    )
    .concat(Array.isArray(payload.conceptNodes) ? payload.conceptNodes : [])
    .concat(
      (Array.isArray(payload.relationEdges) ? payload.relationEdges : []).flatMap(function(entry) {
        var from = cleanText(entry && (entry.from || entry.fromId));
        var to = cleanText(entry && (entry.to || entry.toId));
        return [from, to]
          .filter(Boolean)
          .map(function(reference) {
            return {
              id: reference,
              label: labelFromConceptReference(reference),
              pedagogicalRole: "supporting",
            };
          });
      })
    );
  var conceptNodes = normalizeConceptNodes(conceptSeed, bookId);
  var relationEdges = normalizeRelationEdges(payload.relationEdges, conceptNodes, chapterMap);
  var pedagogicalRisks = normalizePedagogicalRisks(payload.pedagogicalRisks);
  var crossBookSynthesis = normalizeCrossBookSynthesis(payload.crossBookSynthesis);
  var fingerprintPayload = JSON.stringify({
    bookId: bookId,
    title: title,
    author: author,
    chapterMap: chapterMap,
    centralThesis: centralThesis,
    argumentativeArc: argumentativeArc,
    keyConcepts: keyConcepts,
    conceptNodes: conceptNodes,
    relationEdges: relationEdges,
    pedagogicalRisks: pedagogicalRisks,
    crossBookSynthesis: crossBookSynthesis,
    pedagogicalCompendium: pedagogicalCompendium.slice(0, 1200),
    structureHealth: structureHealth || null,
  });
  var hash = crypto.createHash("sha1").update(fingerprintPayload).digest("hex").slice(0, 12);

  return {
    id: "ctx-book-" + bookId,
    scope: "book",
    bookIds: [String(bookId)],
    version: "ctx-v2-" + hash,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: String(bookId) + ":" + hash,
    books: [
      {
        bookId: String(bookId),
        title: title,
        author: author || undefined,
        sectionOutline: chapters,
        chapterMap: chapterMap,
        centralThesis: centralThesis || undefined,
        argumentativeArc: argumentativeArc,
        keyConcepts: keyConcepts,
        pedagogicalCompendium: pedagogicalCompendium ? pedagogicalCompendium.slice(0, 1200) : undefined,
        structureHealth: structureHealth,
        conceptNodes: conceptNodes,
        relationEdges: relationEdges,
        pedagogicalRisks: pedagogicalRisks,
      }
    ],
    crossBookSynthesis: crossBookSynthesis,
    retrievalHints: {
      factualPrioritySignals: chapterMap
        .map(function(chapter) { return String(chapter.chapterTitle || "").trim(); })
        .filter(Boolean)
        .slice(0, 8),
      conceptualPrioritySignals: []
        .concat(centralThesis ? [centralThesis] : [])
        .concat(keyConcepts)
        .concat(conceptNodes.map(function(node) { return node.label; }))
        .slice(0, 10),
      knownWeakSpots: []
        .concat(chapterMap.length === 0 ? ["chapter-map-missing"] : [])
        .concat(centralThesis ? [] : ["central-thesis-missing"])
        .concat(
          structureHealth && structureHealth.sourceDetectionIncomplete
            ? ["structure-source-incomplete"]
            : []
        )
        .concat(pedagogicalRisks.map(function(risk) { return risk.label; }).slice(0, 4)),
    }
  };
}

module.exports = {
  buildCanonicalStructureArtifact,
  buildConceptId,
  buildContextCoreLite,
  cleanText,
  extractHeadingCandidates,
  normalizeConceptNodes,
  normalizeChapterMap,
  normalizeCrossBookSynthesis,
  normalizeDetectedChapters,
  normalizePedagogicalRisks,
  normalizeRelationEdges,
  normalizeStringArray,
  safeJsonParse,
  slugify,
};
