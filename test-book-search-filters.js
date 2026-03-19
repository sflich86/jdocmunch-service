const assert = require("assert");

const { buildBookMetadataQuery } = require("./lib/bookSearchFilters");

function testBookMetadataQueryQualifiesBookIdFilter() {
  const result = buildBookMetadataQuery("admin", [
    "book-1",
    "book-2"
  ]);

  assert.ok(
    result.sql.includes("WHERE b.user_id = ? AND b.id IN (?, ?)"),
    "should qualify the filtered id column with the books alias"
  );
  assert.deepStrictEqual(result.args, ["admin", "book-1", "book-2"]);
}

function testBookMetadataQueryWithoutIds() {
  const result = buildBookMetadataQuery("admin", []);

  assert.ok(result.sql.includes("WHERE b.user_id = ?"));
  assert.ok(!result.sql.includes("AND b.id IN"));
  assert.deepStrictEqual(result.args, ["admin"]);
}

function run() {
  testBookMetadataQueryQualifiesBookIdFilter();
  testBookMetadataQueryWithoutIds();
  console.log("test-book-search-filters.js: ok");
}

run();
