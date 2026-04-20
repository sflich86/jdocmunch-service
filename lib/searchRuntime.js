const fs = require("fs");
const path = require("path");
const { cleanText } = require("./textUtils");

const DEFAULT_DOC_INDEX_PATH = "/root/.local/share/jdocmunch/doc-index";

function getDocIndexPath(env) {
    var source = env || process.env;
    return source.DOC_INDEX_PATH || DEFAULT_DOC_INDEX_PATH;
}

function getIndexedFilename(filename, fallbackBookId) {
    var safeFilename = String(filename || fallbackBookId || "book");
    if (!safeFilename.toLowerCase().endsWith(".md") && !safeFilename.toLowerCase().endsWith(".txt")) {
        safeFilename += ".md";
    }
    return safeFilename;
}

function extractSectionRecord(payload) {
    if (!payload || typeof payload !== "object") return {};
    if (payload.section && typeof payload.section === "object") return payload.section;
    return payload;
}

function readChunkFromRawFile(options) {
    var source = options || {};
    var docPath = source.docPath;
    if (!docPath) return "";

    var userId = String(source.userId || "default");
    var byteStart = Number.isFinite(source.byteStart) ? source.byteStart : 0;
    var byteEnd = Number.isFinite(source.byteEnd) ? source.byteEnd : 0;

    var candidates = [
        path.join(getDocIndexPath(source.env), "local", userId, docPath),
        path.join(source.booksDir || "", userId, docPath)
    ];

    for (var i = 0; i < candidates.length; i++) {
        var filePath = candidates[i];
        if (!filePath || !fs.existsSync(filePath)) continue;

        try {
            var raw = fs.readFileSync(filePath);
            var hasRange = byteEnd > byteStart && byteStart >= 0;
            var slice = hasRange ? raw.subarray(byteStart, byteEnd) : raw;
            return slice.toString("utf8");
        } catch (err) {}
    }

    return "";
}

function normalizeForSearch(value) {
    return cleanText(value)
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

function extractRareSearchPhrases(query) {
    var raw = String(query || "");
    var properNames = Array.from(new Set(raw.match(/\b[A-ZÁÉÍÓÚÜÑ][\p{L}.'’-]+(?:\s+[A-ZÁÉÍÓÚÜÑ][\p{L}.'’-]+)+/gu) || []))
        .flatMap(function(phrase) {
            var parts = cleanText(phrase).split(/\s+/).filter(Boolean);
            if (parts.length <= 2) return [phrase];
            var windows = [];
            for (var i = 0; i < parts.length - 1; i++) {
                windows.push(parts[i] + " " + parts[i + 1]);
            }
            return windows;
        });
    var specialTerms = [];
    var normalized = normalizeForSearch(raw);
    if (normalized.indexOf("legibility") !== -1) specialTerms.push("legibility");
    return Array.from(new Set(properNames.concat(specialTerms)))
        .map(function(value) { return cleanText(value); })
        .filter(function(value) {
            var normalizedValue = normalizeForSearch(value);
            if (value.length < 5) return false;
            if (normalizedValue === "the score") return false;
            if (normalizedValue === "state") return false;
            if (normalizedValue === "game") return false;
            return true;
        });
}

function inferChapterMetadataFromDoc(docPath, content, matchIndex) {
    var fileMatch = String(docPath || "").match(/__jdm_ch(\d{3})__/i);
    var chapterNum = fileMatch ? Number(fileMatch[1]) : null;
    var chapterTitle = "";

    var prefix = String(content || "").slice(0, Math.max(0, matchIndex));
    var headings = prefix.match(/(?:^|\n)(?:#|##)\s*(?:CHAPTER|Cap[ií]tulo)?\s*(\d+)?[.: -]*([^\n]{3,120})/gim) || [];
    if (headings.length > 0) {
        var lastHeading = headings[headings.length - 1];
        var parsed = lastHeading.match(/(?:CHAPTER|Cap[ií]tulo)?\s*(\d+)?[.: -]*([^\n]{3,120})/i);
        if (parsed) {
            if (!chapterNum && parsed[1]) chapterNum = Number(parsed[1]);
            chapterTitle = cleanText(parsed[2] || "");
        }
    }

    return {
        chapter_num: chapterNum,
        chapter_title: chapterTitle
    };
}

function searchRawPhraseChunks(query, options) {
    var settings = options || {};
    var userId = String(settings.userId || "default");
    var env = settings.env || process.env;
    var booksDir = settings.booksDir || "";
    var docPaths = Array.isArray(settings.docPaths) ? settings.docPaths.filter(Boolean) : [];
    var phrases = extractRareSearchPhrases(query);
    if (phrases.length === 0) return [];

    var normalizedPhrases = phrases.map(normalizeForSearch);
    var targets = docPaths.length
        ? docPaths
        : fs.existsSync(path.join(booksDir, userId))
            ? fs.readdirSync(path.join(booksDir, userId)).filter(function(name) { return /\.md$/i.test(name); })
            : [];

    var results = [];
    for (var i = 0; i < targets.length; i++) {
        var docPath = String(targets[i] || "");
        if (!docPath) continue;
        var fullPath = path.join(booksDir, userId, docPath);
        if (!fs.existsSync(fullPath)) continue;

        var raw = "";
        try {
            raw = fs.readFileSync(fullPath, "utf8");
        } catch (_err) {
            continue;
        }

        var normalizedRaw = normalizeForSearch(raw);
        var matchedPhrases = normalizedPhrases.filter(function(phrase) {
            return phrase && normalizedRaw.indexOf(phrase) !== -1;
        });
        if (matchedPhrases.length === 0) continue;

        var matchedPhrase = matchedPhrases[0];
        var matchIndex = normalizedRaw.indexOf(matchedPhrase);
        var start = Math.max(0, matchIndex - 700);
        var end = Math.min(raw.length, matchIndex + 1500);
        var snippet = raw.slice(start, end).trim();
        var chapterMeta = inferChapterMetadataFromDoc(docPath, raw, matchIndex);
        results.push({
            id: "raw-phrase:" + docPath + ":" + matchedPhrase,
            score: 1.2 + matchedPhrases.reduce(function(total, phrase) {
                return total + (phrase.split(/\s+/).length * 0.08);
            }, 0),
            source_file: docPath,
            content: snippet,
            doc_path: docPath,
            title: chapterMeta.chapter_title || docPath,
            summary: matchedPhrases.join(" | "),
            chapter_num: chapterMeta.chapter_num,
            chapter_title: chapterMeta.chapter_title,
            section_title: chapterMeta.chapter_title || matchedPhrase,
            section_summary: matchedPhrases.join(" | "),
            breadcrumb: docPath + " > " + (chapterMeta.chapter_title || matchedPhrases.join(" | ")),
            byte_start: start,
            byte_end: end
        });
    }

    return results;
}

function looksRawGeneratedLabel(value) {
    var text = cleanText(value).toLowerCase();
    return text.indexOf("__jdm_") !== -1 || text.indexOf("::") !== -1;
}

function isHeadingOnlyChunk(chunk) {
    var rawText = String(chunk && chunk.content || "");
    var lines = rawText
        .split(/\r?\n/g)
        .map(function(line) { return line.trim(); })
        .filter(Boolean);
    var text = cleanText(chunk && chunk.content);
    var sectionTitle = cleanText(chunk && (chunk.section_title || chunk.title));
    var chapterTitle = cleanText(chunk && chunk.chapter_title);
    var normalizedText = text.replace(/^#+\s*/, "").trim().toLowerCase();
    var normalizedSection = sectionTitle.toLowerCase();
    var normalizedChapter = chapterTitle.toLowerCase();

    if (/^#+\s*/.test(text) && lines.length <= 1 && text.length <= 140) {
        return true;
    }

    if (!normalizedText) return false;
    return (
        normalizedText === normalizedSection ||
        normalizedText === normalizedChapter ||
        normalizedText === (String(chunk && chunk.chapter_num || "") + ". " + normalizedChapter).trim()
    );
}

function hasSubstantiveChunkText(chunk) {
    var text = cleanText(chunk && chunk.content);
    return text.length >= 120 && !isHeadingOnlyChunk(chunk);
}

function inferChapterAnchorFromValue(value) {
    var raw = String(value || "");
    var lines = raw
        .split(/\r?\n/g)
        .map(function(line) { return line.replace(/^#+\s*/, "").trim(); })
        .filter(Boolean);

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var match = line.match(/^(\d+)\.\s+(.+)$/);
        if (match) {
            return {
                chapter_num: Number(match[1]),
                chapter_title: cleanText(match[2]) || undefined
            };
        }

        match = line.match(/^(?:chapter|cap[iÃ­]tulo)\s+(\d+)\s*[:.-]?\s*(.+)?$/i);
        if (match) {
            return {
                chapter_num: Number(match[1]),
                chapter_title: cleanText(match[2]) || undefined
            };
        }
    }

    return {};
}

function enrichChunkStructuralMetadata(chunk) {
    var explicitChapterNum = Number.isFinite(Number(chunk && chunk.chapter_num)) ? Number(chunk.chapter_num) : undefined;
    var explicitChapterTitle = cleanText(chunk && chunk.chapter_title);

    if (explicitChapterNum && explicitChapterTitle) {
        return chunk;
    }

    var inferredCandidates = [
        inferChapterAnchorFromValue(chunk && (chunk.section_title || chunk.title)),
        inferChapterAnchorFromValue(chunk && chunk.content),
        inferChapterAnchorFromValue(chunk && chunk.breadcrumb)
    ];
    var inferred = inferredCandidates.find(function(candidate) {
        return candidate.chapter_num || candidate.chapter_title;
    }) || {};

    if (!explicitChapterNum && inferred.chapter_num) {
        chunk = Object.assign({}, chunk, { chapter_num: inferred.chapter_num });
    }
    if (!explicitChapterTitle && inferred.chapter_title) {
        chunk = Object.assign({}, chunk, { chapter_title: inferred.chapter_title });
    }

    return chunk;
}

function buildChunkGroupKey(chunk) {
    return [
        cleanText(chunk && (chunk.book_id || chunk.book_title || chunk.source_file)),
        String(chunk && chunk.chapter_num || ""),
        cleanText(chunk && chunk.chapter_title).toLowerCase()
    ].join("::");
}

function computeChunkUtility(chunk) {
    var score = Number(chunk && chunk.score || 0);
    var text = cleanText(chunk && chunk.content);
    var chapterBonus = Number.isFinite(Number(chunk && chunk.chapter_num)) && Number(chunk.chapter_num) > 0 ? 0.8 : 0;
    var titleBonus = cleanText(chunk && chunk.chapter_title) ? 0.4 : 0;
    var lengthBonus = Math.min(0.8, text.length / 1200);
    var utility = score + chapterBonus + titleBonus + lengthBonus;

    if (text.length < 80) utility -= 0.75;
    if (looksRawGeneratedLabel(chunk && (chunk.section_title || chunk.title))) utility -= 0.45;
    if (isHeadingOnlyChunk(chunk)) utility -= 0.55;
    return utility;
}

function prioritizeSearchChunks(chunks) {
    var list = (Array.isArray(chunks) ? chunks.slice() : []).map(enrichChunkStructuralMetadata);
    var groupStats = {};

    list.forEach(function(chunk) {
        var key = buildChunkGroupKey(chunk);
        if (!groupStats[key]) {
            groupStats[key] = {
                hasSubstantive: false,
                hasCleanSectionTitle: false
            };
        }
        if (hasSubstantiveChunkText(chunk)) {
            groupStats[key].hasSubstantive = true;
        }
        if (!looksRawGeneratedLabel(chunk && (chunk.section_title || chunk.title))) {
            groupStats[key].hasCleanSectionTitle = true;
        }
    });

    return list
        .filter(function(chunk) {
            var stats = groupStats[buildChunkGroupKey(chunk)];
            if (!stats) return true;
            if (stats.hasSubstantive && isHeadingOnlyChunk(chunk)) return false;
            if (stats.hasCleanSectionTitle && looksRawGeneratedLabel(chunk && (chunk.section_title || chunk.title))) {
                return false;
            }
            return true;
        })
        .sort(function(left, right) {
            return computeChunkUtility(right) - computeChunkUtility(left);
        });
}

function formatSearchResponse(query, chunks) {
    var list = prioritizeSearchChunks(chunks);
    return {
        success: true,
        query: query,
        total_chunks: list.length,
        candidates: list.map(function(c) {
            return {
                id: c.id,
                text: c.content,
                breadcrumb: c.breadcrumb || c.source_file,
                score: c.score,
                bookId: c.book_id || "",
                bookTitle: c.book_title || c.source_file || "libro",
                author: c.author || "",
                chapterNum: c.chapter_num || null,
                chapterTitle: c.chapter_title || "",
                sectionTitle: c.section_title || c.title || "",
                sectionSummary: c.section_summary || c.summary || "",
                sourceFile: c.source_file || "",
                byteStart: c.byte_start,
                byteEnd: c.byte_end
            };
        }),
        results: list.map(function(c) {
            return {
                id: c.id,
                title: c.book_title || c.source_file || "libro",
                chapterNum: c.chapter_num || null,
                chapterTitle: c.chapter_title || "",
                sectionTitle: c.section_title || c.title || "",
                breadcrumb: c.breadcrumb || c.source_file,
                summary: c.section_summary || c.summary || c.content,
                content: c.content,
                score: c.score,
                author: c.author || "",
                bookId: c.book_id || ""
            };
        })
    };
}

module.exports = {
    DEFAULT_DOC_INDEX_PATH,
    getDocIndexPath,
    getIndexedFilename,
    prioritizeSearchChunks,
    formatSearchResponse,
    extractSectionRecord,
    readChunkFromRawFile,
    searchRawPhraseChunks
};
