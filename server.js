// —— LINE 1: ENV MUST LOAD BEFORE ANYTHING ELSE —————————
require("dotenv").config();

var express = require("express");
var cors = require("cors");
var path = require("path");
var fs = require("fs");
var crypto = require("crypto");
var bodyParser = require("body-parser");
var { keyManager } = require("./lib/keyManager");
var { startPipeline } = require("./lib/pipeline");
var { db, tryRestoreTursoConnection } = require("./lib/db");
var { runMigrations } = require("./lib/migrations");
var { callGemini } = require("./lib/geminiCaller");
var { getClient, callTool } = require("./lib/mcpClient");
var { pipelineQueue } = require("./lib/pipelineQueue");
var { getDocIndexPath, getIndexedFilename, formatSearchResponse } = require("./lib/searchRuntime");
var { refreshUserSemanticIndex, searchUserIndex, getEmbeddingModel, getEmbeddingProvider } = require("./lib/semanticSearch");
var { buildChapterRanges, enrichChunksWithMetadata } = require("./lib/chunkMetadata");
var { getChaptersForDocPath, listIndexDocPathsForBook, materializeIndexableDocuments } = require("./lib/indexableDocs");
var { searchStructuralChapterMetadata } = require("./lib/structuralSearch");
var { buildConceptHintPack, rerankChunksWithConceptHints } = require("./lib/conceptHintReranker");

// —— Constants ———————————————————————————————————
var VERSION = "1.0.49";
var PORT = process.env.PORT || 3000;
var BOOKS_DIR = path.join(__dirname, "books");

// —— Express App —————————————————————————————————
var app = express();
app.use(cors());

// Manual JSON body parser - lenient, falls back to query params
app.use(function(req, res, next) {
    if (req.method === 'POST' && req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        var chunks = [];
        req.on('data', function(chunk) { chunks.push(chunk); });
        req.on('end', function() {
            var rawBody = Buffer.concat(chunks).toString('utf8');
            try {
                req.body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
            } catch (e) {
                console.warn("[BodyParse] POST " + req.url + " - JSON parse FAILED, falling back to query params. Length: " + rawBody.length);
                req.body = {};
            }
            next();
        });
        req.on('error', function(err) {
            console.error("[BodyParse] POST " + req.url + " - stream error: " + err.message);
            next();
        });
    } else {
        next();
    }
});

app.use(express.urlencoded({ extended: true, limit: "50mb" }));

var traceLogs = [];
app.use(function(req, res, next) {
    if (req.url.indexOf("__DOT__") !== -1) {
        var oldUrl = req.url;
        req.url = req.url.split("__DOT__").join(".");
        if (req.path.indexOf("__DOT__") !== -1) {
            req.path = req.path.split("__DOT__").join(".");
        }
        console.log("[Shield] Decoded: " + oldUrl + " -> " + req.url);
    }

    var logEntry = {
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress
    };
    traceLogs.push(logEntry);
    if (traceLogs.length > 50) traceLogs.shift();
    
    console.log("[Trace] " + logEntry.timestamp + " | " + logEntry.method + " " + logEntry.url);
    next();
});

app.use(express.static(path.join(__dirname, "public")));

async function checkConnectivity() {
    console.log("[Connectivity] Checking DNS and Outbound connections...");
    const targets = [
        { host: "aws-us-east-1.turso.io", port: 443 },
        { host: "api.openai.com", port: 443 },
        { host: "generativelanguage.googleapis.com", port: 443 }
    ];
    
    for (const target of targets) {
        try {
            const start = Date.now();
            await new Promise((resolve, reject) => {
                const socket = require('net').createConnection(target.port, target.host);
                socket.setTimeout(5000);
                socket.on('connect', () => { socket.end(); resolve(); });
                socket.on('error', reject);
                socket.on('timeout', () => { socket.destroy(); reject(new Error("Timeout")); });
            });
            console.log(`[Connectivity] ${target.host} OK (${Date.now() - start}ms)`);
        } catch (err) {
            console.error(`[Connectivity] ${target.host} FAILED: ${err.message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════

function getUserBooksDir(userId) {
    var id = userId || "default";
    var dir = path.join(BOOKS_DIR, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getUserRepo(userId) {
    var id = userId || "default";
    return "local/" + id;
}

function decodeShieldedId(raw) {
    if (!raw) return null;
    var decoded = decodeURIComponent(raw);
    decoded = decoded.replace(/__DOT__/g, ".");
    return decoded;
}

async function performSearch(q, userId) {
    try {
        var chunks = await searchUserIndex(q, userId, {
            env: process.env,
            booksDir: BOOKS_DIR,
            maxResults: 15
        });
        return { chunks: chunks };
    } catch (err) {
        console.error("Search failed: " + err.message);
        return { chunks: [] };
    }
}

async function resolveAllowedDocPaths(userId, bookIds) {
    var ids = Array.isArray(bookIds) ? bookIds.filter(Boolean).map(String) : [];
    if (ids.length === 0) return [];

    var placeholders = ids.map(function() { return "?"; }).join(", ");
    var args = [String(userId || "default")].concat(ids);
    var result = await db.execute({
        sql: "SELECT filename, id FROM books WHERE user_id = ? AND id IN (" + placeholders + ")",
        args: args
    });

    var userDir = getUserBooksDir(userId);
    return Array.from(new Set(result.rows.flatMap(function(row) {
        return listIndexDocPathsForBook(userDir, row.filename, row.id);
    })));
}

async function getBookMetadataMap(userId, bookIds) {
    var ids = Array.isArray(bookIds) ? bookIds.filter(Boolean).map(String) : [];
    var sql = "SELECT b.id, b.title, b.author, b.filename, b.context_core_json, s.chapters, s.structure_version, s.structure_health_json " +
        "FROM books b " +
        "LEFT JOIN book_structure s ON s.book_id = b.id " +
        "WHERE b.user_id = ?";
    var args = [String(userId || "default")];

    if (ids.length > 0) {
        var placeholders = ids.map(function() { return "?"; }).join(", ");
        sql += " AND b.id IN (" + placeholders + ")";
        args = args.concat(ids);
    }

    var result = await db.execute({ sql: sql, args: args });
    var map = {};
    var userDir = getUserBooksDir(userId);
    for (var i = 0; i < result.rows.length; i++) {
        var row = result.rows[i];
        var chapters = [];

        try {
            chapters = JSON.parse(row.chapters || "[]");
        } catch (err) {
            chapters = [];
        }

        var structureHealth = null;
        try {
            structureHealth = row.structure_health_json ? JSON.parse(row.structure_health_json) : null;
        } catch (err) {
            structureHealth = null;
        }

        var sourceFile = getIndexedFilename(row.filename, row.id);
        var docPaths = listIndexDocPathsForBook(userDir, row.filename, row.id);

        for (var j = 0; j < docPaths.length; j++) {
            var docPath = docPaths[j];
            var filePath = path.join(userDir, docPath);
            var content = "";
            var scopedChapters = getChaptersForDocPath(docPath, chapters);
            var chapterRanges = [];

            if (fs.existsSync(filePath)) {
                content = fs.readFileSync(filePath, "utf8");
            }

            chapterRanges = buildChapterRanges(content, scopedChapters);
            if (!chapterRanges.length && scopedChapters.length === 1 && content) {
                chapterRanges = [{
                    chapter_num: Number(scopedChapters[0].chapter_num || 0),
                    chapter_title: scopedChapters[0].title || "",
                    starts_with: scopedChapters[0].starts_with || "",
                    byte_start: 0,
                    byte_end: Buffer.byteLength(content, "utf8")
                }];
            }

            map[docPath] = {
                book_id: String(row.id),
                book_title: row.title || row.filename || row.id,
                author: row.author || "",
                source_file: sourceFile,
                chapters: scopedChapters,
                chapter_ranges: chapterRanges,
                contextCore: row.context_core_json || null,
                structure_version: row.structure_version || null,
                structure_health: structureHealth
            };
        }
    }
    return map;
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

app.get("/api/jdocmunch/health", function(req, res) {
    res.json({ 
        status: "ok", 
        version: VERSION, 
        mcpConnected: true,
        dbSource: db.source || "unknown",
        embeddingProvider: getEmbeddingProvider(process.env),
        embeddingModel: getEmbeddingModel(process.env),
        tiers: keyManager.getStatus()
    });
});

app.post("/api/jdocmunch/restore-turso", async function(req, res) {
    try {
        const restored = await tryRestoreTursoConnection();
        res.json({ 
            success: restored,
            dbSource: db.source || "unknown",
            message: restored ? "Turso connection restored" : "Failed to restore Turso connection"
        });
    } catch (err) {
        res.status(500).json({ error: err.message, dbSource: db.source || "unknown" });
    }
});

app.get("/api/jdocmunch/status", function(req, res) {
    res.json(pipelineQueue.getStatus());
});

app.get("/api/jdocmunch/jobs/:jobId/logs", async function(req, res) {
    var jobId = req.params.jobId;
    var limit = parseInt(req.query.limit) || 100;
    var offset = parseInt(req.query.offset) || 0;

    try {
        var result = await db.execute({
            sql: "SELECT stream, message, created_at FROM job_logs WHERE job_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
            args: [jobId, limit, offset]
        });
        res.json({ logs: result.rows, total: result.rows.length, offset: offset, limit: limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/jdocmunch/debug/schema", async function(req, res) {
    try {
        var tables = ["books", "enrichment_jobs", "book_raw", "book_dna", "book_structure", "job_logs"];
        var schema = {};
        for (var i = 0; i < tables.length; i++) {
            var table = tables[i];
            var tableInfo = await db.execute("PRAGMA table_info(" + table + ")");
            var sampleData = await db.execute("SELECT * FROM " + table + " LIMIT 1");
            schema[table] = {
                columns: tableInfo.rows,
                sample: sampleData.rows[0] || "EMPTY"
            };
        }
        res.json(schema);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/jdocmunch/jobs/reset-all", async function(req, res) {
    try {
        var result = await db.execute({
            sql: "UPDATE enrichment_jobs SET status = 'PENDING', error_message = NULL WHERE status IN ('FAILED', 'PROCESSING', 'RETRY')",
            args: []
        });
        recoverPendingJobs();
        res.json({ success: true, affected: result.rowsAffected });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/health", function(req, res) {
    res.json({ status: "ok", version: VERSION, notice: "Use /api/jdocmunch/health" });
});

app.get("/debug/logs", function(req, res) {
    var logsHtml = "";
    for (var i = traceLogs.length - 1; i >= 0; i--) {
        var l = traceLogs[i];
        logsHtml += '<div class="entry"><span class="timestamp">[' + l.timestamp + ']</span><span class="method">' + l.method + '</span><span class="url">' + l.url + '</span></div>';
    }
    var html = '<!DOCTYPE html><html><head><title>Logs</title><style>body { font-family: monospace; background: #1a1a1a; color: #00ff00; padding: 20px; } .entry { border-bottom: 1px solid #333; padding: 5px 0; } .method { color: #ff00ff; font-weight: bold; } .url { color: #00ffff; } .timestamp { color: #888; margin-right: 10px; }</style><meta http-equiv="refresh" content="5"></head><body><h1>Live Trace Logs (Last 50)</h1><p>Version: ' + VERSION + '</p><div id="logs">' + logsHtml + '</div></body></html>';
    res.send(html);
});

app.get("/api/jdocmunch/debug/dashboard", async function(req, res) {
    try {
        var html = '<!DOCTYPE html><html><head><title>JDocMunch Debug Dashboard</title>' +
            '<style>body { font-family: Arial, sans-serif; background: #1e1e1e; color: #eee; padding: 20px; } ' +
            'table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px; } ' +
            'th, td { padding: 8px; border: 1px solid #444; text-align: left; } ' +
            'th { background: #333; } ' +
            '.status-ERROR, .status-FAILED { color: #ff5555; } .status-COMPLETE { color: #55ff55; } .status-PENDING { color: #ffff55; }' +
            '</style><meta http-equiv="refresh" content="5"></head><body>' +
            '<h1>JDocMunch Ingestion Dashboard</h1><p>Auto-refreshes every 5s | Version: ' + VERSION + '</p>';

        // Get Books
        var booksRes = await db.execute("SELECT id, title, author, index_status, created_at FROM books ORDER BY created_at DESC LIMIT 10");
        html += '<h2>Recent Books (books)</h2><table><tr><th>ID</th><th>Title</th><th>Author</th><th>Status</th><th>Created</th></tr>';
        for (var i=0; i<booksRes.rows.length; i++) {
            var b = booksRes.rows[i];
            html += '<tr><td>' + b.id + '</td><td>' + b.title + '</td><td>' + b.author + '</td><td class="status-' + b.index_status + '">' + b.index_status + '</td><td>' + b.created_at + '</td></tr>';
        }
        html += '</table>';

        // Get Jobs
        var jobsRes = await db.execute("SELECT book_id, status, current_step, error_message, created_at FROM enrichment_jobs ORDER BY created_at DESC LIMIT 10");
        html += '<h2>Recent Pipelines (enrichment_jobs)</h2><table><tr><th>Book ID</th><th>Status</th><th>Step</th><th>Error</th><th>Created</th></tr>';
        for (var j=0; j<jobsRes.rows.length; j++) {
            var pj = jobsRes.rows[j];
            html += '<tr><td>' + pj.book_id + '</td><td class="status-' + (pj.status || 'PENDING') + '">' + pj.status + '</td><td>' + (pj.current_step || '-') + '</td><td style="color:#ff5555">' + (pj.error_message || '') + '</td><td>' + pj.created_at + '</td></tr>';
        }
        html += '</table>';

        // Get Logs
        var logsRes = await db.execute("SELECT job_id, stream, message, created_at FROM job_logs ORDER BY created_at DESC LIMIT 30");
        html += '<h2>Recent Logs (job_logs - Last 30)</h2><table><tr><th>Job ID</th><th>Stream</th><th>Message</th><th>Time</th></tr>';
        for (var k=0; k<logsRes.rows.length; k++) {
            var l = logsRes.rows[k];
            var displayMsg = l.message ? l.message.substring(0, 150) + (l.message.length > 150 ? '...' : '') : '';
            html += '<tr><td>' + l.job_id + '</td><td>' + l.stream + '</td><td><pre style="margin:0;white-space:pre-wrap;font-family:inherit;">' + displayMsg + '</pre></td><td>' + l.created_at + '</td></tr>';
        }
        html += '</table></body></html>';

        res.send(html);
    } catch (err) {
        res.status(500).send("Dashboard Error: " + err.message);
    }
});

app.get("/books", async function(req, res) {
    try {
        var result = await db.execute({
            sql: "SELECT id, title, author, index_status, created_at FROM books ORDER BY created_at DESC",
            args: []
        });
        res.json({ books: result.rows, total: result.rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/jdocmunch/books", async function(req, res) {
    try {
        var userId = req.query.user_id || "default";
        var result = await db.execute({
            sql: "SELECT b.id, b.title, b.author, b.filename, b.pedagogical_compendium, b.context_core_json, b.index_status, b.created_at, " +
                 "d.central_thesis, d.argumentative_arc, d.key_concepts, s.chapters, s.structure_version, s.structure_health_json " +
                 "FROM books b " +
                 "LEFT JOIN book_dna d ON d.book_id = b.id " +
                 "LEFT JOIN book_structure s ON s.book_id = b.id " +
                 "WHERE b.user_id = ? ORDER BY b.created_at DESC",
            args: [String(userId)]
        });
        res.json({ books: result.rows, total: result.rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/books/:id", async function(req, res) {
    var id = req.params.id;
    try {
        var result = await db.execute({
            sql: "SELECT content FROM book_raw WHERE book_id = ? ORDER BY chunk_index ASC",
            args: [id]
        });
        if (result.rows.length === 0) return res.status(404).json({ error: "Libro no encontrado" });
        res.json({ id: id, content: result.rows.map(r => r.content).join('') });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  DELETE A BOOK
//  — v1.0.41 FIX: Safe req.body and req.query checks
// ═══════════════════════════════════════════════════════════
app.delete(/^\/api\/jdocmunch\/books\/(.+)$/, async function(req, res) {
    var bookId = null;
    var body = req.body || {};
    var userId = body.user_id || req.query.user_id || "admin";

    try {
        var rawParam = req.params[0];
        bookId = decodeShieldedId(rawParam);

        console.log("[DELETE] Raw: " + rawParam + " | Decoded: " + bookId + " (User: " + userId + ")");

        if (!bookId || bookId === "undefined" || bookId === "null") {
            return res.status(400).json({ error: "Invalid book ID", received: rawParam });
        }

        var idStr = String(bookId);

        var tables = [
            { name: "enrichment_jobs", sql: "DELETE FROM enrichment_jobs WHERE book_id = ?" },
            { name: "book_raw", sql: "DELETE FROM book_raw WHERE book_id = ?" },
            { name: "book_dna", sql: "DELETE FROM book_dna WHERE book_id = ?" },
            { name: "book_structure", sql: "DELETE FROM book_structure WHERE book_id = ?" },
            { name: "books", sql: "DELETE FROM books WHERE id = ?" }
        ];

        var resultsHits = {};
        for (var i = 0; i < tables.length; i++) {
            var table = tables[i];
            try {
                var result = await db.execute({ sql: table.sql, args: [idStr] });
                resultsHits[table.name] = result.rowsAffected;
                console.log("[DELETE] Table " + table.name + " affected: " + result.rowsAffected);
            } catch (innerErr) {
                console.error("[DELETE] Error in " + table.name + ": " + innerErr.message);
                resultsHits[table.name] = "ERROR: " + innerErr.message;
            }
        }

        // Cleanup local files
        try {
            var userDir = getUserBooksDir(userId);
            if (fs.existsSync(userDir)) {
              var files = fs.readdirSync(userDir);
              var cleanId = idStr.toLowerCase().replace(/[^a-z0-9]/g, "");
              for (var j = 0; j < files.length; j++) {
                  var f = files[j];
                  var cleanF = f.toLowerCase().replace(/[^a-z0-9]/g, "");
                  if (cleanF.indexOf(cleanId) !== -1 || f.indexOf(idStr) !== -1) {
                      fs.unlinkSync(path.join(userDir, f));
                      console.log("[DELETE] File removed: " + f);
                  }
              }
            }
        } catch (fsErr) {
            console.warn("[DELETE] FS cleanup warning: " + fsErr.message);
        }

        // Vector index cleanup (Non-fatal)
        try {
            await callTool("delete_index", { repo: getUserRepo(userId) });
            console.log("[DELETE] Vector index cleanup OK");
        } catch (e) {
            console.warn("[DELETE] Vector index cleanup non-fatal error: " + e.message);
        }

        res.json({ 
            success: true, 
            deleted: idStr,
            details: resultsHits
        });
    } catch (err) {
        console.error("[DELETE] Fatal:", err);
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

app.delete(/^\/books\/(.+)$/, function(req, res) {
    req.url = "/api/jdocmunch" + req.url;
    app.handle(req, res);
});

// ═══════════════════════════════════════════════════════════
//  ENRICHMENT STATUS
//  — v1.0.41: Advanced fallback to prevent stuck "Pending"
// ═══════════════════════════════════════════════════════════
app.get(/^\/enrichment-status\/(.+)$/, async function(req, res) {
    var rawId = req.params[0];
    var bookId = decodeShieldedId(rawId);

    try {
        console.log("[Status] Polling for: " + bookId + " (Raw: " + rawId + ")");
        
        // Try strict ID search
        var result = await db.execute({
            sql: "SELECT id, status, current_step, error_message FROM enrichment_jobs WHERE book_id = ? ORDER BY created_at DESC LIMIT 1",
            args: [String(bookId)]
        });
        
        // Fail-safe: Try flexible filename search if ID yields nothing
        if (result.rows.length === 0) {
            console.log("[Status] Strict ID failed, trying filename fallback...");
            result = await db.execute({
               sql: "SELECT id, status, current_step, error_message FROM enrichment_jobs WHERE file_name LIKE ? OR book_id LIKE ? ORDER BY created_at DESC LIMIT 1",
               args: ["%" + String(bookId) + "%", "%" + String(bookId) + "%"]
            });
        }

        if (result.rows.length === 0) {
            console.warn("[Status] 404 for " + bookId + ". Returning synthetic FAILED to break frontend loop.");
            try {
                await db.execute({
                    sql: "UPDATE books SET index_status = 'error' WHERE (id = ? OR filename = ?) AND index_status = 'pending'",
                    args: [String(bookId), String(bookId)]
                });
            } catch (healErr) {
                console.error("[Status] Auto-heal failed:", healErr.message);
            }
            return res.status(404).json({ 
                error: "Job not found",
                details: "No enrichment job found for ID or filename containing " + bookId,
                status: "NOT_FOUND" 
            });
        }
        
        res.json(result.rows[0]);
    } catch (err) { 
        console.error("[Status] Error:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

app.get("/ask", async function(req, res) {
    var q = req.query.q;
    var user_id = req.query.user_id;
    if (!q) return res.status(400).json({ error: "Missing parameters" });

    try {
        var sRes = await performSearch(q, user_id);
        var chunks = sRes.chunks;
        var contextText = chunks.length > 0 ? chunks.map(function(c) { return "[" + c.source_file + "]: " + c.content; }).join("\n\n") : "No context.";
        var prompt = "Answer based only on the context.\nContext:\n" + contextText + "\n\nQuestion: " + q;
        
        var answer = await callGemini(async function(apiKey) {
            const mod = await import("@google/generative-ai");
            const GoogleGenerativeAI = mod.GoogleGenerativeAI;
            var gAI = new GoogleGenerativeAI(apiKey);
            var model = gAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
            var gResult = await model.generateContent(prompt);
            return gResult.response.text();
        }, { tier: "batch", description: "ask" });

        res.json({ answer: answer || "No response", context_used: chunks.length + " chunks" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/jdocmunch/search", async function(req, res) {
    var body = req.body || {};
    var q = body.query || req.query.q;
    var user_id = body.user_id || req.query.user_id || "default";
    var book_ids = body.book_ids || [];

    if (!q) return res.status(400).json({ error: "Missing query" });

    try {
        var metadataMap = {};
        var allowedDocPaths = [];
        var dbAvailable = true;

        try {
            metadataMap = await getBookMetadataMap(user_id, book_ids);
        } catch (dbErr) {
            console.warn("[Search] DB metadata unavailable (" + dbErr.message + "), proceeding without enrichment");
            dbAvailable = false;
        }

        if (dbAvailable && Object.keys(metadataMap).length > 0) {
            var structuralChunks = searchStructuralChapterMetadata(q, metadataMap, { bookIds: book_ids });
            if (structuralChunks.length > 0) {
                return res.json(formatSearchResponse(q, structuralChunks));
            }
            try {
                allowedDocPaths = await resolveAllowedDocPaths(user_id, book_ids);
            } catch (dbErr2) {
                console.warn("[Search] resolveAllowedDocPaths failed: " + dbErr2.message);
            }
        }

        var rawChunks = await searchUserIndex(q, user_id, {
            env: process.env,
            booksDir: BOOKS_DIR,
            maxResults: 15,
            docPaths: allowedDocPaths.length > 0 ? allowedDocPaths : undefined
        });

        var chunks = rawChunks;
        if (dbAvailable && Object.keys(metadataMap).length > 0) {
            var conceptHintPack = buildConceptHintPack(q, metadataMap);
            chunks = rerankChunksWithConceptHints(
                q,
                enrichChunksWithMetadata(rawChunks, metadataMap),
                conceptHintPack
            );
        }

        res.json(formatSearchResponse(q, chunks));
    } catch (err) {
        console.error("[Search] Error: " + err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET fallback for search (when POST body is corrupted by proxy)
app.get("/api/jdocmunch/search", async function(req, res) {
    var q = req.query.q;
    var user_id = req.query.user_id || "default";
    var book_ids = req.query.book_ids ? JSON.parse(req.query.book_ids) : [];

    if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });

    try {
        var metadataMap = {};
        var allowedDocPaths = [];
        var dbAvailable = true;

        try {
            metadataMap = await getBookMetadataMap(user_id, book_ids);
        } catch (dbErr) {
            console.warn("[Search] DB metadata unavailable (" + dbErr.message + "), proceeding without enrichment");
            dbAvailable = false;
        }

        if (dbAvailable && Object.keys(metadataMap).length > 0) {
            var structuralChunks = searchStructuralChapterMetadata(q, metadataMap, { bookIds: book_ids });
            if (structuralChunks.length > 0) {
                return res.json(formatSearchResponse(q, structuralChunks));
            }
            try {
                allowedDocPaths = await resolveAllowedDocPaths(user_id, book_ids);
            } catch (dbErr2) {
                console.warn("[Search] resolveAllowedDocPaths failed: " + dbErr2.message);
            }
        }

        var rawChunks = await searchUserIndex(q, user_id, {
            env: process.env,
            booksDir: BOOKS_DIR,
            maxResults: 15,
            docPaths: allowedDocPaths.length > 0 ? allowedDocPaths : undefined
        });

        var chunks = rawChunks;
        if (dbAvailable && Object.keys(metadataMap).length > 0) {
            var conceptHintPack = buildConceptHintPack(q, metadataMap);
            chunks = rerankChunksWithConceptHints(
                q,
                enrichChunksWithMetadata(rawChunks, metadataMap),
                conceptHintPack
            );
        }

        res.json(formatSearchResponse(q, chunks));
    } catch (err) {
        console.error("[Search] Error: " + err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
//  INGEST (Upload a Book)
// ═══════════════════════════════════════════════════════════
app.post("/ingest", async function(req, res) {
    var body = req.body || {};
    var userId = body.user_id || req.query.user_id || "default";
    var filename = body.filename || req.query.filename || "upload-" + Date.now() + ".md";
    var text = body.content || body.text || req.body;

    console.log("[Ingest] Request: " + filename + " (user: " + userId + ")");
    
    if (text && typeof text === "object" && !Buffer.isBuffer(text)) {
        text = JSON.stringify(text);
    }

    var safeUserId = String(userId);
    var safeFilename = String(filename);
    var safeText = String(text || "");

    if (!safeText || safeText.length === 0) return res.status(400).json({ error: "Empty content" });

    var bookId = crypto.randomUUID();
    var jobId = crypto.randomUUID();

    try {
        // Step 1: Books
        await db.execute({
            sql: "INSERT INTO books (id, user_id, title, author, filename, index_status) VALUES (?, ?, ?, ?, ?, ?)",
            args: [
                String(bookId), 
                safeUserId, 
                safeFilename.replace(/\.[^/.]+$/, ""), 
                "Unknown", 
                safeFilename, 
                "pending"
            ]
        });

        // Step 2: Raw (Chunked to respect Turso/libSQL HTTP limits)
        var chunkSize = 50000; // 50k chars per chunk
        var totalChunks = Math.ceil(safeText.length / chunkSize);
        
        for (var i = 0; i < totalChunks; i++) {
            var chunk = safeText.substring(i * chunkSize, (i + 1) * chunkSize);
            await db.execute({
                sql: "INSERT INTO book_raw (id, book_id, content, chunk_index) VALUES (?, ?, ?, ?)",
                args: [crypto.randomUUID(), String(bookId), chunk, i]
            });
        }

        // Step 3: Enrichment Job
        await db.execute({
            sql: "INSERT INTO enrichment_jobs (id, book_id, user_id, file_name, status, job_type) VALUES (?, ?, ?, ?, 'PENDING', 'full')",
            args: [String(jobId), String(bookId), safeUserId, safeFilename]
        });

        startPipeline(userId, bookId, jobId).catch(function(err) {
            console.error("[Ingest] Background pipeline failed for " + bookId + ": " + err.message);
        });
        res.status(200).json({ success: true, bookId: bookId, book_id: bookId, jobId: jobId });

    } catch (err) {
        console.error("[Ingest] Fatal: " + err.message);
        // Rollback: delete the zombie book record if it was inserted
        try {
            await db.execute({ sql: "DELETE FROM books WHERE id = ?", args: [String(bookId)] });
            await db.execute({ sql: "DELETE FROM book_raw WHERE book_id = ?", args: [String(bookId)] });
            console.log("[Ingest] Rollback successful for stranded book " + bookId);
        } catch(rollbackErr) {
            console.error("[Ingest] Rollback failed:", rollbackErr.message);
        }
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// ═══════════════════════════════════════════════════════════
//  GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════════════
app.use(function(err, req, res, next) {
    console.error("[Global Error]", err);
    res.status(500).json({ 
        error: "Internal Error", 
        message: err.message,
        path: req.path,
        stack: err.stack
    });
});

async function recoverPendingJobs() {
    console.log("[JOBS] Recovery start...");
    try {
        var query = "SELECT id, book_id, user_id, status FROM enrichment_jobs WHERE status IN ('PENDING', 'PROCESSING', 'RETRY')";
        var pending = await db.execute(query);
        for (var i = 0; i < pending.rows.length; i++) {
            var job = pending.rows[i];
            startPipeline(job.user_id, job.book_id, job.id).catch(function() {});
        }
    } catch (err) { console.error("[JOBS] Error:", err.message); }
}

async function rebuildPersistedIndexes() {
    console.log("[IndexRecovery] Checking persisted MCP index at " + getDocIndexPath(process.env));

    try {
        var booksRes = await db.execute({
            sql: "SELECT b.id, b.user_id, b.filename, b.index_status, s.chapters, br.content, br.chunk_index " +
                 "FROM books b " +
                 "LEFT JOIN book_structure s ON s.book_id = b.id " +
                 "JOIN book_raw br ON br.book_id = b.id " +
                 "WHERE b.index_status = 'ready' " +
                 "ORDER BY b.user_id ASC, b.id ASC, br.chunk_index ASC",
            args: []
        });

        if (booksRes.rows.length === 0) {
            console.log("[IndexRecovery] No ready books found.");
            return;
        }

        var byBook = {};
        for (var i = 0; i < booksRes.rows.length; i++) {
            var row = booksRes.rows[i];
            var key = String(row.id);
            if (!byBook[key]) {
                byBook[key] = {
                    bookId: key,
                    userId: String(row.user_id || "default"),
                    filename: getIndexedFilename(row.filename, key),
                    chapters: String(row.chapters || "[]"),
                    chunks: []
                };
            }
            byBook[key].chunks.push(String(row.content || ""));
        }

        var usersToIndex = {};
        var userDocPathsToRefresh = {};
        var bookIds = Object.keys(byBook);
        for (var j = 0; j < bookIds.length; j++) {
            var book = byBook[bookIds[j]];
            var userDir = getUserBooksDir(book.userId);
            var chapters = [];
            try {
                chapters = JSON.parse(book.chapters || "[]");
            } catch (_err) {
                chapters = [];
            }
            var docs = materializeIndexableDocuments({
                userDir: userDir,
                bookId: book.bookId,
                filename: book.filename,
                content: book.chunks.join(""),
                chapters: chapters
            });
            usersToIndex[book.userId] = userDir;
            userDocPathsToRefresh[book.userId] = (userDocPathsToRefresh[book.userId] || []).concat(
                docs.map(function(doc) { return doc.docPath; })
            );
            console.log("[IndexRecovery] Rehydrated " + docs.length + " docs for " + book.filename);
        }

        var userIds = Object.keys(usersToIndex);
        for (var k = 0; k < userIds.length; k++) {
            var userId = userIds[k];
            var indexResult = await callTool("index_local", {
                path: usersToIndex[userId],
                use_embeddings: false,
                incremental: false
            });
            var rawText = (indexResult && indexResult.content && indexResult.content[0] && indexResult.content[0].text) || "{}";
            console.log("[IndexRecovery] Indexed local/" + userId + ": " + rawText);
            var semanticResult = await refreshUserSemanticIndex(userId, {
                env: process.env,
                booksDir: BOOKS_DIR,
                docPaths: Array.from(new Set(userDocPathsToRefresh[userId] || []))
            });
            console.log(
                "[IndexRecovery] Re-embedded local/" +
                userId +
                " with " +
                semanticResult.embedding_model +
                " (" +
                semanticResult.sections +
                " sections; " +
                semanticResult.embedded_sections +
                " nuevas; " +
                semanticResult.reused_sections +
                " reutilizadas; " +
                semanticResult.skipped_sections +
                " omitidas)"
            );
        }
    } catch (err) {
        console.error("[IndexRecovery] Error:", err.message);
    }
}

async function initServer() {
    console.log("[Init] Starting VERSION " + VERSION + "...");
    await checkConnectivity();
    try {
        try {
            await runMigrations(db);
        } catch (migErr) {
            console.warn("[Init] DB migrations failed (non-fatal): " + migErr.message);
        }
        try {
            await rebuildPersistedIndexes();
        } catch (idxErr) {
            console.warn("[Init] Index recovery failed (non-fatal): " + idxErr.message);
        }
        try {
            await recoverPendingJobs();
        } catch (jobErr) {
            console.warn("[Init] Job recovery failed (non-fatal): " + jobErr.message);
        }
        app.listen(PORT, function() {
            console.log("JDOCMUNCH listening on port " + PORT);
            console.log("[Init] DB source: " + (db.source || "unknown"));
        });
    } catch (err) {
        console.error("Fatal:", err);
        process.exit(1);
    }
}

initServer();
