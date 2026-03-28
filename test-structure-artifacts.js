const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCanonicalStructureArtifact,
} = require("./lib/structureArtifacts");
const { buildContextCoreLite } = require("./lib/contextCoreBuilder");

function buildDetectedChapters(count) {
  return Array.from({ length: count }, (_, index) => ({
    chapter_num: index + 1,
    title: `Title ${index + 1}`,
    starts_with: `Body ${index + 1}`,
  }));
}

function buildRawContent(count) {
  return Array.from(
    { length: count },
    (_, index) => `Chapter ${index + 1}: Title ${index + 1}\n\nThis is the body for chapter ${index + 1}.`
  ).join("\n\n");
}

test("buildCanonicalStructureArtifact flags a truncated outline when raw content exposes more numbered chapters", () => {
  const artifact = buildCanonicalStructureArtifact({
    detectedChapters: buildDetectedChapters(5),
    content: buildRawContent(25),
    detectionMethod: "llm_v3",
  });

  assert.equal(artifact.chapters.length, 25);
  assert.equal(artifact.health.numberedEntryCount, 25);
  assert.equal(artifact.health.headingCandidateCount, 25);
  assert.equal(artifact.health.headingCandidateMaxChapter, 25);
  assert.equal(artifact.health.possiblyIncomplete, true);
  assert.equal(artifact.health.isReliableForExactLookup, true);
});

test("buildContextCoreLite preserves full chapter maps for long books instead of truncating them at 24", () => {
  const contextCore = buildContextCoreLite("book-score", {
    title: "The Score",
    author: "C. Thi Nguyen",
    chapters: buildDetectedChapters(25),
    centralThesis: "La captura de valor reduce lo valioso a una señal estrecha.",
    argumentativeArc: ["apertura", "captura", "agencia"],
    keyConcepts: ["captura de valor", "agencia"],
    pedagogicalCompendium: "Compendio de prueba.",
    structureHealth: {
      isReliableForExactLookup: true,
      sourceDetectionIncomplete: false,
    },
  });

  assert.equal(contextCore.books[0].chapterMap.length, 25);
  assert.equal(contextCore.books[0].chapterMap.at(-1).chapterNumber, 25);
});
