const { normalizeLineEndings } = require("./textUtils");

function normalizeText(value) {
    return normalizeLineEndings(value);
}

function normalizeChapters(chapters) {
    return Array.isArray(chapters)
        ? chapters.filter(function(chapter) {
            return chapter && typeof chapter === "object";
        })
        : [];
}

function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function charIndexToByteOffset(content, charIndex) {
    if (!Number.isFinite(charIndex) || charIndex < 0) return -1;
    return Buffer.byteLength(String(content || "").slice(0, charIndex), "utf8");
}

function findRegexByteStart(content, regex, lastStart) {
    if (!(regex instanceof RegExp)) return -1;
    var text = normalizeText(content);
    var minStart = Number.isFinite(lastStart) ? lastStart : 0;
    var match;
    while ((match = regex.exec(text)) !== null) {
        var matchText = String(match[0] || "");
        var anchorOffset = matchText.search(/\S/);
        if (anchorOffset === -1) {
            if (regex.lastIndex === match.index) {
                regex.lastIndex += 1;
            }
            continue;
        }
        var charIndex = match.index + anchorOffset;
        var byteIndex = charIndexToByteOffset(text, charIndex);
        if (byteIndex >= minStart) {
            return byteIndex;
        }
        if (regex.lastIndex === match.index) {
            regex.lastIndex += 1;
        }
    }
    return -1;
}

function findExplicitChapterHeadingByteStart(content, chapter, lastStart) {
    var chapterNumber = Number(chapter && chapter.chapter_num);
    if (!Number.isFinite(chapterNumber)) return -1;

    var chapterTitle = normalizeText(chapter && chapter.title).trim();
    if (chapterTitle) {
        var chapterHeadingWithTitle = new RegExp(
            "(^|\\n)\\s*(?:#{1,6}\\s*)?(?:chapter|cap[ií]tulo)\\s+" +
            String(chapterNumber) +
            "\\b[\\s\\S]{0,160}?\\n\\s*(?:#{1,6}\\s*)?" +
            escapeRegExp(chapterTitle) +
            "\\s*(?:\\n|$)",
            "gi"
        );
        var titledStart = findRegexByteStart(content, chapterHeadingWithTitle, lastStart);
        if (titledStart !== -1) return titledStart;
    }

    var chapterHeadingOnly = new RegExp(
        "(^|\\n)\\s*(?:#{1,6}\\s*)?(?:chapter|cap[ií]tulo)\\s+" + String(chapterNumber) + "\\b",
        "gi"
    );
    return findRegexByteStart(content, chapterHeadingOnly, lastStart);
}

function buildChapterRanges(content, chapters) {
    var normalizedContent = normalizeText(content);
    var contentBuffer = Buffer.from(normalizedContent, "utf8");
    var normalizedChapters = normalizeChapters(chapters);
    var ranges = [];
    var lastStart = 0;

    for (var i = 0; i < normalizedChapters.length; i++) {
        var chapter = normalizedChapters[i];
        var marker = normalizeText(chapter.starts_with);
        var markerAdvance = 1;
        var byteStart = findExplicitChapterHeadingByteStart(normalizedContent, chapter, lastStart);
        if (byteStart === -1 && marker) {
            var markerBuffer = Buffer.from(marker, "utf8");
            byteStart = contentBuffer.indexOf(markerBuffer, lastStart);
            if (byteStart === -1) {
                byteStart = contentBuffer.indexOf(markerBuffer);
            }
            if (byteStart !== -1) {
                markerAdvance = Math.max(markerBuffer.length, 1);
            }
        }
        if (byteStart === -1) continue;

        ranges.push({
            chapter_num: Number(chapter.chapter_num || i + 1),
            chapter_title: chapter.title || "Capitulo " + String(i + 1),
            starts_with: chapter.starts_with || "",
            byte_start: byteStart,
            byte_end: contentBuffer.length
        });
        lastStart = byteStart + markerAdvance;
    }

    for (var j = 0; j < ranges.length; j++) {
        if (j < ranges.length - 1) {
            ranges[j].byte_end = ranges[j + 1].byte_start;
        }
    }

    return ranges;
}

function buildStructuredMarkdownFromChapters(content, chapters) {
    var normalizedContent = normalizeText(content);
    var contentBuffer = Buffer.from(normalizedContent, "utf8");
    var ranges = buildChapterRanges(normalizedContent, chapters);

    if (!ranges.length) {
        return normalizedContent;
    }

    var parts = [];
    var intro = contentBuffer.subarray(0, ranges[0].byte_start).toString("utf8").trim();
    if (intro) {
        parts.push("# Material inicial\n\n" + intro);
    }

    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var chapterBody = contentBuffer.subarray(range.byte_start, range.byte_end).toString("utf8").trim();
        if (!chapterBody) continue;

        var heading = "# " + String(range.chapter_num || (i + 1)) + ". " + String(range.chapter_title || ("Capitulo " + String(i + 1)));
        parts.push(heading + "\n\n" + chapterBody);
    }

    return parts.join("\n\n");
}

function findChapterForChunk(chunk, metadata) {
    var byteStart = Number.isFinite(chunk && chunk.byte_start) ? chunk.byte_start : -1;
    var ranges = Array.isArray(metadata && metadata.chapter_ranges) ? metadata.chapter_ranges : [];

    if (byteStart >= 0) {
        for (var i = 0; i < ranges.length; i++) {
            var range = ranges[i];
            if (byteStart >= range.byte_start && byteStart < range.byte_end) {
                return range;
            }
        }
    }

    var content = normalizeText(chunk && chunk.content);
    var chapters = normalizeChapters(metadata && metadata.chapters);
    for (var j = 0; j < chapters.length; j++) {
        var chapter = chapters[j];
        var marker = normalizeText(chapter.starts_with);
        if (marker && content.indexOf(marker) !== -1) {
            return {
                chapter_num: Number(chapter.chapter_num || j + 1),
                chapter_title: chapter.title || "Capitulo " + String(j + 1)
            };
        }
    }

    return null;
}

function buildChunkBreadcrumb(chunk, metadata, chapter) {
    var parts = [];
    if (metadata && metadata.book_title) parts.push(String(metadata.book_title));
    if (chapter && chapter.chapter_num) {
        parts.push("Capitulo " + String(chapter.chapter_num));
    }
    if (chapter && chapter.chapter_title) {
        parts.push(String(chapter.chapter_title));
    }

    var sectionTitle = chunk && (chunk.section_title || chunk.title);
    if (sectionTitle) {
        parts.push(String(sectionTitle));
    } else if (metadata && metadata.source_file) {
        parts.push(String(metadata.source_file));
    }

    return parts.join(" > ");
}

function enrichChunksWithMetadata(chunks, metadataMap) {
    var list = Array.isArray(chunks) ? chunks : [];
    var map = metadataMap || {};

    return list.map(function(chunk) {
        var metadata = map[String(chunk.doc_path || chunk.source_file || "")] || {};
        var chapter = findChapterForChunk(chunk, metadata);
        var enriched = Object.assign({}, chunk);

        enriched.source_file = metadata.source_file || chunk.source_file || chunk.doc_path || "libro";
        enriched.book_id = metadata.book_id || chunk.book_id || "";
        enriched.book_title = metadata.book_title || chunk.book_title || enriched.source_file;
        enriched.author = metadata.author || chunk.author || "";
        enriched.section_title = chunk.section_title || chunk.title || "";
        enriched.section_summary = chunk.section_summary || chunk.summary || "";
        enriched.chapter_num = chunk.chapter_num || (chapter && chapter.chapter_num) || null;
        enriched.chapter_title = chunk.chapter_title || (chapter && chapter.chapter_title) || "";
        enriched.breadcrumb = chunk.breadcrumb || buildChunkBreadcrumb(enriched, metadata, chapter);

        return enriched;
    });
}

module.exports = {
    buildChapterRanges,
    buildStructuredMarkdownFromChapters,
    buildChunkBreadcrumb,
    enrichChunksWithMetadata
};
