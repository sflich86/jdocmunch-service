const fs = require("fs");
const path = require("path");

const { buildChapterRanges, buildStructuredMarkdownFromChapters } = require("./chunkMetadata");
const { getIndexedFilename } = require("./searchRuntime");

const DEFAULT_MAX_INDEXABLE_DOC_BYTES = 450 * 1024;
const GENERATED_DOC_SEPARATOR = "__jdm_";
const GENERATED_DOC_RE = /__jdm_ch(\d{3})__s(\d{2})\.md$/i;

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function sanitizePositiveInt(value, fallback) {
  var next = Number(value);
  if (!Number.isFinite(next) || next < 1) return fallback;
  return Math.floor(next);
}

function buildGeneratedDocPath(bookId, chapterNumber, sliceIndex) {
  return [
    String(bookId || "book"),
    GENERATED_DOC_SEPARATOR,
    "ch",
    String(sanitizePositiveInt(chapterNumber, 0)).padStart(3, "0"),
    "__s",
    String(sanitizePositiveInt(sliceIndex, 1)).padStart(2, "0"),
    ".md"
  ].join("");
}

function isGeneratedIndexDocPathForBook(docPath, bookId) {
  return String(docPath || "").startsWith(String(bookId || "") + GENERATED_DOC_SEPARATOR);
}

function getGeneratedDocChapterNumber(docPath) {
  var match = String(docPath || "").match(GENERATED_DOC_RE);
  if (!match) return null;
  var chapterNumber = Number(match[1]);
  return Number.isFinite(chapterNumber) ? chapterNumber : null;
}

function splitOversizedParagraph(paragraph, maxBytes) {
  var tokens = String(paragraph || "").split(/(\s+)/).filter(Boolean);
  var slices = [];
  var current = "";

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    var candidate = current ? current + token : token;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    if (current) {
      slices.push(current.trim());
      current = token.trim();
      if (byteLength(current) <= maxBytes) {
        continue;
      }
    }

    var chunk = "";
    for (var j = 0; j < token.length; j++) {
      var next = chunk + token[j];
      if (byteLength(next) > maxBytes && chunk) {
        slices.push(chunk);
        chunk = token[j];
      } else {
        chunk = next;
      }
    }
    current = chunk;
  }

  if (current.trim()) {
    slices.push(current.trim());
  }

  return slices.filter(Boolean);
}

function splitTextByMaxBytes(text, maxBytes) {
  var normalized = normalizeText(text).trim();
  if (!normalized) return [];
  if (byteLength(normalized) <= maxBytes) return [normalized];

  var paragraphs = normalized.split(/\n{2,}/);
  var slices = [];
  var current = "";

  for (var i = 0; i < paragraphs.length; i++) {
    var paragraph = paragraphs[i].trim();
    if (!paragraph) continue;

    if (byteLength(paragraph) > maxBytes) {
      if (current) {
        slices.push(current);
        current = "";
      }
      var oversizedSlices = splitOversizedParagraph(paragraph, maxBytes);
      for (var j = 0; j < oversizedSlices.length; j++) {
        slices.push(oversizedSlices[j]);
      }
      continue;
    }

    var candidate = current ? current + "\n\n" + paragraph : paragraph;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    if (current) {
      slices.push(current);
    }
    current = paragraph;
  }

  if (current) {
    slices.push(current);
  }

  return slices.filter(Boolean);
}

function buildChapterDocument(range, contentBuffer, fallbackIndex) {
  var chapterNumber = Number(range.chapter_num || fallbackIndex + 1);
  var chapterTitle = String(range.chapter_title || ("Capitulo " + String(fallbackIndex + 1)));
  var chapterBody = contentBuffer
    .subarray(range.byte_start || 0, range.byte_end || contentBuffer.length)
    .toString("utf8")
    .trim();
  var heading = "# " + String(chapterNumber) + ". " + chapterTitle;

  return {
    chapterNumber: chapterNumber,
    content: (heading + "\n\n" + chapterBody).trim()
  };
}

function buildIndexableDocuments(options) {
  var settings = options || {};
  var bookId = String(settings.bookId || "book");
  var sourceFile = getIndexedFilename(settings.filename, bookId);
  var maxBytes = sanitizePositiveInt(settings.maxBytes, DEFAULT_MAX_INDEXABLE_DOC_BYTES);
  var rawContent = normalizeText(settings.content);
  var chapters = Array.isArray(settings.chapters) ? settings.chapters : [];
  var structuredContent = buildStructuredMarkdownFromChapters(rawContent, chapters);

  if (byteLength(structuredContent) <= maxBytes) {
    return [
      {
        docPath: sourceFile,
        sourceFile: sourceFile,
        content: structuredContent
      }
    ];
  }

  var ranges = buildChapterRanges(rawContent, chapters);
  var buffer = Buffer.from(rawContent, "utf8");
  var documents = [];

  if (ranges.length > 0) {
    var intro = buffer.subarray(0, ranges[0].byte_start || 0).toString("utf8").trim();
    if (intro) {
      var introSlices = splitTextByMaxBytes("# Material inicial\n\n" + intro, maxBytes);
      for (var i = 0; i < introSlices.length; i++) {
        documents.push({
          docPath: buildGeneratedDocPath(bookId, 0, i + 1),
          sourceFile: sourceFile,
          content: introSlices[i]
        });
      }
    }

    for (var j = 0; j < ranges.length; j++) {
      var chapterDocument = buildChapterDocument(ranges[j], buffer, j);
      var chapterSlices = splitTextByMaxBytes(chapterDocument.content, maxBytes);
      for (var k = 0; k < chapterSlices.length; k++) {
        documents.push({
          docPath: buildGeneratedDocPath(bookId, chapterDocument.chapterNumber, k + 1),
          sourceFile: sourceFile,
          content: chapterSlices[k]
        });
      }
    }
  }

  if (documents.length === 0) {
    var genericSlices = splitTextByMaxBytes(structuredContent, maxBytes);
    for (var n = 0; n < genericSlices.length; n++) {
      documents.push({
        docPath: buildGeneratedDocPath(bookId, 0, n + 1),
        sourceFile: sourceFile,
        content: genericSlices[n]
      });
    }
  }

  return documents;
}

function listIndexDocPathsForBook(userDir, filename, bookId) {
  var sourceFile = getIndexedFilename(filename, bookId);
  var generated = [];

  try {
    if (userDir && fs.existsSync(userDir)) {
      generated = fs.readdirSync(userDir)
        .filter(function(entry) {
          return isGeneratedIndexDocPathForBook(entry, bookId);
        })
        .sort();
    }
  } catch (_error) {}

  if (generated.length > 0) {
    return generated;
  }

  if (userDir && fs.existsSync(path.join(userDir, sourceFile))) {
    return [sourceFile];
  }

  return [sourceFile];
}

function removeGeneratedDocsForBook(userDir, bookId) {
  if (!userDir || !fs.existsSync(userDir)) return;

  var entries = fs.readdirSync(userDir);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!isGeneratedIndexDocPathForBook(entry, bookId)) continue;
    fs.rmSync(path.join(userDir, entry), { force: true });
  }
}

function materializeIndexableDocuments(options) {
  var settings = options || {};
  var userDir = settings.userDir;
  var bookId = String(settings.bookId || "book");
  var sourceFile = getIndexedFilename(settings.filename, bookId);
  var docs = buildIndexableDocuments(settings);
  var usesGeneratedDocs = docs.some(function(doc) {
    return isGeneratedIndexDocPathForBook(doc.docPath, bookId);
  });

  fs.mkdirSync(userDir, { recursive: true });
  removeGeneratedDocsForBook(userDir, bookId);

  if (usesGeneratedDocs) {
    fs.rmSync(path.join(userDir, sourceFile), { force: true });
  }

  for (var i = 0; i < docs.length; i++) {
    var doc = docs[i];
    fs.writeFileSync(path.join(userDir, doc.docPath), doc.content, "utf8");
  }

  return docs;
}

function getChaptersForDocPath(docPath, chapters) {
  var chapterNumber = getGeneratedDocChapterNumber(docPath);
  var source = Array.isArray(chapters) ? chapters : [];
  if (chapterNumber === null) return source;
  if (chapterNumber === 0) return [];

  return source.filter(function(chapter) {
    return Number(chapter && chapter.chapter_num) === chapterNumber;
  });
}

module.exports = {
  DEFAULT_MAX_INDEXABLE_DOC_BYTES,
  buildIndexableDocuments,
  getChaptersForDocPath,
  getGeneratedDocChapterNumber,
  isGeneratedIndexDocPathForBook,
  listIndexDocPathsForBook,
  materializeIndexableDocuments
};
