function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeForMatching(value) {
    return cleanText(value)
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
        .toLowerCase()
        .trim();
}

function normalizeSourceLanguage(value) {
    var normalized = cleanText(value).toLowerCase().replace(/_/g, "-");
    var base = normalized.split("-")[0] || normalized;
    if (["en", "eng", "english", "ingles", "inglés"].indexOf(base) !== -1) return "en";
    if (["es", "spa", "spanish", "espanol", "español", "castellano"].indexOf(base) !== -1) return "es";
    if (["fr", "fra", "fre", "french", "frances", "francés"].indexOf(base) !== -1) return "fr";
    if (["de", "deu", "ger", "german", "aleman", "alemán"].indexOf(base) !== -1) return "de";
    if (["pt", "por", "portuguese", "portugues", "português"].indexOf(base) !== -1) return "pt";
    if (["it", "ita", "italian", "italiano"].indexOf(base) !== -1) return "it";
    return "unknown";
}

function scoreStopwordMatches(text, stopwords) {
    var tokens = String(text || "")
        .split(/\s+/)
        .map(function(token) { return token.trim(); })
        .filter(Boolean);
    var dictionary = new Set(stopwords);
    return tokens.reduce(function(score, token) {
        return score + (dictionary.has(token) ? 1 : 0);
    }, 0);
}

function computeLanguageCounts(text) {
    return {
        es: scoreStopwordMatches(text, ["el", "la", "los", "las", "de", "del", "que", "por", "para", "con", "sobre", "como", "porque", "donde", "cual", "cuales", "explica", "analiza"]),
        en: scoreStopwordMatches(text, ["the", "and", "of", "to", "in", "with", "why", "how", "what", "where", "when", "explain", "analyze", "game", "designer"]),
        fr: scoreStopwordMatches(text, ["le", "la", "les", "des", "du", "et", "pour", "avec", "pourquoi", "comment", "quel", "quelle"]),
        de: scoreStopwordMatches(text, ["der", "die", "das", "und", "mit", "warum", "wie", "was", "welche"]),
        pt: scoreStopwordMatches(text, ["o", "a", "os", "as", "de", "do", "da", "e", "para", "com", "porque", "como", "qual"]),
        it: scoreStopwordMatches(text, ["il", "lo", "la", "gli", "le", "di", "del", "e", "con", "per", "perche", "come", "quale"])
    };
}

function detectSearchQueryLanguage(query) {
    var raw = " " + normalizeForMatching(query) + " ";
    if (!raw.trim()) return "unknown";

    var counts = computeLanguageCounts(raw);
    if (/[¿¡ñáéíóú]/i.test(String(query || ""))) {
        counts.es += 3;
    }
    if (/\b(the|designer|score|play|game|choice|difficulty)\b/i.test(String(query || ""))) {
        counts.en += 2;
    }

    var sorted = Object.entries(counts).sort(function(left, right) { return right[1] - left[1]; });
    var bestLang = sorted[0] ? sorted[0][0] : "unknown";
    var bestScore = sorted[0] ? sorted[0][1] : 0;
    var secondScore = sorted[1] ? sorted[1][1] : 0;
    if (!bestLang || bestScore <= 0 || bestScore < secondScore + 1) {
        return "unknown";
    }
    return normalizeSourceLanguage(bestLang);
}

function inferBookSourceLanguage(args) {
    var explicit = normalizeSourceLanguage(args && args.sourceLanguage);
    if (explicit !== "unknown") return explicit;

    var chapterTitles = Array.isArray(args && args.chapterTitles) ? args.chapterTitles : [];
    var keyConcepts = Array.isArray(args && args.keyConcepts) ? args.keyConcepts : [];

    var titleAndChapterText = [
        cleanText(args && args.title),
        cleanText(args && args.filename)
    ].concat(chapterTitles.map(function(value) { return cleanText(value); }))
      .filter(Boolean)
      .join(" \n ");
    var titleAndChapterLanguage = detectSearchQueryLanguage(titleAndChapterText);
    if (titleAndChapterLanguage !== "unknown") return titleAndChapterLanguage;

    var structuralText = [
        cleanText(args && args.title),
        cleanText(args && args.author),
        cleanText(args && args.filename)
    ].concat(keyConcepts.map(function(value) { return cleanText(value); }))
      .concat(chapterTitles.map(function(value) { return cleanText(value); }))
      .filter(Boolean)
      .join(" \n ");
    var structuralLanguage = detectSearchQueryLanguage(structuralText);
    if (structuralLanguage !== "unknown") return structuralLanguage;

    var pedagogicalLanguage = detectSearchQueryLanguage(cleanText(args && args.pedagogicalCompendium).slice(0, 600));
    if (pedagogicalLanguage !== "unknown") return pedagogicalLanguage;

    return detectSearchQueryLanguage(cleanText(args && args.contentSample).slice(0, 2400));
}

module.exports = {
    detectSearchQueryLanguage,
    inferBookSourceLanguage,
    normalizeSourceLanguage
};
