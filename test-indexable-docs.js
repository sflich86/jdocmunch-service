const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildIndexableDocuments,
  listIndexDocPathsForBook,
  materializeIndexableDocuments
} = require("./lib/indexableDocs");

function buildLongBook(chapterCount, bodyRepeat) {
  const chapters = [];
  const parts = ["Prologo corto."];

  for (let index = 1; index <= chapterCount; index += 1) {
    const marker = `CAPITULO ${index}\nTitulo ${index}`;
    chapters.push({
      chapter_num: index,
      title: `Titulo ${index}`,
      starts_with: marker
    });
    parts.push(marker);
    parts.push((`Contenido amplio del capitulo ${index}. `).repeat(bodyRepeat));
  }

  return {
    chapters,
    content: parts.join("\n\n")
  };
}

function testBuildIndexableDocumentsKeepsSmallBooksAsSingleFile() {
  const { chapters, content } = buildLongBook(2, 50);
  const docs = buildIndexableDocuments({
    bookId: "book-small",
    filename: "short-book.pdf",
    content,
    chapters,
    maxBytes: 16 * 1024
  });

  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].docPath, "short-book.pdf.md");
  assert.strictEqual(docs[0].sourceFile, "short-book.pdf.md");
}

function testBuildIndexableDocumentsSplitsLargeBooksIntoIndexableParts() {
  const { chapters, content } = buildLongBook(6, 700);
  const docs = buildIndexableDocuments({
    bookId: "book-large",
    filename: "large-book.pdf",
    content,
    chapters,
    maxBytes: 12 * 1024
  });

  assert.ok(docs.length > 1);
  assert.ok(docs.some((doc) => doc.docPath.startsWith("book-large__jdm_")));
  assert.ok(docs.every((doc) => Buffer.byteLength(doc.content, "utf8") <= 12 * 1024));
  assert.ok(docs.every((doc) => doc.sourceFile === "large-book.pdf.md"));
}

function testMaterializeIndexableDocumentsWritesAndResolvesGeneratedPaths() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdocmunch-indexable-"));

  try {
    const { chapters, content } = buildLongBook(4, 600);

    const writtenDocs = materializeIndexableDocuments({
      userDir: tempRoot,
      bookId: "book-write",
      filename: "write-book.pdf",
      content,
      chapters,
      maxBytes: 10 * 1024
    });

    assert.ok(writtenDocs.length > 1);
    assert.ok(
      writtenDocs.every((doc) => fs.existsSync(path.join(tempRoot, doc.docPath)))
    );

    const resolvedPaths = listIndexDocPathsForBook(
      tempRoot,
      "write-book.pdf",
      "book-write"
    );

    assert.deepStrictEqual(
      resolvedPaths.slice().sort(),
      writtenDocs.map((doc) => doc.docPath).slice().sort()
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function run() {
  testBuildIndexableDocumentsKeepsSmallBooksAsSingleFile();
  testBuildIndexableDocumentsSplitsLargeBooksIntoIndexableParts();
  testMaterializeIndexableDocumentsWritesAndResolvesGeneratedPaths();
  console.log("test-indexable-docs.js: ok");
}

run();
