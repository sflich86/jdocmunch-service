const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');
const { GoogleGenAI } = require("@google/genai");
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const REPO = "local/books";

app.use(express.static(path.join(__dirname, 'public')));

// Gemini 3.1 Lite Setup
const getApiKey = () => process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({
    apiKey: getApiKey()
});

const transport = new StdioClientTransport({ 
    command: "uvx", 
    args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
    env: process.env 
});
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.15" }, { capabilities: {} });

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

async function performSearch(q) {
    await connectClient();
    const result = await client.callTool({ 
        name: "search_sections", 
        arguments: { repo: REPO, query: q, max_results: 5 } 
    });
    const data = JSON.parse(result.content[0].text);

    let chunks = [];
    if (data.results) {
        for (const r of data.results) {
            const sec = await client.callTool({ 
                name: "get_section", 
                arguments: { repo: REPO, section_id: r.id } 
            });
            const sData = JSON.parse(sec.content[0].text);
            chunks.push({ 
                title: r.title, 
                content: sData.section?.content || sData.content || ""
            });
        }
    }
    return { chunks };
}

app.get('/ask', async (req, res) => {
    const q = req.query.q;
    const currentKey = getApiKey();
    console.log(`[v1.0.15] 🔍 Pregunta: "${q}" | Key: ${currentKey ? "Presente" : "VACÍA"}`);

    if (!currentKey) return res.status(500).json({ error: "Falta API Key" });

    try {
        const { chunks } = await performSearch(q);
        const contextText = chunks.length > 0 
            ? chunks.map(c => `[${c.title}]: ${c.content}`).join("\n\n")
            : "Contexto no encontrado.";

        const prompt = `Eres un experto literario. Responde basándote SOLO en el contexto:\n\n${contextText}\n\nPregunta: ${q}`;
        
        const responseData = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });

        res.json({ answer: responseData.text || "Sin respuesta", context_used: chunks.length });
    } catch (err) { 
        console.error("❌ ERROR v1.0.15:", err.message);
        res.status(500).json({ error: "Error AI", details: err.message }); 
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Microservicio v1.0.15 listo (Gemini 3.1 Lite)`);
});
