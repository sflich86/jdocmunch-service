require('dotenv').config();
const express = require('express');
console.log("----------------------------------------------------------------");
console.log("🚀 JDOCMUNCH STARTING - VERSION: 1.0.36-deep-observability");
console.log("----------------------------------------------------------------");
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bodyParser = require("body-parser");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Modular Imports
const { keyManager } = require("./lib/keyManager");
const { startPipeline } = require("./lib/pipeline");
const { db } = require("./lib/db");
const { runMigrations } = require("./lib/migrations");
const { callGemini } = require("./lib/geminiCaller");
const { getClient, callTool } = require("./lib/mcpClient");
const { pipelineQueue } = require("./lib/pipelineQueue");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.text({ type: 'text/*', limit: '50mb' }));

// Trace Logging & Double Shield Decoding Middleware
const traceLogs = [];
app.use((req, res, next) => {
    // [Double Shield] Decodificación manual de IDs con puntos
    if (req.url.includes('__DOT__')) {
        const oldUrl = req.url;
        req.url = req.url.split('__DOT__').join('.');
        if (req.path.includes('__DOT__')) {
            req.path = req.path.split('__DOT__').join('.');
        }
        console.log(`[Shield] 🛡️ Decoded: ${oldUrl} -> ${req.url}`);
    }

    const logEntry = {
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    };
    traceLogs.push(logEntry);
    if (traceLogs.length > 50) traceLogs.shift();
    
    console.log(`[Trace] 📡 ${logEntry.timestamp} | ${logEntry.method} ${logEntry.url}`);
    next();
});

const PORT = process.env.PORT || 3000;
const BOOKS_DIR = path.join(__dirname, 'books');

app.use(express.static(path.join(__dirname, 'public')));

// Utils
function getUserBooksDir(userId) {
    const id = userId || 'default';
    const dir = path.join(BOOKS_DIR, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getUserRepo(userId) {
    const id = userId || 'default';
    return `local/${id}`;
}

async function performSearch(q, userId) {
    const userRepo = getUserRepo(userId);
    try {
        const result = await callTool("search_sections", { 
            repo: userRepo, 
            query: q, 
            max_results: 15, 
            min_score: 0.1 
        });
        const data = JSON.parse(result.content[0].text);

        let chunks = [];
        if (data.results) {
            for (const r of data.results) {
                try {
                    const sec = await callTool("get_section", { repo: userRepo, section_id: r.id });
                    const sData = JSON.parse(sec.content[0].text);
                    const sectionId = sData.id || r.id;
                    
                    chunks.push({
                        id: sectionId,
                        content: sData.content,
                        source_file: sData.source_file || 'libro',
                        score: r.score
                    });
                } catch (e) {}
            }
        }
        return { chunks };
    } catch (err) {
        console.error("Search failed:", err.message);
        return { chunks: [] };
    }
}

// Public API Endpoints
app.get('/api/jdocmunch/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '1.0.36-deep-observability', 
        mcpConnected: true,
        tiers: keyManager.getStatus()
    });
});

app.get('/api/jdocmunch/status', (req, res) => {
    res.json(pipelineQueue.getStatus());
});

app.get('/api/jdocmunch/jobs/:jobId/logs', async (req, res) => {
    const { jobId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    try {
        const result = await db.execute({
            sql: "SELECT stream, message, created_at FROM job_logs WHERE job_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
            args: [jobId, limit, offset]
        });
        res.json({ logs: result.rows, total: result.rows.length, offset, limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Diagnostic Route (Ultra Hardened v1.0.36)
app.get('/api/jdocmunch/debug/schema', async (req, res) => {
    try {
        const tables = ['books', 'enrichment_jobs', 'book_raw', 'book_dna', 'book_structure', 'job_logs'];
        const schema = {};
        for (const table of tables) {
            const tableInfo = await db.execute(`PRAGMA table_info(${table})`);
            const sampleData = await db.execute(`SELECT * FROM ${table} LIMIT 1`);
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

// Job Recovery Route
app.post('/api/jdocmunch/jobs/reset-all', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "UPDATE enrichment_jobs SET status = 'PENDING', error_message = NULL WHERE status IN ('FAILED', 'PROCESSING', 'RETRY')",
            args: []
        });
        recoverPendingJobs(); // Trigger immediate start
        res.json({ success: true, affected: result.rowsAffected });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Alias for legacy health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.36-deep-observability', notice: 'Use /api/jdocmunch/health' });
});

app.get('/debug/logs', (req, res) => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Microservice Trace Logs</title>
            <style>
                body { font-family: monospace; background: #1a1a1a; color: #00ff00; padding: 20px; }
                .entry { border-bottom: 1px solid #333; padding: 5px 0; }
                .method { color: #ff00ff; font-weight: bold; }
                .url { color: #00ffff; }
                .timestamp { color: #888; margin-right: 10px; }
            </style>
            <meta http-equiv="refresh" content="5">
        </head>
        <body>
            <h1>📡 Live Trace Logs (Last 50)</h1>
            <p>Version: 1.0.36-deep-observability | Refrescando cada 5 segundos...</p>
            <div id="logs">
                \${traceLogs.slice().reverse().map(l => \`
                    <div class="entry">
                        <span class="timestamp">[\${l.timestamp}]</span>
                        <span class="method">\${l.method}</span>
                        <span class="url">\${l.url}</span>
                    </div>
                \`).join('')}
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

app.get('/books', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT id, title, author, index_status, created_at FROM books ORDER BY created_at DESC",
            args: []
        });
        res.json({ books: result.rows, total: result.rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/books/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.execute({
            sql: "SELECT content FROM book_raw WHERE book_id = ?",
            args: [id]
        });
        if (result.rows.length === 0) return res.status(404).json({ error: "Libro no encontrado" });
        res.json({ id, content: result.rows[0].content });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete(/^\/api\/jdocmunch\/books\/(.+)$/, async (req, res) => {
    let id = req.params[0];
    const userId = req.body.user_id || req.query.user_id || 'admin';
    
    if (id.includes('?')) id = id.split('?')[0];
    id = id.replace(/__DOT__/g, '.');

    console.log(\`[Server] ðŸ—‘ï¸ Intentando eliminar libro con ID: \${id} (Usuario: \${userId})\`);
    
    try {
        // 1. Fase DB - Statement level logging
        const tables = [
            { name: 'enrichment_jobs', sql: "DELETE FROM enrichment_jobs WHERE book_id = ? OR file_name LIKE ?" },
            { name: 'book_raw', sql: "DELETE FROM book_raw WHERE book_id = ?" },
            { name: 'book_dna', sql: "DELETE FROM book_dna WHERE book_id = ?" },
            { name: 'book_structure', sql: "DELETE FROM book_structure WHERE book_id = ?" },
            { name: 'books', sql: "DELETE FROM books WHERE id = ? OR title = ? OR id LIKE ?" }
        ];

        let dbResultsRowAffected = {};
        for (const table of tables) {
            try {
                const args = table.name === 'books' 
                    ? [String(id), id.replace(/_/g, " "), \`%\${id.replace(/\\./g, '_')}%\`]
                    : (table.name === 'enrichment_jobs' ? [String(id), \`%\${id}%\`] : [String(id)]);
                
                const result = await db.execute({ sql: table.sql, args });
                dbResultsRowAffected[table.name] = result.rowsAffected;
                console.log(\`[Server][DELETE] Table \${table.name} affected: \${result.rowsAffected}\`);
            } catch (innerErr) {
                console.error(\`[Server][DELETE] âŒ Error en tabla \${table.name}:\`, innerErr.message);
                dbResultsRowAffected[table.name] = \`ERROR: \${innerErr.message}\`;
            }
        }

        // 2. Eliminar del sistema de archivos
        const userDir = getUserBooksDir(userId);
        let fileDeleted = false;
        try {
            if (fs.existsSync(userDir)) {
              const files = fs.readdirSync(userDir);
              const cleanId = id.toLowerCase().replace(/[^a-z0-9]/g, '');
              const targetFile = files.find(f => {
                  const cleanF = f.toLowerCase().replace(/[^a-z0-9]/g, '');
                  return cleanF.includes(cleanId) || f.includes(id);
              });

              if (targetFile) {
                  const fullPath = path.join(userDir, targetFile);
                  fs.unlinkSync(fullPath);
                  fileDeleted = true;
                  console.log(\`[Server] Archivo eliminado: \${targetFile}\`);
              }
            }
        } catch (fsErr) {
            console.warn(\`[Server] FS Delete warning:\`, fsErr.message);
        }

        // 3. Notificar a MCP
        try {
            await callTool("delete_index", { repo: getUserRepo(userId) }).catch(() => {});
        } catch (e) {}

        res.json({ 
            success: true, 
            message: \`Libro \${id} procesado para eliminaciÃ³n.\`,
            db_affected: dbResultsRowAffected,
            file_deleted: fileDeleted
        });
    } catch (err) {
        console.error("Delete fatal:", err);
        res.status(500).json({ error: err.message });
    }
});

app.delete(/^\/books\/(.+)$/, async (req, res) => {
    req.url = '/api/jdocmunch' + req.url;
    app.handle(req, res);
});

app.get(/^\/enrichment-status\/(.+)$/, async (req, res) => {
    let bookId = req.params[0];
    if (bookId.includes('?')) bookId = bookId.split('?')[0];
    bookId = bookId.replace(/__DOT__/g, '.');

    try {
        const searchPattern = \`%\${bookId.replace(/_/g, '%')}%\`;
        const result = await db.execute({
            sql: "SELECT id, status, current_step, error_message FROM enrichment_jobs WHERE book_id = ? OR file_name LIKE ? OR file_name LIKE ? ORDER BY created_at DESC LIMIT 1",
            args: [bookId, \`%\${bookId}%\`, searchPattern]
        });
        
        if (result.rows.length === 0) return res.status(404).json({ error: "Job no encontrado" });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/ask', async (req, res) => {
    const { q, user_id } = req.query;
    if (!q) return res.status(400).json({ error: "Faltan parÃ¡metros" });

    try {
        const { chunks } = await performSearch(q, user_id);
        const contextText = chunks.length > 0 ? chunks.map(c => \`[\${c.source_file}]: \${c.content}\`).join("\n\n") : "Sin contexto.";
        const prompt = \`Responde basÃ¡ndote solo en el contexto.\nContexto:\n\${contextText}\n\nPregunta: \${q}\`;
        
        const answer = await callGemini(async (apiKey) => {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
            const result = await model.generateContent(prompt);
            return result.response.text();
        }, { tier: 'batch', description: 'ask' });

        res.json({ answer: answer || "Sin respuesta", context_used: chunks.length + " tramos" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/ingest', async (req, res) => {
    const userId = req.query.user_id || 'default';
    const filename = req.query.filename || \`upload-\${Date.now()}.md\`;
    let text = req.body;

    console.log(\`[Ingest] ðŸ“¥ Recibida peticiÃ³n: \${filename} (user: \${userId})\`);
    
    // Force text to string if it arrived as object (due to JSON body parsing)
    if (text && typeof text === 'object') {
        if (text.content) text = text.content;
        else if (text.text) text = text.text;
        else text = JSON.stringify(text);
        console.warn(\`[Ingest] âš ï¸ Text arrived as OBJECT. Forced to string. Length: \${text.length}\`);
    }

    const safeUserId = String(userId);
    const safeFilename = String(filename);
    const safeText = String(text || '');

    console.log(\`[Ingest][DEBUG] Params: book_id=NEW, user_id="\${safeUserId}" (\${typeof safeUserId}), title="\${safeFilename}" (\${typeof safeFilename}), text_len=\${safeText.length} (\${typeof safeText})\`);

    try {
        if (!safeText || safeText.length === 0) return res.status(400).json({ error: "Contenido vacÃ­o o no vÃ¡lido" });

        const bookId = crypto.randomUUID();
        
        // 1. Guardar metadatos - explicit cast to detect WHO is mismatching
        console.log(\`[Ingest][STEP 1] Inserting into books...\`);
        try {
            await db.execute({
                sql: "INSERT INTO books (id, user_id, title, author, index_status) VALUES (?, ?, ?, ?, ?)",
                args: [bookId, safeUserId, safeFilename.replace(/\\.[^/.]+$/, ""), "Desconocido", "pending"]
            });
        } catch (e1) {
            console.error(\`[Ingest][STEP 1] âŒ FAILED: \${e1.message}\`);
            throw new Error(\`Step 1 (books) Mismatch: \${e1.message}\`);
        }

        // 2. Guardar contenido raw
        console.log(\`[Ingest][STEP 2] Inserting into book_raw...\`);
        try {
            await db.execute({
                sql: "INSERT INTO book_raw (book_id, content) VALUES (?, ?)",
                args: [bookId, safeText]
            });
        } catch (e2) {
            console.error(\`[Ingest][STEP 2] âŒ FAILED: \${e2.message}\`);
            throw new Error(\`Step 2 (book_raw) Mismatch: \${e2.message}\`);
        }

        // 3. Crear Job
        console.log(\`[Ingest][STEP 3] Inserting into enrichment_jobs...\`);
        try {
            const jobId = crypto.randomUUID();
            await db.execute({
                sql: "INSERT INTO enrichment_jobs (id, book_id, user_id, file_name, status) VALUES (?, ?, ?, ?, 'PENDING')",
                args: [jobId, bookId, safeUserId, safeFilename]
            });

            startPipeline(userId, bookId, jobId);
            res.status(200).json({ success: true, bookId, jobId });
        } catch (e3) {
            console.error(\`[Ingest][STEP 3] âŒ FAILED: \${e3.message}\`);
            throw new Error(\`Step 3 (enrichment_jobs) Mismatch: \${e3.message}\`);
        }
    } catch (err) {
        console.error("[Ingest] âŒ Error FATAL:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Auto-recovery & Startup
async function recoverPendingJobs() {
    console.log("[JOBS] ðŸ”Ž Recovery startup...");
    try {
        const query = "SELECT id, book_id, user_id, status FROM enrichment_jobs WHERE status IN ('PENDING', 'PROCESSING', 'RETRY')";
        const pending = await db.execute(query);
        console.log(\`[JOBS] ðŸ“Š Recovery: \${pending.rows.length} jobs.\`);
        
        for (const job of pending.rows) {
            startPipeline(job.user_id, job.book_id, job.id).catch(() => {});
        }
    } catch (err) { console.error("[JOBS] Recovery error:", err.message); }
}

async function initServer() {
    console.log("[Init] ðŸš€ Iniciando v1.0.36-deep-observability...");
    try {
        await runMigrations(db);
        await recoverPendingJobs();
        app.listen(PORT, () => {
            console.log(\`ðŸš€ JDOCMUNCH Hardened v1.0.35-syntax-fix listening on port \${PORT}\`);
        });
    } catch (err) {
        console.error("âŒ Fatal:", err);
        process.exit(1);
    }
}

initServer();
