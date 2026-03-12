const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const REPO = "local/books";

app.use(express.static(path.join(__dirname, 'public')));

// Gemini Setup
const getApiKey = () => process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(getApiKey());
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const transport = new StdioClientTransport({ 
    command: "uvx", 
    args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp==1.3.0"],
    env: process.env 
});
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.9" }, { capabilities: {} });

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
                content: sData.section?.content || sData.content || "",
                summary: r.summary
            });
        }
    }
    return { chunks };
}

app.get('/ask', async (req, res) => {
    const q = req.query.q;
    const currentKey = getApiKey();
    const keyDiag = currentKey ? `${currentKey.substring(0,4)}...` : "VACÍA";
    
    console.log(`[v1.0.9] 🔍 Pregunta: "${q}" | Key: ${keyDiag}`);

    if (!currentKey) {
        return res.status(500).json({ error: "API Key no detectada en environment", diagnostic: "Verificar archivo .env y volumen docker" });
    }

    try {
        const { chunks } = await performSearch(q);
        const contextText = chunks.length > 0 
            ? chunks.map(c => `[${c.title}]: ${c.content}`).join("\n\n")
            : "No hay contexto disponible.";

        const prompt = `Eres un experto en el libro "Estimula tu nervio vago". Responde la siguiente pregunta basándote SOLO en el contexto proporcionado.\nContexto:\n${contextText}\n\nPregunta: ${q}`;
        
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        res.json({ answer: responseText, context_used: chunks.length });
    } catch (err) { 
        console.error("❌ ERROR CRÍTICO v1.0.9:", err);
        res.status(500).json({ 
            error: "Fallo en síntesis AI", 
            details: err.message,
            key_diagnostic: keyDiag
        }); 
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Microservicio v1.0.9 listo`);
    console.log(`Diagnostic: Key loaded -> ${getApiKey().substring(0,4)}...`);
});
