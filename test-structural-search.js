const test = require("node:test");
const assert = require("node:assert/strict");

const { searchStructuralChapterMetadata } = require("./lib/structuralSearch");

function buildMetadataMap() {
  return {
    "the-score.pdf": {
      book_id: "book-score",
      book_title: "The Score: How to Stop Playing Someone Else's Game",
      author: "C. Thi Nguyen",
      source_file: "the-score.pdf",
      chapters: [
        { chapter_num: 1, title: "Opening Moves", starts_with: "About the Author" },
        { chapter_num: 2, title: "What Scores Do", starts_with: "For Mel" }
      ]
    },
    "poetas.pdf": {
      book_id: "book-poetas",
      book_title: "El lugar de los poetas",
      author: "Luis Alegre Zahonero",
      source_file: "poetas.pdf",
      chapters: [
        { chapter_num: 1, title: "Introduccion: El desacoplamiento de las esferas", starts_with: "Comunmente se entiende" },
        { chapter_num: 2, title: "La autonomia del arte y la crisis de la belleza", starts_with: "XVIII. Esta idea" }
      ]
    }
  };
}

test("returns a structural chapter-title hit for a single-book chapter-title query", () => {
  const results = searchStructuralChapterMetadata(
    "titulo del capitulo 2 de The Score",
    buildMetadataMap(),
    { bookIds: ["book-score"] }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].book_id, "book-score");
  assert.equal(results[0].chapter_num, 2);
  assert.equal(results[0].chapter_title, "What Scores Do");
  assert.match(results[0].content, /What Scores Do/);
});

test("returns one structural hit per book when the query asks for chapter title of each selected book", () => {
  const results = searchStructuralChapterMetadata(
    'titulo del capitulo 2 de "The Score" y titulo del capitulo 2 de "El lugar de los poetas"',
    buildMetadataMap(),
    { bookIds: ["book-score", "book-poetas"] }
  );

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => [result.book_id, result.chapter_title]),
    [
      ["book-score", "What Scores Do"],
      ["book-poetas", "La autonomia del arte y la crisis de la belleza"]
    ]
  );
});

test("ignores queries that are not asking for chapter titles", () => {
  const results = searchStructuralChapterMetadata(
    "quiero comparar la captura de valor con el juicio estetico",
    buildMetadataMap(),
    { bookIds: ["book-score", "book-poetas"] }
  );

  assert.deepEqual(results, []);
});
