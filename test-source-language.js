const assert = require('node:assert/strict');
const test = require('node:test');

const {
  detectSearchQueryLanguage,
  inferBookSourceLanguage,
  normalizeSourceLanguage,
} = require('./lib/sourceLanguage');

test('normalizeSourceLanguage canonicalizes ingest labels', () => {
  assert.equal(normalizeSourceLanguage('español'), 'es');
  assert.equal(normalizeSourceLanguage('EN'), 'en');
  assert.equal(normalizeSourceLanguage('de-DE'), 'de');
});

test('detectSearchQueryLanguage identifies Spanish content', () => {
  assert.equal(
    detectSearchQueryLanguage('¿Cómo usa la estética política para resistir la captura de valor?'),
    'es'
  );
});

test('inferBookSourceLanguage uses content sample fallback for ingest', () => {
  const language = inferBookSourceLanguage({
    filename: 'upload-123.md',
    contentSample: 'En las situaciones de crisis de régimen, cuando las convicciones más sólidas se erosionan, es posible ver y pensar lo que de ordinario nos resulta invisible.',
  });

  assert.equal(language, 'es');
});
