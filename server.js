const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require("@google/genai");
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
const PORT = process.env.PORT || 3000;
const REPO = "local/books";
const BOOKS_DIR = path.join(__dirname, 'books');

app.use(express.static(path.join(__dirname, 'public')));

// Gemini Setup
const getApiKey = () => process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({
    apiKey: getApiKey()
});

const transport = new StdioClientTransport({ 
    command: "uvx", 
    args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
    env: process.env 
});
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.16" }, { capabilities: {} });

let isConnected = false;
async function connectClient() {
    if (isConnected) return;
    try { 
        await client.connect(transport); 
        isConnected = true; 
        console.log("✅ MCP Conectado"); 
    } catch (e) { 
        console.error("❌ Error MCP:", e.message); 
    }
}

function getUserBooksDir(userId) {
    const id = userId || 'default';
    const dir = path.join(BOOKS_DIR, id);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    // Limpieza de emergencia para el proyecto actual
    // Si estamos en el namespace 'default', borrar libros antiguos conocidos para evitar alucinaciones
    if (id === 'default') {
        const oldFiles = ['libro_pt1.md', 'libro_pt2.md', 'nervio_vago.md'];
        oldFiles.forEach(f => {
            const p = path.join(dir, f);
            if (fs.existsSync(p)) {
                try {
                    fs.unlinkSync(p);
                    console.log(`[PURGE] 🧹 Borrado archivo antiguo: ${f}`);
                } catch(e) {}
            }
        });
    }
    
    return dir;
}

function getUserRepo(userId) {
    const id = userId || 'default';
    return `local/${id}`;
}

let isIndexing = false;
let needsReindex = false;

async function processIndexQueue(userId) {
    if (isIndexing) {
        needsReindex = true;
        return;
    }
    isIndexing = true;
    needsReindex = false;

    const userDir = getUserBooksDir(userId);
    console.log(`[BACKGROUND] 🔄 Iniciando indexador para ${userId} en ${userDir}...`);
    
    try {
        const bgTransport = new StdioClientTransport({ 
            command: "uvx", 
            args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
            env: { ...process.env, JDOCMUNCH_REPO: getUserRepo(userId) } 
        });
        const indexClient = new Client({ name: "indexer", version: "1.0.18" }, { capabilities: {} });
        await indexClient.connect(bgTransport);
        
        await indexClient.callTool({
            name: "index_local",
            arguments: { 
                path: userDir,
                use_ai_summaries: false,
                use_embeddings: true
            }
        });
        
        console.log(`[BACKGROUND] ✅ Indexación para ${userId} completada.`);
        try { await bgTransport.close(); } catch(e) {}
    } catch (e) {
        console.error(`[BACKGROUND] ❌ Error indexando ${userId}:`, e.message);
    } finally {
        isIndexing = false;
        if (needsReindex) {
            processIndexQueue(userId);
        }
    }
}

async function performSearch(q, userId) {
    await connectClient();
    
    const userRepo = getUserRepo(userId);
    // 1. Search sections
    const searchStart = Date.now();
    const result = await client.callTool({ 
        name: "search_sections", 
        arguments: { repo: userRepo, query: q, max_results: 8 } 
    });
    const data = JSON.parse(result.content[0].text);
    const search_ms = Date.now() - searchStart;

    // 2. Get full content for each result
    const retrievalStart = Date.now();
    let chunks = [];
    if (data.results) {
        for (const r of data.results) {
            try {
                const sec = await client.callTool({ 
                    name: "get_section", 
                    arguments: { repo: userRepo, section_id: r.id } 
                });
                const sData = JSON.parse(sec.content[0].text);

                // Extract source file from section_id
                const sectionId = r.id || "";
                const parts = sectionId.split("::");
                
                let sourceFile = "desconocido";
                if (parts.length > 1) {
                    sourceFile = parts.slice(1).find(p => p.includes('.')) || parts[1];
                } else {
                    sourceFile = parts[0] || "desconocido";
                }

                chunks.push({ 
                    title: r.title, 
                    content: sData.section?.content || sData.content || "",
                    summary: r.summary,
                    source_file: sourceFile,
                    section_id: sectionId
                });
            } catch (secErr) {
                console.warn(`⚠️ Error recuperando sección ${r.id}:`, secErr.message);
            }
        }
    }
    const retrieval_ms = Date.now() - retrievalStart;

    return { chunks, breakdown: { search_ms, retrieval_ms } };
}

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: '1.0.16', 
        mcp_connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

// List indexed books
app.get('/books', (req, res) => {
    const userId = req.query.user_id;
    const userDir = getUserBooksDir(userId);
    try {
        if (!fs.existsSync(userDir)) {
            return res.json({ books: [] });
        }
        const files = fs.readdirSync(userDir)
            .filter(f => ['.md', '.txt', '.rst'].includes(path.extname(f).toLowerCase()))
            .map(f => {
                const stat = fs.statSync(path.join(userDir, f));
                return {
                    filename: f,
                    size: stat.size,
                    modified: stat.mtime.toISOString()
                };
            });
        res.json({ books: files, total: files.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/search', async (req, res) => {
    const { q, user_id } = req.query;
    if (!q) return res.status(400).json({ error: "Falta q" });
    try {
        const { chunks, breakdown } = await performSearch(q, user_id);
        res.json({ results: chunks, breakdown });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/ask', async (req, res) => {
    const { q, user_id } = req.query;
    const currentKey = getApiKey();
    console.log(`[v1.0.18] 🔍 Pregunta: "${q}" | User: ${user_id} | Key: ${currentKey ? "Presente" : "VACÍA"}`);

    if (!currentKey) return res.status(500).json({ error: "Falta API Key" });
    if (!q) return res.status(400).json({ error: "Falta q" });

    try {
        const { chunks, breakdown } = await performSearch(q, user_id);
        
        const synthesisStart = Date.now();
        const contextText = chunks.length > 0 
            ? chunks.map(c => `[${c.source_file} → ${c.title}]: ${c.content}`).join("\n\n")
            : "Contexto no encontrado.";

        const prompt = `Eres un experto literario. Responde la siguiente pregunta basándote SOLO en el contexto proporcionado.
                        Contexto:\n${contextText}\n\nPregunta: ${q}`;
        
        // Gemini Call
        const responseData = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });

        const synthesis_ms = Date.now() - synthesisStart;

        res.json({ 
            answer: responseData.text || "Sin respuesta", 
            context_used: chunks.length + " tramos",
            breakdown: { ...breakdown, synthesis_ms }
        });
    } catch (err) { 
        console.error("❌ ERROR v1.0.16:", err.message);
        res.status(500).json({ error: "Error AI", details: err.message }); 
    }
});

app.post('/ingest', async (req, res) => {
    const { filename, content, user_id } = req.body;
    if (!filename || !content) {
        return res.status(400).json({ error: "filename y content (markdown) son requeridos" });
    }

    try {
        await connectClient();
        
        const userDir = getUserBooksDir(user_id);

        const safeName = filename.endsWith('.md') ? filename : filename.replace(/\.[^.]+$/, '.md');
        const filePath = path.join(userDir, safeName);
        fs.writeFileSync(filePath, content);
        console.log(`[INGEST] 📥 [User: ${user_id || 'default'}] Archivo guardado: ${safeName} en ${filePath}`);

        processIndexQueue(user_id || 'default');

        res.json({ 
            success: true, 
            message: `Archivo ${safeName} subido correctamente para el usuario ${user_id}.`
        });
    } catch (err) {
        console.error(`[INGEST] ❌ Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/ingest', async (req, res) => {
    const { filename, user_id } = req.body;
    if (!filename) {
        return res.status(400).json({ error: "filename es requerido" });
    }

    try {
        await connectClient();
        
        const userDir = getUserBooksDir(user_id);
        const baseName = filename.replace(/\.[^.]+$/, '');
        const possibleFiles = [
            filename, 
            filename + ".md", 
            baseName + ".md",
            baseName + ".txt"
        ];
        let deletedCount = 0;

        for (const f of possibleFiles) {
            const filePath = path.join(userDir, f);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`[DELETE] 🗑️ [User: ${user_id}] Archivo borrado: ${f}`);
            }
        }

        if (deletedCount > 0) {
            processIndexQueue(user_id);
        }

        res.json({ 
            success: true, 
            message: deletedCount > 0 ? "Archivo eliminado e índice actualizado" : "Archivo no encontrado",
            deleted: deletedCount
        });
    } catch (err) {
        console.error(`[DELETE] ❌ Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/reindex', (req, res) => {
    const userId = req.query.user_id || 'default';
    console.log(`[REINDEX] 🔄 Disparo manual de indexación para usuario: ${userId}`);
    processIndexQueue(userId);
    res.json({ success: true, message: `Indexación iniciada para ${userId}` });
});

app.post('/reset', async (req, res) => {
    const { user_id } = req.body;
    try {
        await connectClient();
        const userRepo = getUserRepo(user_id);
        console.log(`[RESET] 🔥 Purgando repositorio de vectores: ${userRepo}`);
        
        await client.callTool({
            name: "delete_repo",
            arguments: { repo: userRepo }
        });

        // Disparar re-indexación inmediata de los archivos físicos que SÍ deberían estar
        processIndexQueue(user_id || 'default');

        res.json({ success: true, message: `Repositorio ${userRepo} reseteado y re-indexación iniciada.` });
    } catch (err) {
        console.error(`[RESET] ❌ Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Microservicio v1.0.16 listo en puerto ${PORT}`);
});
