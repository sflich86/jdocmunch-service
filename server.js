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
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const transport = new StdioClientTransport({ command: "uvx", args: ["jdocmunch-mcp"] });
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.3" }, { capabilities: {} });

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
    
    // 1. Search sections
    const searchStart = Date.now();
    const result = await client.callTool({ 
        name: "search_sections", 
        arguments: { repo: REPO, query: q, max_results: 5 } 
    });
    const data = JSON.parse(result.content[0].text);
    const search_ms = Date.now() - searchStart;

    // 2. Get full content for each result
    const retrievalStart = Date.now();
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
    const retrieval_ms = Date.now() - retrievalStart;

    return { chunks, breakdown: { search_ms, retrieval_ms } };
}

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
    if (!q) return res.status(400).json({ error: "Falta q" });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY no configurada" });

    try {
        const { chunks, breakdown } = await performSearch(q);
        
        const synthesisStart = Date.now();
        const contextText = chunks.map(c => `[${c.title}]: ${c.content}`).join("\n\n");
        const prompt = `Eres un experto en el libro "Estimula tu nervio vago". 
                        Responde la siguiente pregunta basándote SOLO en el contexto proporcionado.
                        Contexto:\n${contextText}\n\nPregunta: ${q}`;
        
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const synthesis_ms = Date.now() - synthesisStart;

        res.json({ 
            answer: responseText, 
            context_used: chunks.length + " tramos",
            breakdown: { ...breakdown, synthesis_ms }
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Microservicio v1.0.3 listo`));
