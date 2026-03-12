const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const REPO = "local/books";

app.use(express.static(path.join(__dirname, 'public')));

const getApiKey = () => process.env.GEMINI_API_KEY || "";

// Diagnostico inicial
console.log(`[v1.0.11] 🚀 Iniciando v1.0.11`);
console.log(`[v1.0.11] 🔑 Key diagnóstica: ${getApiKey().substring(0,4)}...`);

const genAI = new GoogleGenerativeAI(getApiKey());
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const transport = new StdioClientTransport({ 
    command: "uvx", 
    args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp==1.3.0"],
    env: process.env 
});
const client = new Client({ name: "jdocmunch-bridge", version: "1.0.11" }, { capabilities: {} });

let isConnected = false;
async function connectClient() {
    if (isConnected) return;
    try { 
        await client.connect(transport); 
        isConnected = true; 
        console.log("✅ MCP Conectado"); 
    } catch (e) { 
        console.error("❌ Error MCP:", e.message);
        throw new Error("No se pudo conectar al motor de búsqueda: " + e.message);
    }
}

app.get('/ask', async (req, res) => {
    const q = req.query.q;
    console.log(`[v1.0.11] 🔍 Pregunta recibida: "${q}"`);

    try {
        await connectClient();
        
        // ETAPA 1: Búsqueda
        console.log(`[v1.0.11] 🛰️ Buscando en MCP...`);
        let searchResult;
        try {
            searchResult = await client.callTool({ 
                name: "search_sections", 
                arguments: { repo: REPO, query: q, max_results: 5 } 
            });
        } catch (err) {
            console.error("❌ Error en herramienta search_sections:", err.message);
            return res.status(500).json({ error: "Fallo en Búsqueda", details: err.message });
        }

        const data = JSON.parse(searchResult.content[0].text);
        console.log(`[v1.0.11] 📄 Chunks encontrados: ${data.results?.length || 0}`);

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

        // ETAPA 2: Síntesis
        console.log(`[v1.0.11] 🧠 Sintetizando con Gemini...`);
        const contextText = chunks.length > 0 
            ? chunks.map(c => `[${c.title}]: ${c.content}`).join("\n\n")
            : "No se encontró información relevante en los libros.";

        const prompt = `Eres un experto literario. Responde basándote SOLO en el contexto:\n\n${contextText}\n\nPregunta: ${q}`;
        
        try {
            const result = await model.generateContent(prompt);
            const responseText = result.response.text();
            res.json({ answer: responseText, context_used: chunks.length });
        } catch (err) {
            console.error("❌ Error en Gemini API:", err.message);
            return res.status(500).json({ error: "Fallo en Gemini AI", details: err.message });
        }

    } catch (err) { 
        console.error("❌ ERROR GENERAL v1.0.11:", err.message);
        res.status(500).json({ error: "Error de servidor", details: err.message }); 
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Microservicio v1.0.11 listo`));
