const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const { callGemini } = require("./geminiCaller");
const { keyManager } = require("./keyManager");
const { getDocIndexPath, readChunkFromRawFile, getIndexedFilename } = require("./searchRuntime");
const { db } = require("./db");
const { buildChapterRanges, enrichChunksWithMetadata } = require("./chunkMetadata");

const DEFAULT_EMBEDDING_MODEL = "models/gemini-embedding-001";
const DEFAULT_QUERY_TASK = "RETRIEVAL_QUERY";
const DEFAULT_DOCUMENT_TASK = "RETRIEVAL_DOCUMENT";

function getEmbeddingModel(env) {
    var source = env || process.env;
    return source.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

function getUserIndexPath(userId, env) {
    return path.join(getDocIndexPath(env), "local", String(userId || "default") + ".json");
}

function normalizeVector(values) {
    var vector = Array.isArray(values) ? values : [];
    var norm = Math.sqrt(vector.reduce(function(sum, value) {
        return sum + (value * value);
    }, 0));
    if (!norm) return vector;
    return vector.map(function(value) {
        return value / norm;
    });
}

function cosineSimilarity(a, b) {
    var left = Array.isArray(a) ? a : [];
    var right = Array.isArray(b) ? b : [];
    if (!left.length || !right.length || left.length !== right.length) return 0;

    var dot = 0;
    for (var i = 0; i < left.length; i++) {
        dot += left[i] * right[i];
    }
    return dot;
}

function loadUserIndex(userId, env) {
    var indexPath = getUserIndexPath(userId, env);
    if (!fs.existsSync(indexPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(indexPath, "utf8"));
    } catch (err) {
        return null;
    }
}

function saveUserIndex(userId, data, env) {
    var indexPath = getUserIndexPath(userId, env);
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf8");
}

async function getBookMetadataMap(userId, booksDir) {
    var result = await db.execute({
        sql: "SELECT b.id, b.title, b.author, b.filename, s.chapters FROM books b LEFT JOIN book_structure s ON s.book_id = b.id WHERE b.user_id = ?",
        args: [String(userId || "default")]
    });

    var map = {};
    for (var i = 0; i < result.rows.length; i++) {
        var row = result.rows[i];
        var docPath = getIndexedFilename(row.filename, row.id);
        if (!docPath) continue;

        var filePath = path.join(booksDir, String(userId || "default"), docPath);
        var content = "";
        if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, "utf8");
        }

        var chapters = [];
        try {
            chapters = JSON.parse(row.chapters || "[]");
        } catch (_err) {
            chapters = [];
        }

        map[docPath] = {
            book_id: String(row.id || ""),
            book_title: row.title || row.filename || row.id || "Libro",
            author: row.author || "",
            source_file: docPath,
            chapters: chapters,
            chapter_ranges: buildChapterRanges(content, chapters)
        };
    }
    return map;
}

async function enrichIndexSections(userId, indexData, booksDir) {
    if (!indexData || !Array.isArray(indexData.sections) || !indexData.sections.length) {
        return indexData;
    }

    var metadataMap = await getBookMetadataMap(userId, booksDir);
    indexData.sections = enrichChunksWithMetadata(indexData.sections, metadataMap).map(function(section) {
        return Object.assign({}, section, {
            book_id: section.book_id || "",
            book_title: section.book_title || "",
            author: section.author || "",
            chapter_num: section.chapter_num || null,
            chapter_title: section.chapter_title || "",
            section_title: section.section_title || section.title || "",
            section_summary: section.section_summary || section.summary || "",
            breadcrumb: section.breadcrumb || ""
        });
    });

    return indexData;
}

function buildSectionEmbedText(section, userId, booksDir, env) {
    var sec = section || {};
    var parts = [];
    if (sec.title) parts.push(String(sec.title));
    if (sec.summary && sec.summary !== sec.title) parts.push(String(sec.summary));

    var content = sec.content || readChunkFromRawFile({
        userId: userId,
        env: env,
        booksDir: booksDir,
        docPath: sec.doc_path,
        byteStart: sec.byte_start,
        byteEnd: sec.byte_end
    });

    if (content) {
        parts.push(String(content).slice(0, 4000));
    }
    return parts.join("\n");
}

async function embedText(text, taskType, title, env) {
    var source = env || process.env;
    return callGemini(async function(apiKey) {
        var genAI = new GoogleGenerativeAI(apiKey);
        var model = genAI.getGenerativeModel({ model: getEmbeddingModel(source) });
        var response = await model.embedContent({
            content: {
                role: "user",
                parts: [{ text: String(text || "") }]
            },
            taskType: taskType,
            title: title || undefined
        });

        return normalizeVector((response && response.embedding && response.embedding.values) || []);
    }, {
        tier: "embedding",
        maxRetries: Math.max(3, keyManager.loadKeys("GEMINI_EMBED_KEY").length * 2 || 3),
        description: "semantic-embed:" + taskType
    });
}

async function refreshUserSemanticIndex(userId, options) {
    var settings = options || {};
    var env = settings.env || process.env;
    var booksDir = settings.booksDir || "";
    var indexData = loadUserIndex(userId, env);
    if (!indexData || !Array.isArray(indexData.sections) || indexData.sections.length === 0) {
        return { updated: false, sections: 0 };
    }

    indexData = await enrichIndexSections(userId, indexData, booksDir);

    for (var i = 0; i < indexData.sections.length; i++) {
        var section = indexData.sections[i];
        var embedTextInput = buildSectionEmbedText(section, userId, booksDir, env);
        if (!embedTextInput) continue;
        section.embedding = await embedText(embedTextInput, DEFAULT_DOCUMENT_TASK, section.title, env);
    }

    indexData.embedding_model = getEmbeddingModel(env);
    indexData.embedding_task = DEFAULT_DOCUMENT_TASK;
    indexData.embedding_updated_at = new Date().toISOString();
    saveUserIndex(userId, indexData, env);

    return {
        updated: true,
        sections: indexData.sections.length,
        embedding_model: indexData.embedding_model
    };
}

async function collectBookSectionCandidates(userId, bookId, options) {
    var settings = options || {};
    var env = settings.env || process.env;
    var booksDir = settings.booksDir || "";
    var maxSections = Math.max(1, Number(settings.maxSections || 12));
    var indexData = loadUserIndex(userId, env);

    if (!indexData || !Array.isArray(indexData.sections) || indexData.sections.length === 0) {
        return [];
    }

    indexData = await enrichIndexSections(userId, indexData, booksDir);
    var targetBookId = String(bookId || "");
    var seen = {};
    var sections = [];

    for (var i = 0; i < indexData.sections.length; i++) {
        var section = indexData.sections[i];
        if (String(section.book_id || "") !== targetBookId) continue;
        var sectionTitle = String(section.section_title || section.title || "").trim();
        var chapterTitle = String(section.chapter_title || "").trim();
        var key = [
            String(section.chapter_num || ""),
            chapterTitle.toLowerCase(),
            sectionTitle.toLowerCase(),
            String(section.byte_start || "")
        ].join("::");
        if (seen[key]) continue;
        seen[key] = true;
        sections.push({
            id: String(section.id || ""),
            chapter_num: section.chapter_num || null,
            chapter_title: chapterTitle,
            section_title: sectionTitle || chapterTitle || "Seccion",
            section_summary: String(section.section_summary || section.summary || "").trim(),
            breadcrumb: String(section.breadcrumb || "").trim(),
            byte_start: section.byte_start,
            byte_end: section.byte_end
        });
        if (sections.length >= maxSections) break;
    }

    return sections;
}

async function searchUserIndex(query, userId, options) {
    var settings = options || {};
    var env = settings.env || process.env;
    var booksDir = settings.booksDir || "";
    var maxResults = Number(settings.maxResults || 10);
    var docPaths = Array.isArray(settings.docPaths) ? settings.docPaths.filter(Boolean) : [];
    var docPathSet = docPaths.length ? new Set(docPaths.map(String)) : null;
    var indexData = loadUserIndex(userId, env);

    if (!indexData || !Array.isArray(indexData.sections) || indexData.sections.length === 0) {
        return [];
    }

    var queryVector = await embedText(query, DEFAULT_QUERY_TASK, null, env);
    if (!queryVector || !queryVector.length) return [];

    var ranked = [];
    for (var i = 0; i < indexData.sections.length; i++) {
        var section = indexData.sections[i];
        if (docPathSet && !docPathSet.has(String(section.doc_path || ""))) continue;

        var sectionEmbedding = Array.isArray(section.embedding) ? section.embedding : [];
        if (!sectionEmbedding.length) continue;

        var score = cosineSimilarity(queryVector, sectionEmbedding);
        if (!score) continue;

        var content = readChunkFromRawFile({
            userId: userId,
            env: env,
            booksDir: booksDir,
            docPath: section.doc_path,
            byteStart: section.byte_start,
            byteEnd: section.byte_end
        }) || section.content || "";

        ranked.push({
            id: section.id,
            score: score,
            source_file: section.doc_path || "libro",
            content: content,
            doc_path: section.doc_path,
            title: section.title || "",
            summary: section.summary || "",
            book_id: section.book_id || "",
            book_title: section.book_title || "",
            author: section.author || "",
            chapter_num: section.chapter_num || null,
            chapter_title: section.chapter_title || "",
            section_title: section.section_title || section.title || "",
            section_summary: section.section_summary || section.summary || "",
            breadcrumb: section.breadcrumb || "",
            byte_start: section.byte_start,
            byte_end: section.byte_end
        });
    }

    ranked.sort(function(a, b) {
        return b.score - a.score;
    });

    return ranked.slice(0, maxResults);
}

module.exports = {
    DEFAULT_EMBEDDING_MODEL,
    collectBookSectionCandidates,
    getEmbeddingModel,
    getUserIndexPath,
    refreshUserSemanticIndex,
    searchUserIndex,
    normalizeVector,
    cosineSimilarity
};
