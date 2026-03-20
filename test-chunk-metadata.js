const assert = require("assert");

const {
  buildChapterRanges,
  buildStructuredMarkdownFromChapters,
  enrichChunksWithMetadata
} = require("./lib/chunkMetadata");

function testBuildChapterRangesFromBookStructure() {
  const content = [
    "# Querida yo, tenemos que hablar",
    "",
    "Introduccion breve.",
    "",
    "CAPITULO 1",
    "El dialogo interno",
    "Este es el inicio del primer capitulo.",
    "",
    "CAPITULO 2",
    "La responsabilidad sin culpa",
    "Este es el inicio del segundo capitulo."
  ].join("\n");

  const ranges = buildChapterRanges(content, [
    {
      chapter_num: 1,
      title: "El dialogo interno",
      starts_with: "CAPITULO 1\nEl dialogo interno"
    },
    {
      chapter_num: 2,
      title: "La responsabilidad sin culpa",
      starts_with: "CAPITULO 2\nLa responsabilidad sin culpa"
    }
  ]);

  assert.strictEqual(ranges.length, 2);
  assert.strictEqual(ranges[0].chapter_num, 1);
  assert.strictEqual(ranges[0].chapter_title, "El dialogo interno");
  assert.ok(ranges[0].byte_start < ranges[1].byte_start);
  assert.strictEqual(ranges[1].chapter_num, 2);
}

function testEnrichChunksWithBookAndChapterMetadata() {
  const content = [
    "# Querida yo, tenemos que hablar",
    "",
    "Introduccion breve.",
    "",
    "CAPITULO 1",
    "El dialogo interno",
    "Este es el inicio del primer capitulo.",
    "",
    "CAPITULO 2",
    "La responsabilidad sin culpa",
    "Este es el inicio del segundo capitulo."
  ].join("\n");

  const chapterStart = content.indexOf("CAPITULO 2");

  const chunks = enrichChunksWithMetadata(
    [
      {
        id: "sec-2",
        doc_path: "querida-yo.md",
        source_file: "querida-yo.md",
        title: "Ansiedad anticipatoria",
        summary: "Como aparece la necesidad de control",
        content: "CAPITULO 2\nLa responsabilidad sin culpa\nEste es el inicio del segundo capitulo.",
        byte_start: chapterStart,
        byte_end: chapterStart + 80,
        score: 0.91
      }
    ],
    {
      "querida-yo.md": {
        book_id: "book-1",
        book_title: "Querida yo, tenemos que hablar",
        author: "Elizabeth Clapes",
        source_file: "querida-yo.md",
        content,
        chapters: [
          {
            chapter_num: 1,
            title: "El dialogo interno",
            starts_with: "CAPITULO 1\nEl dialogo interno"
          },
          {
            chapter_num: 2,
            title: "La responsabilidad sin culpa",
            starts_with: "CAPITULO 2\nLa responsabilidad sin culpa"
          }
        ]
      }
    }
  );

  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].book_id, "book-1");
  assert.strictEqual(chunks[0].book_title, "Querida yo, tenemos que hablar");
  assert.strictEqual(chunks[0].author, "Elizabeth Clapes");
  assert.strictEqual(chunks[0].chapter_num, 2);
  assert.strictEqual(chunks[0].chapter_title, "La responsabilidad sin culpa");
  assert.strictEqual(chunks[0].section_title, "Ansiedad anticipatoria");
  assert.strictEqual(chunks[0].section_summary, "Como aparece la necesidad de control");
  assert.strictEqual(
    chunks[0].breadcrumb,
    "Querida yo, tenemos que hablar > Capitulo 2 > La responsabilidad sin culpa > Ansiedad anticipatoria"
  );
}

function testBuildStructuredMarkdownFromChapters() {
  const content = [
    "Portadilla",
    "",
    "Introduccion breve.",
    "",
    "CAPITULO 1",
    "El dialogo interno",
    "Este es el inicio del primer capitulo.",
    "",
    "CAPITULO 2",
    "La responsabilidad sin culpa",
    "Este es el inicio del segundo capitulo."
  ].join("\n");

  const structured = buildStructuredMarkdownFromChapters(content, [
    {
      chapter_num: 1,
      title: "El dialogo interno",
      starts_with: "CAPITULO 1\nEl dialogo interno"
    },
    {
      chapter_num: 2,
      title: "La responsabilidad sin culpa",
      starts_with: "CAPITULO 2\nLa responsabilidad sin culpa"
    }
  ]);

  assert.match(structured, /# Material inicial/);
  assert.match(structured, /# 1\. El dialogo interno/);
  assert.match(structured, /# 2\. La responsabilidad sin culpa/);
  assert.ok(structured.indexOf("# 1. El dialogo interno") < structured.indexOf("# 2. La responsabilidad sin culpa"));
}

function run() {
  testBuildChapterRangesFromBookStructure();
  testEnrichChunksWithBookAndChapterMetadata();
  testBuildStructuredMarkdownFromChapters();
  console.log("test-chunk-metadata.js: ok");
}

run();
