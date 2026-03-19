const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const { callGemini } = require("./geminiCaller");
const { keyManager } = require("./keyManager");
const { getDocIndexPath, readChunkFromRawFile } = require("./searchRuntime");

const DEFAULT_EMBEDDING_MODEL = "models/gemini-embedding-2-preview";
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
    getEmbeddingModel,
    getUserIndexPath,
    refreshUserSemanticIndex,
    searchUserIndex,
    normalizeVector,
    cosineSimilarity
};
