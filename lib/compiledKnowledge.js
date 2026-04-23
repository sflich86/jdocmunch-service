var crypto = require("crypto");
var contextCoreBuilder = require("./contextCoreBuilder");
var { buildHeuristicCrossBookSynthesis } = require("./crossBookGraphSynthesis");

function cleanText(value) {
  return contextCoreBuilder.cleanText(value);
}

function safeJsonParse(value, fallback) {
  return contextCoreBuilder.safeJsonParse(value, fallback);
}

function normalizeStringArray(value, limit) {
  return contextCoreBuilder.normalizeStringArray(value, limit);
}

function normalizeCrossBookSynthesis(value) {
  return contextCoreBuilder.normalizeCrossBookSynthesis(value);
}

function parseArgumentativeArc(value) {
  if (Array.isArray(value)) return normalizeStringArray(value, 12);
  return normalizeStringArray(safeJsonParse(value, []), 12);
}

function parseKeyConcepts(value) {
  if (Array.isArray(value)) return normalizeStringArray(value, 12);
  return normalizeStringArray(safeJsonParse(value, []), 12);
}

function parseChapters(value) {
  if (Array.isArray(value)) return value;
  return safeJsonParse(value, []);
}

function inferKnowledgeStatus(record) {
  if (!record) return "missing";
  var core = record.contextCoreLite;
  var book = core && Array.isArray(core.books) ? core.books[0] : null;
  var strongSignals = 0;
  if (book && cleanText(book.centralThesis)) strongSignals += 1;
  if (book && Array.isArray(book.keyConcepts) && book.keyConcepts.length > 0) strongSignals += 1;
  if (book && Array.isArray(book.chapterCards) && book.chapterCards.length > 0) strongSignals += 1;
  if (book && Array.isArray(book.sectionCards) && book.sectionCards.length > 0) strongSignals += 1;
  if (cleanText(record.pedagogicalCompendium)) strongSignals += 1;
  if (strongSignals >= 4) return "complete";
  if (strongSignals >= 1) return "partial";
  return "missing";
}

function buildBookKnowledgeFromRow(userId, row) {
  var parsedCore = safeJsonParse(row.context_core_json, null);
  var existingBook = parsedCore && parsedCore.books && parsedCore.books[0] ? parsedCore.books[0] : null;
  var bookCore =
    parsedCore && parsedCore.scope === "book" && Array.isArray(parsedCore.books) && parsedCore.books.length
      ? parsedCore
      : contextCoreBuilder.buildContextCoreLite(String(row.id), {
          title: row.title,
          author: row.author,
          sourceLanguage: row.source_language,
          chapters: parseChapters(row.chapters),
          centralThesis: row.central_thesis,
          argumentativeArc: parseArgumentativeArc(row.argumentative_arc),
          keyConcepts: parseKeyConcepts(row.key_concepts),
          pedagogicalCompendium: row.pedagogical_compendium,
          structureHealth: safeJsonParse(row.structure_health_json, null),
          crossBookSynthesis:
            parsedCore && Array.isArray(parsedCore.crossBookSynthesis)
              ? parsedCore.crossBookSynthesis
              : [],
          conceptNodes: existingBook ? existingBook.conceptNodes : [],
          relationEdges: existingBook ? existingBook.relationEdges : [],
          pedagogicalRisks: existingBook ? existingBook.pedagogicalRisks : [],
          chapterCards: existingBook ? existingBook.chapterCards : [],
          sectionCards: existingBook ? existingBook.sectionCards : [],
          topicIndex: existingBook ? existingBook.topicIndex : [],
          differenceCards: existingBook ? existingBook.differenceCards : [],
          mentalModels: existingBook ? existingBook.mentalModels : [],
          fundamentalDisagreements: existingBook ? existingBook.fundamentalDisagreements : [],
          depthProbes: existingBook ? existingBook.depthProbes : [],
        });

  var record = {
    source: "jdocmunch",
    userId: String(userId || "default"),
    bookId: String(row.id),
    title: cleanText(row.title) || cleanText(row.filename) || String(row.id),
    author: cleanText(row.author) || undefined,
    sourceLanguage:
      cleanText(row.source_language) ||
      cleanText(existingBook && existingBook.sourceLanguage) ||
      undefined,
    pedagogicalCompendium: cleanText(row.pedagogical_compendium) || undefined,
    centralThesis: cleanText(row.central_thesis) || undefined,
    argumentativeArc: parseArgumentativeArc(row.argumentative_arc),
    keyConcepts: parseKeyConcepts(row.key_concepts),
    contextCoreLite: bookCore,
  };

  record.knowledgeStatus = inferKnowledgeStatus(record);
  return record;
}

function dedupeCrossBookBridges(bridges) {
  var source = normalizeCrossBookSynthesis(bridges);
  var seen = {};
  var items = [];
  for (var i = 0; i < source.length; i++) {
    var bridge = source[i];
    var key =
      String(bridge.theme || "").toLowerCase() +
      "::" +
      normalizeStringArray(bridge.supportingBookIds, 16).sort().join(",");
    if (seen[key]) continue;
    seen[key] = true;
    items.push(bridge);
  }
  return items.slice(0, 12);
}

function aggregateRetrievalHints(cores) {
  var factual = [];
  var conceptual = [];
  var weakSpots = [];
  for (var i = 0; i < cores.length; i++) {
    var hints = (cores[i] && cores[i].retrievalHints) || {};
    factual = factual.concat(normalizeStringArray(hints.factualPrioritySignals, 20));
    conceptual = conceptual.concat(normalizeStringArray(hints.conceptualPrioritySignals, 20));
    weakSpots = weakSpots.concat(normalizeStringArray(hints.knownWeakSpots, 20));
  }

  return {
    factualPrioritySignals: normalizeStringArray(factual, 12),
    conceptualPrioritySignals: normalizeStringArray(conceptual, 14),
    knownWeakSpots: normalizeStringArray(weakSpots, 12),
  };
}

function buildBookSetContextCore(userId, records) {
  var validRecords = Array.isArray(records) ? records.filter(Boolean) : [];
  var cores = validRecords
    .map(function(record) { return record.contextCoreLite; })
    .filter(function(core) { return core && Array.isArray(core.books) && core.books.length > 0; });
  if (cores.length === 0) return null;

  var explicitBridges = dedupeCrossBookBridges(
    cores.flatMap(function(core) { return core.crossBookSynthesis || []; })
  );
  var heuristicBridges =
    explicitBridges.length === 0 && validRecords.length >= 2
      ? buildHeuristicCrossBookSynthesis({
          books: validRecords.map(function(record) {
            return {
              id: record.bookId,
              title: record.title,
              contextCore: record.contextCoreLite,
            };
          }),
          synthesisText: validRecords
            .map(function(record) { return cleanText(record.pedagogicalCompendium); })
            .filter(Boolean)
            .join("\n\n"),
        })
      : [];
  var crossBookSynthesis = explicitBridges.length > 0 ? explicitBridges : heuristicBridges;
  var fingerprint = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        userId: String(userId || "default"),
        bookIds: validRecords.map(function(record) { return record.bookId; }).sort(),
        versions: cores.map(function(core) { return core.version; }),
        crossBookSynthesis: crossBookSynthesis,
      })
    )
    .digest("hex")
    .slice(0, 12);

  return {
    id: "ctx-book-set-" + fingerprint,
    scope: "book_set",
    bookIds: validRecords.map(function(record) { return record.bookId; }),
    version: "ctx-book-set-v1-" + fingerprint,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: "book-set:" + fingerprint,
    books: cores.flatMap(function(core) { return core.books || []; }),
    crossBookSynthesis: crossBookSynthesis,
    retrievalHints: aggregateRetrievalHints(cores),
  };
}

function inferBookSetStatus(records) {
  var statuses = (Array.isArray(records) ? records : []).map(function(record) {
    return String((record && record.knowledgeStatus) || "missing");
  });
  if (statuses.length === 0) return "missing";
  if (statuses.every(function(status) { return status === "complete"; })) return "complete";
  if (statuses.some(function(status) { return status === "complete" || status === "partial"; })) {
    return "partial";
  }
  return "missing";
}

function buildBookSetKnowledgeFromRows(userId, rows) {
  var records = (Array.isArray(rows) ? rows : []).map(function(row) {
    return buildBookKnowledgeFromRow(userId, row);
  });
  var contextCoreLite = buildBookSetContextCore(userId, records);
  return {
    source: "jdocmunch",
    userId: String(userId || "default"),
    bookIds: records.map(function(record) { return record.bookId; }),
    knowledgeStatus: inferBookSetStatus(records),
    books: records,
    contextCoreLite: contextCoreLite,
    crossBookSynthesis: contextCoreLite ? contextCoreLite.crossBookSynthesis || [] : [],
  };
}

async function loadKnowledgeRows(db, userId, bookIds) {
  var ids = Array.isArray(bookIds) ? bookIds.filter(Boolean).map(String) : [];
  var sql =
    "SELECT b.id, b.title, b.author, b.filename, b.source_language, b.pedagogical_compendium, b.context_core_json, " +
    "d.central_thesis, d.argumentative_arc, d.key_concepts, s.chapters, s.structure_version, s.structure_health_json " +
    "FROM books b " +
    "LEFT JOIN book_dna d ON d.book_id = b.id " +
    "LEFT JOIN book_structure s ON s.book_id = b.id " +
    "WHERE b.user_id = ?";
  var args = [String(userId || "default")];
  if (ids.length > 0) {
    sql += " AND b.id IN (" + ids.map(function() { return "?"; }).join(", ") + ")";
    args = args.concat(ids);
  }
  sql += " ORDER BY b.created_at DESC";
  var result = await db.execute({ sql: sql, args: args });
  return result.rows || [];
}

async function loadCompiledBookKnowledge(db, userId, bookId) {
  var rows = await loadKnowledgeRows(db, userId, [bookId]);
  if (!rows.length) return null;
  return buildBookKnowledgeFromRow(userId, rows[0]);
}

async function loadCompiledBookSetKnowledge(db, userId, bookIds) {
  var rows = await loadKnowledgeRows(db, userId, bookIds);
  return buildBookSetKnowledgeFromRows(userId, rows);
}

module.exports = {
  buildBookKnowledgeFromRow: buildBookKnowledgeFromRow,
  buildBookSetKnowledgeFromRows: buildBookSetKnowledgeFromRows,
  buildBookSetContextCore: buildBookSetContextCore,
  inferKnowledgeStatus: inferKnowledgeStatus,
  loadCompiledBookKnowledge: loadCompiledBookKnowledge,
  loadCompiledBookSetKnowledge: loadCompiledBookSetKnowledge,
  loadKnowledgeRows: loadKnowledgeRows,
};
