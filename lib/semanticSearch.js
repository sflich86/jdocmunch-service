const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { normalizeSearchText } = require("./textUtils");

let googleGenAIModule = null;
async function getGoogleGenAI() {
    if (!googleGenAIModule) {
        const mod = await import("@google/generative-ai");
        googleGenAIModule = mod.GoogleGenerativeAI;
    }
    return googleGenAIModule;
}

const { callGemini } = require("./geminiCaller");
const { keyManager } = require("./keyManager");
const { getDocIndexPath, readChunkFromRawFile, getIndexedFilename } = require("./searchRuntime");
const { db } = require("./db");
const { buildChapterRanges, enrichChunksWithMetadata } = require("./chunkMetadata");

const DEFAULT_EMBEDDING_PROVIDER = "gemini";
const DEFAULT_GEMINI_EMBEDDING_MODEL = "models/gemini-embedding-001";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_QUERY_TASK = "RETRIEVAL_QUERY";
const DEFAULT_DOCUMENT_TASK = "RETRIEVAL_DOCUMENT";
const DEFAULT_QUERY_MAX_RETRIES = 4;
const DEFAULT_DOCUMENT_MAX_RETRIES = 6;
const DEFAULT_RECOVERY_MAX_RETRIES = 8;
const DEFAULT_EMBED_CHECKPOINT_EVERY = 5;
const DEFAULT_DOCUMENT_BATCH_SIZE = 4;
const DEFAULT_SECTION_EMBED_CHAR_LIMIT = 1800;

function tokenizeSearchText(value) {
    return normalizeSearchText(value)
        .split(/[^a-z0-9]+/i)
        .map(function(token) { return token.trim(); })
        .filter(function(token) { return token.length >= 4; });
}

function extractProperNamePhrases(value) {
    return Array.from(new Set(
        String(value || "")
            .match(/\b[A-ZÁÉÍÓÚÜÑ][\p{L}.'’-]+(?:\s+[A-ZÁÉÍÓÚÜÑ][\p{L}.'’-]+)+/gu) || []
    ))
        .map(function(phrase) { return normalizeSearchText(phrase); })
        .filter(function(phrase) { return phrase.length >= 8; });
}

function getEmbeddingModel(env) {
    var source = env || process.env;
    if (getEmbeddingProvider(source) === "openai") {
        return source.JDOCMUNCH_EMBEDDING_MODEL || source.OPENAI_EMBEDDING_MODEL || DEFAULT_OPENAI_EMBEDDING_MODEL;
    }
    return source.JDOCMUNCH_EMBEDDING_MODEL || source.GEMINI_EMBEDDING_MODEL || DEFAULT_GEMINI_EMBEDDING_MODEL;
}

function getEmbeddingProvider(env) {
    var source = env || process.env;
    var explicit = String(source.JDOCMUNCH_EMBEDDING_PROVIDER || "").trim().toLowerCase();
    if (explicit) return explicit;
    
    // Prioritize Gemini if keys are present (more likely to work on this VPS)
    if (getGeminiEmbeddingKeys(source).length > 0) return "gemini";
    if (getOpenAIEmbeddingKeys(source).length > 0) return "openai";
    
    return DEFAULT_EMBEDDING_PROVIDER;
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

function parsePositiveInteger(value, fallback) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function getEmbeddingKeyCount() {
    return Math.max(1, keyManager.loadKeys("GEMINI_EMBED_KEY").length || 1);
}

function getOpenAIEmbeddingKeys(env) {
    var source = env || process.env;
    var keys = [];
    var seen = {};

    function collect(value) {
        var key = String(value || "").trim();
        if (!key || seen[key]) return;
        seen[key] = true;
        keys.push(key);
    }

    collect(source.OPENAI_EMBED_KEY);
    for (var i = 1; i <= 10; i++) {
        collect(source["OPENAI_EMBED_KEY_" + i]);
    }
    collect(source.OPENAI_API_KEY);

    return keys;
}

function getGeminiEmbeddingKeys(env) {
    var source = env || process.env;
    var keys = [];
    var seen = {};

    function collect(value) {
        var key = String(value || "").trim();
        if (!key || seen[key]) return;
        seen[key] = true;
        keys.push(key);
    }

    collect(source.GEMINI_EMBED_KEY_1);
    collect(source.GEMINI_EMBED_KEY_2);
    collect(source.GEMINI_EMBED_FALLBACK_KEY);
    collect(source.GEMINI_API_KEY);
    collect(source.GOOGLE_API_KEY);

    return keys;
}

function getOpenAIEmbeddingBaseUrl(env) {
    var source = env || process.env;
    return String(source.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function getEmbeddingRetryLimit(taskType, env, options) {
    var source = env || process.env;
    var settings = options || {};
    if (settings.maxRetries != null) {
        return parsePositiveInteger(settings.maxRetries, DEFAULT_DOCUMENT_MAX_RETRIES);
    }

    var keyCount = getEmbeddingProvider(source) === "openai"
        ? Math.max(1, getOpenAIEmbeddingKeys(source).length || 1)
        : getEmbeddingKeyCount();
    if (taskType === DEFAULT_QUERY_TASK) {
        return parsePositiveInteger(
            source.JDOCMUNCH_EMBED_QUERY_MAX_RETRIES,
            Math.max(DEFAULT_QUERY_MAX_RETRIES, keyCount * 2)
        );
    }

    if (settings.mode === "recovery") {
        return parsePositiveInteger(
            source.JDOCMUNCH_EMBED_RECOVERY_MAX_RETRIES,
            Math.max(DEFAULT_RECOVERY_MAX_RETRIES, keyCount * 4)
        );
    }

    return parsePositiveInteger(
        source.JDOCMUNCH_EMBED_DOCUMENT_MAX_RETRIES,
        Math.max(DEFAULT_DOCUMENT_MAX_RETRIES, keyCount * 3)
    );
}

function getEmbedCheckpointEvery(env) {
    var source = env || process.env;
    return parsePositiveInteger(source.JDOCMUNCH_EMBED_CHECKPOINT_EVERY, DEFAULT_EMBED_CHECKPOINT_EVERY);
}

function getDocumentEmbedBatchSize(env, options) {
    var source = env || process.env;
    var settings = options || {};
    if (settings.batchSize != null) {
        return parsePositiveInteger(settings.batchSize, DEFAULT_DOCUMENT_BATCH_SIZE);
    }
    return parsePositiveInteger(source.JDOCMUNCH_EMBED_DOCUMENT_BATCH_SIZE, DEFAULT_DOCUMENT_BATCH_SIZE);
}

function getSectionEmbedCharLimit(env) {
    var source = env || process.env;
    return parsePositiveInteger(source.JDOCMUNCH_EMBED_TEXT_CHAR_LIMIT, DEFAULT_SECTION_EMBED_CHAR_LIMIT);
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

function hasEmbeddingValues(section) {
    return Array.isArray(section && section.embedding) && section.embedding.length > 0;
}

function getSectionEmbeddingProvider(section, indexData) {
    if (section && section.embedding_provider) return String(section.embedding_provider);
    if (indexData && indexData.embedding_provider) return String(indexData.embedding_provider);
    return "";
}

function getSectionEmbeddingModel(section, indexData) {
    if (section && section.embedding_model) return String(section.embedding_model);
    if (indexData && indexData.embedding_model) return String(indexData.embedding_model);
    return "";
}

function shouldReuseSectionEmbedding(section, indexData, expectedModel, expectedProvider) {
    if (!hasEmbeddingValues(section) || !expectedModel) return false;
    var actualProvider = getSectionEmbeddingProvider(section, indexData);
    if (actualProvider && expectedProvider && actualProvider !== expectedProvider) return false;
    return getSectionEmbeddingModel(section, indexData) === String(expectedModel);
}

function writeEmbeddingCheckpoint(userId, indexData, env, targetModel, progress) {
    indexData.embedding_progress = Object.assign(
        {
            target_model: targetModel,
            updated_at: new Date().toISOString()
        },
        progress || {}
    );
    saveUserIndex(userId, indexData, env);
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
    var charLimit = getSectionEmbedCharLimit(env);
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
        parts.push(String(content).slice(0, charLimit));
    }
    return parts.join("\n");
}

async function embedText(text, taskType, title, env, options) {
    var source = env || process.env;
    var settings = options || {};
    if (getEmbeddingProvider(source) === "openai") {
        var openAiVectors = await embedTextBatchOpenAI(
            [{ text: text, title: title }],
            source,
            Object.assign({}, settings, { taskType: taskType })
        );
        return openAiVectors[0] || [];
    }
    return callGemini(async function(apiKey) {
        const GoogleGenerativeAI = await getGoogleGenAI();
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
        maxRetries: getEmbeddingRetryLimit(taskType, source, settings),
        description: settings.description || ("semantic-embed:" + taskType)
    });
}

async function embedTextBatchOpenAI(items, env, options) {
    var source = env || process.env;
    var settings = options || {};
    var requests = Array.isArray(items) ? items.filter(Boolean) : [];
    var apiKeys = getOpenAIEmbeddingKeys(source);
    var endpoint = getOpenAIEmbeddingBaseUrl(source) + "/embeddings";
    var maxRetries = getEmbeddingRetryLimit(settings.taskType || DEFAULT_DOCUMENT_TASK, source, settings);

    if (requests.length === 0) return [];
    if (apiKeys.length === 0) {
        throw new Error("OPENAI_API_KEY no configurada para embeddings");
    }

    for (var attempt = 1; attempt <= maxRetries; attempt++) {
        var apiKey = apiKeys[(attempt - 1) % apiKeys.length];
        try {
            var response = await axios.post(
                endpoint,
                {
                    model: getEmbeddingModel(source),
                    input: requests.length === 1
                        ? String(requests[0].text || "")
                        : requests.map(function(request) {
                            return String(request.text || "");
                        }),
                    encoding_format: "float"
                },
                {
                    headers: {
                        Authorization: "Bearer " + apiKey,
                        "Content-Type": "application/json"
                    },
                    timeout: 60000
                }
            );

            return ((response && response.data && response.data.data) || []).map(function(entry) {
                return normalizeVector((entry && entry.embedding) || []);
            });
        } catch (err) {
            var status = err && err.response && err.response.status;
            if (status === 429 && attempt < maxRetries) {
                var headers = err.response && err.response.headers ? err.response.headers : {};
                var retryAfter = headers["retry-after"] || headers["Retry-After"];
                var retryDelayMs = retryAfter
                    ? parsePositiveInteger(retryAfter, 2) * 1000
                    : Math.min(2000 * Math.pow(2, attempt - 1), 120000);
                console.warn(
                    "[OpenAIEmbed] Rate limit en " + (settings.description || "openai-embed") +
                    ". Intento " + attempt + "/" + maxRetries +
                    ". Esperando " + Math.round(retryDelayMs / 1000) + "s..."
                );
                await new Promise(function(resolve) { setTimeout(resolve, retryDelayMs); });
                continue;
            }

            if (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) {
                err.message = err.response.data.error.message;
            }
            throw err;
        }
    }

    throw new Error("Agotados los reintentos de embeddings OpenAI");
}

async function embedTextBatch(items, taskType, env, options) {
    var source = env || process.env;
    var settings = options || {};
    var requests = Array.isArray(items) ? items.filter(Boolean) : [];

    if (requests.length === 0) return [];
    if (getEmbeddingProvider(source) === "openai") {
        return embedTextBatchOpenAI(requests, source, Object.assign({}, settings, { taskType: taskType }));
    }
    if (requests.length === 1) {
        return [
            await embedText(requests[0].text, taskType, requests[0].title, source, settings)
        ];
    }

    return callGemini(async function(apiKey) {
        const GoogleGenerativeAI = await getGoogleGenAI();
        var genAI = new GoogleGenerativeAI(apiKey);
        var model = genAI.getGenerativeModel({ model: getEmbeddingModel(source) });
        var response = await model.batchEmbedContents({
            requests: requests.map(function(request) {
                return {
                    content: {
                        role: "user",
                        parts: [{ text: String(request.text || "") }]
                    },
                    taskType: taskType,
                    title: request.title || undefined
                };
            })
        });

        return ((response && response.embeddings) || []).map(function(embedding) {
            return normalizeVector((embedding && embedding.values) || []);
        });
    }, {
        tier: "embedding",
        maxRetries: getEmbeddingRetryLimit(taskType, source, settings),
        description: settings.description || ("semantic-batch-embed:" + taskType)
    });
}

async function refreshUserSemanticIndex(userId, options) {
    var settings = options || {};
    var env = settings.env || process.env;
    var booksDir = settings.booksDir || "";
    var docPaths = Array.isArray(settings.docPaths) ? settings.docPaths.filter(Boolean).map(String) : [];
    var docPathSet = docPaths.length ? new Set(docPaths) : null;
    var indexData = loadUserIndex(userId, env);
    if (!indexData || !Array.isArray(indexData.sections) || indexData.sections.length === 0) {
        return { updated: false, sections: 0 };
    }

    indexData = await enrichIndexSections(userId, indexData, booksDir);
    var targetSections = indexData.sections.filter(function(section) {
        if (!docPathSet) return true;
        return docPathSet.has(String(section.doc_path || ""));
    });
    if (targetSections.length === 0) {
        return { updated: false, sections: 0, embedded_sections: 0, reused_sections: 0, skipped_sections: 0 };
    }
    var previousEmbeddingModel = String(indexData.embedding_model || "");
    var previousEmbeddingProvider = String(indexData.embedding_provider || "");
    var hadEmbeddingUpdatedAt = Boolean(indexData.embedding_updated_at);
    var targetProvider = getEmbeddingProvider(env);
    var targetModel = getEmbeddingModel(env);
    var checkpointEvery = getEmbedCheckpointEvery(env);
    var batchSize = getDocumentEmbedBatchSize(env, settings);
    var embeddedCount = 0;
    var reusedCount = 0;
    var skippedCount = 0;
    var progressTouched = false;
    var batchEntries = [];
    var lastCheckpointEmbeddedCount = 0;

    async function flushBatch() {
        if (batchEntries.length === 0) return;
        var currentBatch = batchEntries.slice();
        batchEntries = [];

        try {
            var embeddings = await embedTextBatch(
                currentBatch.map(function(entry) {
                    return {
                        text: entry.text,
                        title: entry.section.title
                    };
                }),
                DEFAULT_DOCUMENT_TASK,
                env,
                {
                    mode: "recovery",
                    description: "semantic-batch-embed:" + DEFAULT_DOCUMENT_TASK,
                    batchSize: batchSize
                }
            );

            if (embeddings.length !== currentBatch.length) {
                throw new Error("cantidad de embeddings devueltos no coincide con el batch solicitado");
            }

            for (var j = 0; j < currentBatch.length; j++) {
                currentBatch[j].section.embedding = embeddings[j];
                currentBatch[j].section.embedding_model = targetModel;
                currentBatch[j].section.embedding_provider = targetProvider;
            }

            embeddedCount += currentBatch.length;
            progressTouched = true;
            if ((embeddedCount - lastCheckpointEmbeddedCount) >= checkpointEvery) {
                lastCheckpointEmbeddedCount = embeddedCount;
                writeEmbeddingCheckpoint(userId, indexData, env, targetModel, {
                    embedded_sections: embeddedCount,
                    reused_sections: reusedCount,
                    skipped_sections: skippedCount,
                    total_sections: targetSections.length
                });
            }
        } catch (err) {
            writeEmbeddingCheckpoint(userId, indexData, env, targetModel, {
                embedded_sections: embeddedCount,
                reused_sections: reusedCount,
                skipped_sections: skippedCount,
                total_sections: targetSections.length,
                failed: true
            });
            err.message = err.message + " (progreso embeddings: " + embeddedCount + " nuevas, " + reusedCount + " reutilizadas, " + skippedCount + " omitidas de " + targetSections.length + ")";
            throw err;
        }
    }

    for (var i = 0; i < targetSections.length; i++) {
        var section = targetSections[i];
        if (shouldReuseSectionEmbedding(section, indexData, targetModel, targetProvider)) {
            reusedCount++;
            if (!section.embedding_model) {
                section.embedding_model = targetModel;
                progressTouched = true;
            }
            if (!section.embedding_provider) {
                section.embedding_provider = targetProvider;
                progressTouched = true;
            }
            continue;
        }

        var embedTextInput = buildSectionEmbedText(section, userId, booksDir, env);
        if (!embedTextInput) {
            skippedCount++;
            continue;
        }
        batchEntries.push({
            section: section,
            text: embedTextInput
        });
        if (batchEntries.length >= batchSize) {
            await flushBatch();
        }
    }

    await flushBatch();

    indexData.embedding_provider = targetProvider;
    indexData.embedding_model = targetModel;
    indexData.embedding_task = DEFAULT_DOCUMENT_TASK;
    indexData.embedding_updated_at = new Date().toISOString();
    delete indexData.embedding_progress;
    var finalStateChanged =
        progressTouched ||
        previousEmbeddingModel !== targetModel ||
        previousEmbeddingProvider !== targetProvider ||
        !hadEmbeddingUpdatedAt;
    if (finalStateChanged) {
        saveUserIndex(userId, indexData, env);
    }

    return {
        updated: finalStateChanged,
        sections: targetSections.length,
        embedded_sections: embeddedCount,
        reused_sections: reusedCount,
        skipped_sections: skippedCount,
        embedding_model: indexData.embedding_model
    };
}

async function collectBookSectionCandidates(userId, bookId, options) {
    var settings = options || {};
    var env = settings.env || process.env;
    var booksDir = settings.booksDir || "";
    var maxSections = Math.max(1, Number(settings.maxSections || 36));
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

    var queryVector = await embedText(query, DEFAULT_QUERY_TASK, null, env, {
        mode: "query",
        description: "semantic-embed:" + DEFAULT_QUERY_TASK
    });
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
    DEFAULT_GEMINI_EMBEDDING_MODEL,
    DEFAULT_OPENAI_EMBEDDING_MODEL,
    collectBookSectionCandidates,
    buildSectionEmbedText,
    getEmbeddingProvider,
    getEmbeddingModel,
    getUserIndexPath,
    refreshUserSemanticIndex,
    searchUserIndex,
    getEmbeddingRetryLimit,
    getSectionEmbedCharLimit,
    shouldReuseSectionEmbedding,
    normalizeVector,
    cosineSimilarity
};
