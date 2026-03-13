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

let isIndexing = false;
let needsReindex = false;

async function processIndexQueue() {
    if (isIndexing) {
        needsReindex = true;
        return;
    }
    isIndexing = true;
    needsReindex = false;

    console.log("[BACKGROUND] 🔄 Iniciando indexador en proceso separado...");
    
    try {
        const bgTransport = new StdioClientTransport({ 
            command: "uvx", 
            args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
            env: process.env 
        });
        const indexClient = new Client({ name: "indexer", version: "1.0.17" }, { capabilities: {} });
        await indexClient.connect(bgTransport);
        
        await indexClient.callTool({
            name: "index_local",
            arguments: { 
                path: BOOKS_DIR,
                use_ai_summaries: false,
                use_embeddings: true
            }
        });
        
        console.log("[BACKGROUND] ✅ Indexación semántica completada con éxito.");
        try { await bgTransport.close(); } catch(e) {}
    } catch (e) {
        console.error("[BACKGROUND] ❌ Error indexando:", e.message || "Unknown error");
    } finally {
        isIndexing = false;
        if (needsReindex) {
            console.log("[BACKGROUND] 🔄 Procesando re-indexación encolada...");
            processIndexQueue();
        }
    }
}

async function performSearch(q) {
    await connectClient();
    
    // 1. Search sections
    const searchStart = Date.now();
    const result = await client.callTool({ 
        name: "search_sections", 
        arguments: { repo: REPO, query: q, max_results: 8 } 
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
                    arguments: { repo: REPO, section_id: r.id } 
                });
                const sData = JSON.parse(sec.content[0].text);

                // Extract source file from section_id
                // section_id format: "repo::filename::heading_path" e.g. "local/books::libro_pt1.md::Capítulo 1"
                const sectionId = r.id || "";
                const parts = sectionId.split("::");
                
                // jDocMunch structure: "repo::filename.md::Section Heading"
                // We seek the part that looks like a filename (has a dot) or a path.
                let sourceFile = "desconocido";
                if (parts.length > 1) {
                    // Start from index 1 as index 0 is always the repo name
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
    try {
        if (!fs.existsSync(BOOKS_DIR)) {
            return res.json({ books: [] });
        }
        const files = fs.readdirSync(BOOKS_DIR)
            .filter(f => ['.md', '.txt', '.rst'].includes(path.extname(f).toLowerCase()))
            .map(f => {
                const stat = fs.statSync(path.join(BOOKS_DIR, f));
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
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Falta q" });
    try {
        const { chunks, breakdown } = await performSearch(q);
        res.json({ results: chunks, breakdown });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/ask', async (req, res) => {
    const q = req.query.q;
    const currentKey = getApiKey();
    console.log(`[v1.0.16] 🔍 Pregunta: "${q}" | Key: ${currentKey ? "Presente" : "VACÍA"}`);

    if (!currentKey) return res.status(500).json({ error: "Falta API Key" });
    if (!q) return res.status(400).json({ error: "Falta q" });

    try {
        const { chunks, breakdown } = await performSearch(q);
        
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
    const { filename, content } = req.body;
    if (!filename || !content) {
        return res.status(400).json({ error: "filename y content (markdown) son requeridos" });
    }

    try {
        await connectClient();
        
        // 1. Guardar archivo físicamente en la carpeta de libros
        if (!fs.existsSync(BOOKS_DIR)) {
            fs.mkdirSync(BOOKS_DIR, { recursive: true });
        }

        // Siempre guardar como .md
        const safeName = filename.endsWith('.md') ? filename : filename.replace(/\.[^.]+$/, '.md');
        const filePath = path.join(BOOKS_DIR, safeName);
        fs.writeFileSync(filePath, content);
        console.log(`[INGEST] 📥 Archivo guardado: ${safeName} (${content.length} chars)`);

        // 2. Disparar re-indexación local en background
        console.log(`[INGEST] 🔄 Encolando re-indexación en background...`);
        processIndexQueue(); // Fire and forget

        res.json({ 
            success: true, 
            message: `Archivo ${safeName} subido correctamente. La indexación semántica se ejecutará en segundo plano.`
        });
    } catch (err) {
        console.error(`[INGEST] ❌ Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/ingest', async (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        return res.status(400).json({ error: "filename es requerido" });
    }

    try {
        await connectClient();
        
        // Buscar y borrar todas las variantes (con .md o sin)
        const baseName = filename.replace(/\.[^.]+$/, '');
        const possibleFiles = [
            filename, 
            filename + ".md", 
            baseName + ".md",
            baseName + ".txt"
        ];
        let deletedCount = 0;

        for (const f of possibleFiles) {
            const filePath = path.join(BOOKS_DIR, f);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`[DELETE] 🗑️ Archivo borrado: ${f}`);
            }
        }

        if (deletedCount > 0) {
            console.log(`[DELETE] 🔄 Encolando re-indexación tras borrado...`);
            processIndexQueue(); // Fire and forget
        }

        res.json({ 
            success: true, 
            message: deletedCount > 0 ? "Archivo eliminado e índice actualizado" : "Archivo no encontrado en el VPS",
            deleted: deletedCount
        });
    } catch (err) {
        console.error(`[DELETE] ❌ Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Microservicio v1.0.16 listo en puerto ${PORT}`);
});
