const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DEFAULT_DOC_INDEX_PATH,
  getDocIndexPath,
  prioritizeSearchChunks,
  formatSearchResponse,
  extractSectionRecord,
  readChunkFromRawFile
} = require("./lib/searchRuntime");
const {
  normalizeVector,
  cosineSimilarity
} = require("./lib/semanticSearch");

function testDefaultDocIndexPath() {
  assert.strictEqual(
    getDocIndexPath({}),
    DEFAULT_DOC_INDEX_PATH,
    "should default to the persisted doc index path"
  );

  assert.strictEqual(
    getDocIndexPath({ DOC_INDEX_PATH: "/tmp/custom-doc-index" }),
    "/tmp/custom-doc-index",
    "should respect an explicit DOC_INDEX_PATH override"
  );
}

function testSearchResponseShape() {
  const response = formatSearchResponse("miedo", [
    {
      id: "sec-1",
      content: "Contenido del chunk",
      source_file: "querida.md",
      score: 0.91
    }
  ]);

  assert.strictEqual(response.success, true);
  assert.strictEqual(response.query, "miedo");
  assert.strictEqual(response.total_chunks, 1);
  assert.strictEqual(response.candidates.length, 1);
  assert.strictEqual(response.results.length, 1);
  assert.strictEqual(response.candidates[0].text, "Contenido del chunk");
  assert.strictEqual(response.results[0].content, "Contenido del chunk");
  assert.strictEqual(response.results[0].title, "querida.md");
}

function testPrioritizeSearchChunks() {
  const prioritized = prioritizeSearchChunks([
    {
      id: "heading-hit",
      content: "## 24. The Seductions of Clarity",
      source_file: "the-score.md",
      book_id: "book-score",
      book_title: "The Score",
      chapter_num: 24,
      chapter_title: "The Seductions of Clarity",
      section_title: "24. The Seductions of Clarity",
      score: 0.95
    },
    {
      id: "body-hit",
      content:
        "Clarity is a feeling of things falling into place. But the feeling of clarity is distinct from real understanding, and so it can be faked.",
      source_file: "the-score.md",
      book_id: "book-score",
      book_title: "The Score",
      chapter_num: 24,
      chapter_title: "The Seductions of Clarity",
      section_title: "Pagina 206",
      score: 0.91
    },
    {
      id: "raw-id-hit",
      content: "raw generated chunk id",
      source_file: "the-score.md",
      book_id: "book-score",
      book_title: "The Score",
      chapter_num: 24,
      chapter_title: "The Seductions of Clarity",
      section_title: "623e2640__jdm_ch024__s01",
      score: 0.89
    }
  ]);

  assert.strictEqual(prioritized[0].id, "body-hit");
  assert.ok(!prioritized.some((chunk) => chunk.id === "raw-id-hit"));
}

function testPrioritizeSearchChunksInfersChapterGroupingFromHeadingLikeNoise() {
  const prioritized = prioritizeSearchChunks([
    {
      id: "heading-hit",
      content: "## 24. The Seductions of Clarity",
      source_file: "the-score.md",
      book_id: "book-score",
      book_title: "The Score",
      section_title: "24. The Seductions of Clarity",
      score: 0.95
    },
    {
      id: "raw-id-hit",
      content:
        "# 24. The Seductions of Clarity\n\n## CHAPTER 24\n\nThe Seductions of Clarity\nThe second mask of metrics is clarity.",
      source_file: "the-score.md",
      book_id: "book-score",
      book_title: "The Score",
      section_title: "623e2640-a9ea-45fc-b84d-559a7bbcc90b__jdm_ch024__s01",
      score: 0.93
    },
    {
      id: "body-hit",
      content:
        "## PÃ¡gina 206\n\nClarity is a feeling of things falling into place. But the feeling of clarity is distinct from real understanding.",
      source_file: "the-score.md",
      book_id: "book-score",
      book_title: "The Score",
      chapter_num: 24,
      chapter_title: "The Seductions of Clarity",
      section_title: "PÃ¡gina 206",
      score: 0.91
    }
  ]);

  assert.strictEqual(prioritized[0].id, "body-hit");
  assert.ok(!prioritized.some((chunk) => chunk.id === "heading-hit"));
  assert.ok(!prioritized.some((chunk) => chunk.id === "raw-id-hit"));
}

function testExtractSectionRecord() {
  const wrapped = extractSectionRecord({
    section: {
      id: "sec-1",
      content: "Contenido real",
      source_file: "querida.md"
    }
  });

  assert.strictEqual(wrapped.id, "sec-1");
  assert.strictEqual(wrapped.content, "Contenido real");
  assert.strictEqual(wrapped.source_file, "querida.md");

  const legacy = extractSectionRecord({
    id: "sec-2",
    text: "Texto legacy"
  });
  assert.strictEqual(legacy.id, "sec-2");
  assert.strictEqual(legacy.text, "Texto legacy");
}

function testReadChunkFromRawFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdocmunch-search-"));
  const docIndexPath = path.join(root, "doc-index");
  const booksDir = path.join(root, "books");
  const localRepoDir = path.join(docIndexPath, "local", "admin");
  const userBooksDir = path.join(booksDir, "admin");
  const docName = "querida.md";
  const content = "hola miedo mundo";
  const start = content.indexOf("miedo");
  const end = start + "miedo".length;

  fs.mkdirSync(localRepoDir, { recursive: true });
  fs.mkdirSync(userBooksDir, { recursive: true });
  fs.writeFileSync(path.join(localRepoDir, docName), content, "utf8");
  fs.writeFileSync(path.join(userBooksDir, docName), content, "utf8");

  assert.strictEqual(
    readChunkFromRawFile({
      env: { DOC_INDEX_PATH: docIndexPath },
      booksDir: booksDir,
      userId: "admin",
      docPath: docName,
      byteStart: start,
      byteEnd: end
    }),
    "miedo"
  );

  fs.rmSync(root, { recursive: true, force: true });
}

function testVectorHelpers() {
  const normalized = normalizeVector([3, 4]);
  assert.ok(Math.abs(normalized[0] - 0.6) < 0.0001);
  assert.ok(Math.abs(normalized[1] - 0.8) < 0.0001);
  assert.ok(Math.abs(cosineSimilarity(normalized, normalized) - 1) < 0.0001);
}

function run() {
  testDefaultDocIndexPath();
  testSearchResponseShape();
  testPrioritizeSearchChunks();
  testPrioritizeSearchChunksInfersChapterGroupingFromHeadingLikeNoise();
  testExtractSectionRecord();
  testReadChunkFromRawFile();
  testVectorHelpers();
  console.log("test-search-runtime.js: ok");
}

run();
