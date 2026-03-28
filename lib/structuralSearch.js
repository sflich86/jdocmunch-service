function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function extractChapterNumbers(query) {
  var normalized = normalizeText(query);
  if (!/\b(?:chapter|capitulo|chapters|capitulos)\b/.test(normalized)) return [];
  return uniqueStrings((normalized.match(/\b\d{1,3}\b/g) || []).map(function(value) {
    return Number(value);
  })).filter(function(value) {
    return Number.isFinite(Number(value));
  });
}

function isChapterTitleQuery(query) {
  var normalized = normalizeText(query);
  return (
    /\b(?:titulo|titulos|title|titles)\b/.test(normalized) &&
    /\b(?:chapter|chapters|capitulo|capitulos)\b/.test(normalized)
  );
}

function buildBookNeedleCandidates(book) {
  var title = String((book && book.book_title) || "");
  var normalizedTitle = normalizeText(title);
  var withoutSubtitle = normalizedTitle.split(":")[0].trim();
  return uniqueStrings([
    normalizedTitle,
    withoutSubtitle,
    withoutSubtitle.replace(/\bthe\b/g, "").replace(/\s+/g, " ").trim()
  ]).filter(function(value) {
    return value.length >= 3;
  });
}

function selectTargetBooks(query, books, options) {
  var settings = options || {};
  var allowedIds = Array.isArray(settings.bookIds)
    ? new Set(settings.bookIds.map(String))
    : null;
  var normalizedQuery = normalizeText(query);
  var allowedBooks = (Array.isArray(books) ? books : []).filter(function(book) {
    return !allowedIds || allowedIds.has(String(book.book_id || ""));
  });

  if (!allowedBooks.length) return [];

  var requestsAllSelectedBooks =
    /\bcada uno de los libros\b/.test(normalizedQuery) ||
    /\beach of the books\b/.test(normalizedQuery) ||
    /\bboth books\b/.test(normalizedQuery) ||
    /\bambos libros\b/.test(normalizedQuery);

  if (requestsAllSelectedBooks) {
    return allowedBooks;
  }

  var matchedBooks = allowedBooks.filter(function(book) {
    return buildBookNeedleCandidates(book).some(function(needle) {
      return needle && normalizedQuery.includes(needle);
    });
  });

  if (matchedBooks.length > 0) {
    return matchedBooks;
  }

  if (allowedBooks.length === 1) {
    return allowedBooks;
  }

  return [];
}

function buildStructuralChapterChunk(book, chapterNumber, chapter, index) {
  var chapterTitle = String((chapter && chapter.title) || ("Capitulo " + String(chapterNumber)));
  var startsWith = String((chapter && chapter.starts_with) || "").trim();
  var prefix = "Titulo del capitulo " + String(chapterNumber) + ": " + chapterTitle + ".";
  var content = startsWith ? prefix + " Empieza con: " + startsWith : prefix;

  return {
    id: "structural:" + String(book.book_id || index) + ":chapter:" + String(chapterNumber),
    score: 1.5 - (index * 0.01),
    source_file: book.source_file || "libro",
    content: content,
    doc_path: book.source_file || "",
    title: "Capitulo " + String(chapterNumber),
    summary: prefix,
    book_id: String(book.book_id || ""),
    book_title: book.book_title || book.source_file || "Libro",
    author: book.author || "",
    chapter_num: chapterNumber,
    chapter_title: chapterTitle,
    section_title: "Capitulo " + String(chapterNumber),
    section_summary: prefix,
    breadcrumb: (book.book_title || "Libro") + " > Capitulo " + String(chapterNumber) + " > " + chapterTitle,
    byte_start: null,
    byte_end: null
  };
}

function searchStructuralChapterMetadata(query, metadataMap, options) {
  if (!isChapterTitleQuery(query)) return [];

  var chapterNumbers = extractChapterNumbers(query);
  if (chapterNumbers.length === 0) return [];

  var seenBookIds = {};
  var books = Object.values(metadataMap || {}).filter(function(book) {
    var key = String((book && book.book_id) || (book && book.source_file) || "");
    if (!key) return true;
    if (seenBookIds[key]) return false;
    seenBookIds[key] = true;
    return true;
  });
  var targetBooks = selectTargetBooks(query, books, options);
  if (!targetBooks.length) return [];

  return targetBooks
    .flatMap(function(book, index) {
      var chapters = Array.isArray(book && book.chapters) ? book.chapters : [];
      return chapterNumbers.map(function(chapterNumber) {
        var chapter = chapters.find(function(candidate) {
          return Number(candidate && candidate.chapter_num) === chapterNumber;
        });
        return chapter ? buildStructuralChapterChunk(book, chapterNumber, chapter, index) : null;
      });
    })
    .filter(Boolean);
}

module.exports = {
  searchStructuralChapterMetadata
};
