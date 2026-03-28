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
        { chapter_num: 24, title: "Understanding", starts_with: "Chapter 24 starts here" },
        { chapter_num: 25, title: "Clarity", starts_with: "Chapter 25 starts here" },
      ],
    },
  };
}

test("returns one structural hit per requested chapter when the query asks for multiple exact chapter titles", () => {
  const results = searchStructuralChapterMetadata(
    "cuales son los titulos de los capitulos 24 y 25 de The Score",
    buildMetadataMap(),
    { bookIds: ["book-score"] }
  );

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => [result.chapter_num, result.chapter_title]),
    [
      [24, "Understanding"],
      [25, "Clarity"],
    ]
  );
});
