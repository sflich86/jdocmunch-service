const assert = require("assert");

const {
  DEFAULT_DOC_INDEX_PATH,
  getDocIndexPath,
  formatSearchResponse
} = require("./lib/searchRuntime");

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

function run() {
  testDefaultDocIndexPath();
  testSearchResponseShape();
  console.log("test-search-runtime.js: ok");
}

run();
