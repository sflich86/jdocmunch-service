function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function normalizeSearchText(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

module.exports = {
  cleanText,
  normalizeLineEndings,
  normalizeSearchText,
};
