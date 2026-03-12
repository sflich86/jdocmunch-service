const express = require('express');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
// Handling potentially ESM module in CommonJS
const GoogleGenAIModule = require("@google/genai");
const GoogleGenAI = GoogleGenAIModule.GoogleGenAI || GoogleGenAIModule.default || GoogleGenAIModule;

const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const REPO = "local/books";

// Initialize Gemini
let ai;
try {
    ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
    });
} catch (e) {
    console.error("Failed to initialize GoogleGenAI:", e.message);
}

// Initialize MCP Client
const transport = new StdioClientTransport({
    command: "uvx",
    args: ["jdocmunch-mcp"],
});

const client = new Client(
    { name: "jdocmunch-web-bridge", version: "1.0.1" },
    { capabilities: {} }
);

let isClientConnected = false;

async function connectClient() {
    if (isClientConnected) return;
    try {
        await client.connect(transport);
        isClientConnected = true;
        console.log("Connected to jdocmunch-mcp server");
    } catch (error) {
        console.error("Failed to connect to MCP server:", error);
    }
}

// Raw Chunk Retrieval Endpoint
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Missing query parameter 'q'" });

    await connectClient();
    const start = Date.now();
    try {
        console.log(`\n[Search] Query: "${query}"`);

        const stopWords = new Set(['cuales', 'cual', 'como', 'que', 'quien', 'donde', 'por', 'para', 'son', 'las', 'los', 'el', 'la', 'de', 'en', 'un', 'una', 'unos', 'unas', 'y', 'o', 'es', 'del', 'al', 'con', 'su', 'sus', 'a']);
        const searchKeywords = query.toLowerCase().split(/\s+/).filter(w => !stopWords.has(w)).join(' ');

        // 1. Search for relevant sections
        const searchResult = await client.callTool({
            name: "search_sections",
            arguments: { repo: REPO, query: searchKeywords || query, max_results: 6 }
        });
        const searchData = JSON.parse(searchResult.content[0].text);
        const searchMs = Date.now() - start;
        
        // 2. Fetch full content for ALL matches
        let chunks = [];
        let retrievalLatency = 0;

        if (searchData.results && searchData.results.length > 0) {
            const retrievalStart = Date.now();
            for (const result of searchData.results) {
                const sectionResult = await client.callTool({
                    name: "get_section",
                    arguments: { repo: REPO, section_id: result.id }
                });
                const sectionData = JSON.parse(sectionResult.content[0].text);
                const chunkContent = sectionData.section?.content || sectionData.content || sectionData.text || "";
                
                chunks.push({
                    title: result.title,
                    summary: result.summary,
                    content: chunkContent
                });
            }
            retrievalLatency = Date.now() - retrievalStart;
        }

        res.json({
            results: chunks,
            breakdown: {
                search_ms: searchMs,
                retrieval_ms: retrievalLatency
            }
        });
    } catch (err) {
        console.error("[Search] Generic Failure:", err);
        res.status(500).json({ error: "Service Error", details: err.message });
    }
});

// Comprehensive QA Endpoint (Search + Multi-Retrieval + REAL Gemini 3.1)
app.get('/ask', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Missing query parameter 'q'" });

    await connectClient();
    const start = Date.now();
    try {
        console.log(`\n[QA] Query: "${query}"`);

        // Basic stop word removal for better search ranking
        const stopWords = new Set(['cuales', 'cual', 'como', 'que', 'quien', 'donde', 'por', 'para', 'son', 'las', 'los', 'el', 'la', 'de', 'en', 'un', 'una', 'unos', 'unas', 'y', 'o', 'es', 'del', 'al', 'con', 'su', 'sus', 'a']);
        const searchKeywords = query.toLowerCase().split(/\s+/).filter(w => !stopWords.has(w)).join(' ');
        
        console.log(`[QA] Search Keywords: "${searchKeywords}"`);

        // 1. Search for relevant sections (get top 6 for better coverage)
        const searchResult = await client.callTool({
            name: "search_sections",
            arguments: { repo: REPO, query: searchKeywords || query, max_results: 6 }
        });
        const searchData = JSON.parse(searchResult.content[0].text);
        
        // 2. Fetch full content for ALL matches
        let aggregateContext = "";
        let retrievalLatency = 0;
        let titlesUsed = [];

        if (searchData.results && searchData.results.length > 0) {
            const retrievalStart = Date.now();
            for (const result of searchData.results) {
                const sectionResult = await client.callTool({
                    name: "get_section",
                    arguments: { repo: REPO, section_id: result.id }
                });
                const sectionData = JSON.parse(sectionResult.content[0].text);
                const chunk = sectionData.section?.content || sectionData.content || sectionData.text || "";
                if (chunk) {
                    aggregateContext += `\n--- SOURCE: ${result.title} ---\n${chunk}\n`;
                    titlesUsed.push(result.title);
                }
            }
            retrievalLatency = Date.now() - retrievalStart;
            console.log(`[QA] Context aggregated: ${aggregateContext.length} chars.`);
        }

        // 3. REAL AI Synthesis
        const synthesisStart = Date.now();
        let answer = "";
        
        if (process.env.GEMINI_API_KEY && aggregateContext.length > 100) {
            const modelName = 'gemini-3.1-flash-lite-preview';
            
            const prompt = `Actúa como un experto en el libro "Estimula tu nervio vago" de Antonio Valenzuela. 
            Utiliza el contexto proporcionado para responder de manera extremadamente detallada.
            
            IMPORTANTE: Enumera las etapas o puntos de forma íntegra cuando se te pregunte por ellos. No resumas.
            
            CONTEXTO:
            ${aggregateContext}
            
            PREGUNTA:
            ${query}`;

            const contents = [
                {
                    role: 'user',
                    parts: [{ text: prompt }],
                },
            ];

            try {
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: contents,
                });
                
                // Extraction pattern for unified model response
                if (response.candidates && response.candidates[0].content) {
                    answer = response.candidates[0].content.parts[0].text;
                } else if (response.text) {
                    answer = response.text;
                } else {
                    answer = JSON.stringify(response);
                }
                console.log(`[QA] AI Response generated.`);
            } catch (aiErr) {
                console.error("[QA] AI Call Failed:", aiErr.message);
                answer = "Error en la síntesis de IA: " + aiErr.message;
            }

        } else if (!process.env.GEMINI_API_KEY) {
            answer = "API Key no configurada.";
        } else {
            answer = "Contexto insuficiente para generar la lista detallada. Intenta con una pregunta más específica.";
            console.log(`[QA] Context too short: ${aggregateContext.length} chars.`);
        }
        
        const synthesisLatency = Date.now() - synthesisStart;
        const totalLatency = Date.now() - start;

        res.json({
            answer: answer,
            context_used: titlesUsed.join(" | "),
            breakdown: {
                search_ms: Math.max(1, totalLatency - retrievalLatency - synthesisLatency),
                retrieval_ms: retrievalLatency,
                synthesis_ms: synthesisLatency,
                total_ms: totalLatency
            }
        });
    } catch (err) {
        console.error("[QA] Generic Failure:", err);
        res.status(500).json({ error: "Service Error", details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`jDocMunch microservice v1.0.1 running on http://localhost:${PORT}`);
});
