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
const DEFAULT_QUERY_MAX_RETRIES = 4;
const DEFAULT_DOCUMENT_MAX_RETRIES = 6;
const DEFAULT_RECOVERY_MAX_RETRIES = 8;
const DEFAULT_EMBED_CHECKPOINT_EVERY = 5;
const DEFAULT_DOCUMENT_BATCH_SIZE = 8;

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

function parsePositiveInteger(value, fallback) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function getEmbeddingKeyCount() {
    return Math.max(1, keyManager.loadKeys("GEMINI_EMBED_KEY").length || 1);
}

function getEmbeddingRetryLimit(taskType, env, options) {
    var source = env || process.env;
    var settings = options || {};
    if (settings.maxRetries != null) {
        return parsePositiveInteger(settings.maxRetries, DEFAULT_DOCUMENT_MAX_RETRIES);
    }

    var keyCount = getEmbeddingKeyCount();
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

function getSectionEmbeddingModel(section, indexData) {
    if (section && section.embedding_model) return String(section.embedding_model);
    if (indexData && indexData.embedding_model) return String(indexData.embedding_model);
    return "";
}

function shouldReuseSectionEmbedding(section, indexData, expectedModel) {
    if (!hasEmbeddingValues(section) || !expectedModel) return false;
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

async function embedText(text, taskType, title, env, options) {
    var source = env || process.env;
    var settings = options || {};
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
        maxRetries: getEmbeddingRetryLimit(taskType, source, settings),
        description: settings.description || ("semantic-embed:" + taskType)
    });
}

async function embedTextBatch(items, taskType, env, options) {
    var source = env || process.env;
    var settings = options || {};
    var requests = Array.isArray(items) ? items.filter(Boolean) : [];

    if (requests.length === 0) return [];
    if (requests.length === 1) {
        return [
            await embedText(requests[0].text, taskType, requests[0].title, source, settings)
        ];
    }

    return callGemini(async function(apiKey) {
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
    var hadEmbeddingUpdatedAt = Boolean(indexData.embedding_updated_at);
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
        if (shouldReuseSectionEmbedding(section, indexData, targetModel)) {
            reusedCount++;
            if (!section.embedding_model) {
                section.embedding_model = targetModel;
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

    indexData.embedding_model = targetModel;
    indexData.embedding_task = DEFAULT_DOCUMENT_TASK;
    indexData.embedding_updated_at = new Date().toISOString();
    delete indexData.embedding_progress;
    var finalStateChanged = progressTouched || previousEmbeddingModel !== targetModel || !hadEmbeddingUpdatedAt;
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
    DEFAULT_EMBEDDING_MODEL,
    collectBookSectionCandidates,
    getEmbeddingModel,
    getUserIndexPath,
    refreshUserSemanticIndex,
    searchUserIndex,
    getEmbeddingRetryLimit,
    shouldReuseSectionEmbedding,
    normalizeVector,
    cosineSimilarity
};
