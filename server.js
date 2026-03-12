const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');
<<<<<<< Updated upstream
const { GoogleGenAI } = require("@google/genai");
=======
const { GoogleGenerativeAI } = require("@google/generative-ai");
>>>>>>> Stashed changes
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const REPO = "local/books";

app.use(express.static(path.join(__dirname, 'public')));

<<<<<<< Updated upstream
// Gemini 3.1 Lite Setup (Using the new SDK as requested)
const getApiKey = () => process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({
    apiKey: getApiKey()
=======
// Gemini Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

const transport = new StdioClientTransport({ 
    command: "uvx", 
    args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
    env: process.env // Asegura que las API Keys se pasen al motor de Python
>>>>>>> Stashed changes
});
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.4" }, { capabilities: {} });

<<<<<<< Updated upstream
const transport = new StdioClientTransport({ 
    command: "uvx", 
    args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
    env: process.env 
});
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.15" }, { capabilities: {} });

=======
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
=======
    
    // 1. Search sections
    const searchStart = Date.now();
>>>>>>> Stashed changes
    const result = await client.callTool({ 
        name: "search_sections", 
        arguments: { repo: REPO, query: q, max_results: 5 } 
    });
    const data = JSON.parse(result.content[0].text);
<<<<<<< Updated upstream

=======
    const search_ms = Date.now() - searchStart;

    // 2. Get full content for each result
    const retrievalStart = Date.now();
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
                content: sData.section?.content || sData.content || ""
            });
        }
=======
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
>>>>>>> Stashed changes
    }
    return { chunks };
}

app.get('/ask', async (req, res) => {
    const q = req.query.q;
<<<<<<< Updated upstream
    const currentKey = getApiKey();
    console.log(`[v1.0.15] 🔍 Pregunta: "${q}" | Key: ${currentKey ? "Presente" : "VACÍA"}`);

    if (!currentKey) return res.status(500).json({ error: "Falta API Key" });

    try {
        const { chunks } = await performSearch(q);
        const contextText = chunks.length > 0 
            ? chunks.map(c => `[${c.title}]: ${c.content}`).join("\n\n")
            : "Contexto no encontrado.";

        const prompt = `Eres un experto literario. Responde basándote SOLO en el contexto:\n\n${contextText}\n\nPregunta: ${q}`;
        
        // Gemini 3.1 Lite Call
        const responseData = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: [{
                role: 'user',
                parts: [{ text: prompt }]
            }]
        });

        // The answer is in responseData.text (or responseData.candidates[0].content.parts[0].text depending on SDK version)
        // With @google/genai, it's usually responseData.text
        res.json({ answer: responseData.text || "Sin respuesta", context_used: chunks.length });
    } catch (err) { 
        console.error("❌ ERROR v1.0.15:", err.message);
        res.status(500).json({ error: "Error AI", details: err.message }); 
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Microservicio v1.0.15 listo (Gemini 3.1 Lite)`);
});
=======
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

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Microservicio v1.0.4 listo`));
>>>>>>> Stashed changes
