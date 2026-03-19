const fs = require("fs");
const path = require("path");

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

function formatSearchResponse(query, chunks) {
    var list = Array.isArray(chunks) ? chunks : [];
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
                sectionTitle: c.title || "",
                sectionSummary: c.summary || "",
                sourceFile: c.source_file || "",
                byteStart: c.byte_start,
                byteEnd: c.byte_end
            };
        }),
        results: list.map(function(c) {
            return {
                id: c.id,
                title: c.book_title || c.source_file || "libro",
                sectionTitle: c.title || "",
                breadcrumb: c.breadcrumb || c.source_file,
                summary: c.content,
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
    formatSearchResponse,
    extractSectionRecord,
    readChunkFromRawFile
};
