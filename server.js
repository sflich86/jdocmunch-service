const express = require('express');
const cors = require('cors');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bodyParser = require("body-parser");
const { GoogleGenAI } = require("@google/genai");

// Modular Imports
const { keyManager } = require("./lib/keyManager");
const { startPipeline } = require("./lib/pipeline");
const { db } = require("./lib/db");
const { runMigrations } = require("./lib/migrations");
const { callGemini } = require("./lib/geminiCaller");

require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.text({ type: 'text/*', limit: '50mb' }));

// Trace Logging & Double Shield Decoding Middleware
const traceLogs = [];
app.use((req, res, next) => {
    // 1. Double Shield Decoding (Bypass Vercel 404s for .md)
    // We replace __DOT__ with actual dots on the server
    if (req.url.includes('__DOT__')) {
        const oldUrl = req.url;
        req.url = req.url.split('__DOT__').join('.');
        console.log(`[Shield] 🛡️ Decoded URL: ${oldUrl} -> ${req.url}`);
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

// MCP Setup
const mcpEnv = { ...process.env };
// Ensure at least one key is available for MCP init if needed
const allKeys = keyManager.loadKeys('GEMINI_LIVE_KEY');
if (allKeys[0]) mcpEnv.GOOGLE_API_KEY = allKeys[0];

const transport = new StdioClientTransport({ 
    command: "uvx", 
    args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
    env: mcpEnv
});
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.26" }, { capabilities: {} });

let isConnected = false;
async function connectClient() {
    if (isConnected) return;
    try {
        await transport.start();
        await client.connect(transport);
        isConnected = true;
        console.log("✅ MCP Conectado");
    } catch (e) {
        console.error("❌ Error MCP:", e.message);
    }
}

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
    await connectClient();
    const userRepo = getUserRepo(userId);
    try {
        const result = await client.callTool({ 
            name: "search_sections", 
            arguments: { repo: userRepo, query: q, max_results: 15, min_score: 0.1 } 
        });
        const data = JSON.parse(result.content[0].text);

        let chunks = [];
        if (data.results) {
            for (const r of data.results) {
                try {
                    const sec = await client.callTool({ name: "get_section", arguments: { repo: userRepo, section_id: r.id } });
                    const sData = JSON.parse(sec.content[0].text);
                    const sectionId = r.id || "";
                    const parts = sectionId.split("::");
                    const sourceFile = parts.length > 1 ? (parts.slice(1).find(p => p.includes('.')) || parts[1]) : (parts[0] || "desconocido");

                    chunks.push({ 
                        title: r.title, 
                        content: sData.section?.content || sData.content || "",
                        summary: r.summary,
                        source_file: sourceFile,
                        section_id: sectionId
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
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '1.0.27', 
        mcp_connected: isConnected,
        tiers: keyManager.getStatus()
    });
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
            <p>Version: 1.0.27 | Refrescando cada 5 segundos...</p>
            <div id="logs">
                ${traceLogs.slice().reverse().map(l => `
                    <div class="entry">
                        <span class="timestamp">[${l.timestamp}]</span>
                        <span class="method">${l.method}</span>
                        <span class="url">${l.url}</span>
                    </div>
                `).join('')}
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

app.get('/books', async (req, res) => {
    const userId = req.query.user_id;
    try {
        // Fetch from Turso (Fase 3 Source of Truth)
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

app.delete(/^\/books\/(.+)$/, async (req, res) => {
    const id = req.params[0];
    const userId = req.body.user_id || req.query.user_id || 'admin';
    console.log(`[Server] 🗑️ Intentando eliminar libro con ID: ${id} (Usuario: ${userId})`);
    try {
        // 1. Eliminar de Turso (Fase 3 Resilience)
        const delResult = await db.execute({ sql: "DELETE FROM books WHERE id = ?", args: [id] });
        console.log(`[Server] Eliminar de DB status:`, delResult.rowsAffected);
        
        // También intentar borrar por si el ID en jobs es diferente (legacy cleanup)
        await db.execute({ sql: "DELETE FROM enrichment_jobs WHERE book_id = ? OR file_name LIKE ?", args: [id, `%${id}%`] });
        
        await db.execute({ sql: "DELETE FROM book_raw WHERE book_id = ?", args: [id] });
        await db.execute({ sql: "DELETE FROM book_dna WHERE book_id = ?", args: [id] });
        await db.execute({ sql: "DELETE FROM book_structure WHERE book_id = ?", args: [id] });

        // 2. Eliminar del sistema de archivos si existe
        const userDir = getUserBooksDir(userId);
        if (fs.existsSync(userDir)) {
          const files = fs.readdirSync(userDir);
          const targetFile = files.find(f => f.startsWith(id) || f.includes(id));
          if (targetFile) {
              fs.unlinkSync(path.join(userDir, targetFile));
          }
        }

        // 3. Notificar a MCP para limpiar índices
        try {
            await connectClient();
            await client.callTool({ 
                name: "invalidate_cache", 
                arguments: { repo: getUserRepo(userId) } 
            });
        } catch (e) {
            console.warn("MCP Clean warning:", e.message);
        }

        res.json({ success: true, message: `Libro ${id} eliminado correctamente.` });
    } catch (err) {
        console.error("Delete failed:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get(/^\/enrichment-status\/(.+)$/, async (req, res) => {
    const bookId = req.params[0];
    try {
        // Mejorar query para buscar por ID o por nombre de archivo (resiliencia legacy)
        const result = await db.execute({
            sql: "SELECT status, current_step, error_message FROM enrichment_jobs WHERE book_id = ? OR file_name LIKE ? ORDER BY created_at DESC LIMIT 1",
            args: [bookId, `%${bookId}%`]
        });
        if (result.rows.length === 0) return res.status(404).json({ error: "Job no encontrado" });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/ask', async (req, res) => {
    const { q, user_id } = req.query;
    if (!q) return res.status(400).json({ error: "Faltan parámetros" });

    try {
        const { chunks } = await performSearch(q, user_id);
        const contextText = chunks.length > 0 ? chunks.map(c => `[${c.source_file}]: ${c.content}`).join("\n\n") : "Sin contexto.";
        const prompt = `Responde basándote solo en el contexto.\nContexto:\n${contextText}\n\nPregunta: ${q}`;
        
        const answer = await callGemini(async (apiKey) => {
            const { createClient } = require("@google/genai");
            const client = createClient({ apiKey, platform: 'google' });
            const result = await client.models.generateContent({
                model: 'gemini-2.0-flash-exp',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            return result.text;
        }, { tier: 'batch', description: 'ask' });

        res.json({ answer: answer || "Sin respuesta", context_used: chunks.length + " tramos" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/ingest', async (req, res) => {
    try {
        const userId = req.query.user_id || 'default';
        const filename = req.query.filename || `upload-${Date.now()}.md`;
        const text = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: "Contenido no válido" });
        }

        const bookId = crypto.randomUUID();

        // 1. Guardar metadatos básicos
        await db.execute({
            sql: "INSERT INTO books (id, title, author, index_status) VALUES (?, ?, ?, ?)",
            args: [bookId, filename.replace(/\.[^/.]+$/, ""), "Desconocido", "pending"]
        });

        // 2. Guardar contenido raw (Fase 3 Resilience)
        await db.execute({
            sql: "INSERT INTO book_raw (book_id, content) VALUES (?, ?)",
            args: [bookId, text]
        });

        // 3. Crear Job
        const jobId = crypto.randomUUID();
        await db.execute({
            sql: "INSERT INTO enrichment_jobs (id, book_id, user_id, file_name, status) VALUES (?, ?, ?, ?, 'PENDING')",
            args: [jobId, bookId, userId, filename]
        });

        // 4. Iniciar Pipeline
        startPipeline(userId, bookId, jobId);

        res.status(200).json({ success: true, bookId, jobId });
    } catch (err) {
        console.error("Ingest failed:", err);
        res.status(500).json({ error: err.message });
    }
});

// Auto-recovery & Startup
async function recoverPendingJobs() {
    console.log("[JOBS] 🔎 Buscando jobs pendientes...");
    try {
        const pending = await db.execute({
            sql: "SELECT * FROM enrichment_jobs WHERE status NOT IN ('COMPLETE', 'FAILED')"
        });
        for (const job of pending.rows) {
            console.log(`[JOBS] 🔄 Recuperando job ${job.id}...`);
            startPipeline(job.user_id, job.book_id, job.id).catch(() => {});
        }
    } catch (err) { console.error("[JOBS] Error recovery:", err.message); }
}

async function initServer() {
    try {
        await runMigrations(db);
        await recoverPendingJobs();
        app.listen(PORT, () => {
            console.log(`🚀 JDOCMUNCH Hardened v1.0.26 listening on port ${PORT}`);
        });
    } catch (err) {
        console.error("❌ Fallo crítico:", err);
        process.exit(1);
    }
}

initServer();
