/**
 * @file pipeline.js
 * @description Orquestador del pipeline de enriquecimiento (Omnisciencia).
 * Implementa recuperación por pasos, sincronización automática de metadatos y
 * uso mandatorio de GeminiCaller para resiliencia de cuota.
 */

const { db } = require('./db');
const { callGemini } = require('./geminiCaller');
const { pipelineQueue } = require('./pipelineQueue');
const { notifyVercel } = require('./webhook');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { callTool } = require("./mcpClient");
const { jobLogger } = require("./jobLogger");
const { runMcpToolDirectly } = require("./mcpRunner");
const { getIndexedFilename } = require("./searchRuntime");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getUserRepo(userId) {
    const clean = userId || "default";
    return "local/" + clean;
}

const STEPS = [
  { name: 'Detectar Estructura', status: 'DETECTING_STRUCTURE', fn: detectBookStructure, maxRetries: 3, tier: 'batch' },
  { name: 'Generar DNA (Metadatos)', status: 'ENRICHING_DNA', fn: generateBookDNA, maxRetries: 3, tier: 'batch' },
  { name: 'Indexar Contenido (RAG)', status: 'INDEXING', fn: processIndexing, maxRetries: 2, tier: 'embedding' },
  { name: 'Enriquecimiento Socrático', status: 'ENRICHING_SOCRATIC', fn: generateSocraticElements, maxRetries: 2, tier: 'batch' },
  { name: 'Compendio Pedagógico', status: 'ENRICHING_PEDAGOGICAL', fn: generatePedagogicalCompendium, maxRetries: 2, tier: 'batch' }
];

async function runFullPipeline(userId, bookId, jobId) {
    console.log(`[Pipeline] 🧬 Iniciando pipeline para Libro ${bookId} (Job ${jobId})`);
    try {
        const jobResult = await db.execute({ sql: "SELECT current_step, status FROM enrichment_jobs WHERE id = ?", args: [jobId] });
        const job = jobResult.rows[0];
        let startIndex = 0;
        if (job && job.status === 'FAILED' && job.current_step) {
            startIndex = STEPS.findIndex(s => s.status === job.current_step);
            startIndex = startIndex === -1 ? 0 : startIndex;
            console.log(`[Pipeline] 🔄 Recuperando desde el paso: ${STEPS[startIndex].name}`);
        }

        for (let i = startIndex; i < STEPS.length; i++) {
            const step = STEPS[i];
            await jobLogger.log(jobId, bookId, step.status, 'meta', `INICIANDO PASO: ${step.name}`);
            await db.execute({ sql: "UPDATE enrichment_jobs SET current_step = ?, status = 'RUNNING', started_at = CURRENT_TIMESTAMP WHERE id = ?", args: [step.status, jobId] });
            console.log(`[Pipeline] --> Ejecutando: ${step.name}...`);
            await step.fn(userId, bookId, jobId);
            await jobLogger.log(jobId, bookId, step.status, 'meta', `PASO COMPLETADO: ${step.name}`);
            console.log(`[Pipeline] ✓ ${step.name} completado.`);
            if (i < STEPS.length - 1) await new Promise(resolve => setTimeout(resolve, 3000));
        }

        await jobLogger.log(jobId, bookId, 'DONE', 'meta', "Pipeline finalizado exitosamente.");
        await db.execute({ sql: "UPDATE enrichment_jobs SET status = 'COMPLETE', completed_at = CURRENT_TIMESTAMP, current_step = 'DONE' WHERE id = ?", args: [jobId] });
        await db.execute({ sql: "UPDATE books SET index_status = 'ready' WHERE id = ?", args: [bookId] });
        console.log(`[Pipeline] ✅ Omnisciencia COMPLETA para ${bookId}`);

        try {
            console.log(`[Pipeline] 🌐 Iniciando reconciliación de Síntesis Cruzada para usuario ${userId}`);
            await generateCrossBookSynthesis(userId, jobId);
        } catch (syntErr) {
            console.error(`[Pipeline] Error no fatal en síntesis cruzada:`, syntErr.message);
        }

        await notifyVercel(bookId, 'COMPLETE');
    } catch (err) {
        console.error(`[Pipeline] ❌ Error crítico en Job ${jobId}:`, err.message);
        await db.execute({ sql: "UPDATE enrichment_jobs SET status = 'FAILED', error_message = ? WHERE id = ?", args: [err.message, jobId] });
        await db.execute({ sql: "UPDATE books SET index_status = 'error' WHERE id = ?", args: [bookId] });
        await notifyVercel(bookId, 'ERROR', { error: err.message });
        throw err;
    }
}

async function detectBookStructure(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    const prompt = `Divide este libro en 5-10 secciones coherentes. Dame el JSON EXACTO con las primeras 10 palabras de cada sección.\n    JSON format: [{"chapter_num": 1, "title": "...", "starts_with": "..."}]\n    TEXTO: ${content.slice(0, 20000)}`;
    await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'meta', "Llamando a Gemini para detección de estructura...");
    const text = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `detectStructure:${bookId}` });

    const cleaned = text.replace(/```json|```/g, '').replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim();
    try {
        const chapters = JSON.parse(cleaned);
        await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'meta', `Detectados ${chapters.length} capítulos.`);
        await db.execute({ sql: "INSERT OR REPLACE INTO book_structure (book_id, chapters, detection_method) VALUES (?, ?, ?)", args: [bookId, JSON.stringify(chapters), 'llm_v2'] });
    } catch (e) {
        await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'error', `Fallo parseo JSON: ${e.message}`);
        throw new Error(`JSON de estructura inválido: ${e.message}`);
    }
}

async function generateBookDNA(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    const sample = `${content.slice(0, 15000)}\n\n---\n\n${content.slice(-10000)}`;
    const prompt = `Analiza este libro y extrae el ADN intelectual. Busca explícitamente el nombre del autor y el título real.\n    JSON format: { "title": "...", "author": "...", "central_thesis": "...", "argumentative_arc": ["paso 1", "paso 2"], "key_concepts": ["c1", "c2"], "tone": "..." }\n    TEXTO: ${sample}`;
    const text = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `generateDNA:${bookId}` });

    const cleaned = text.replace(/```json|```/g, '').replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim();
    const dna = JSON.parse(cleaned);
    await db.execute({ sql: "INSERT OR REPLACE INTO book_dna (book_id, title, author, central_thesis, argumentative_arc, key_concepts, tone) VALUES (?, ?, ?, ?, ?, ?, ?)", args: [bookId, dna.title, dna.author || '', dna.central_thesis, JSON.stringify(dna.argumentative_arc), JSON.stringify(dna.key_concepts), dna.tone] });
    await db.execute({ sql: "UPDATE books SET title = ?, author = ?, index_status = 'processing' WHERE id = ?", args: [dna.title, dna.author || '', bookId] });
}

async function processIndexing(userId, bookId, jobId) {
    await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Iniciando indexación NATIVA (Direct Spawn)...");
    try {
        const userIdClean = userId || 'default';
        const userBooksDir = path.join(__dirname, '..', 'books', userIdClean);
        if (!fs.existsSync(userBooksDir)) fs.mkdirSync(userBooksDir, { recursive: true });

        const content = await getBookContent(userIdClean, bookId);
        const jobRes = await db.execute({ sql: "SELECT file_name FROM enrichment_jobs WHERE book_id = ? LIMIT 1", args: [bookId] });
        let filename = `${bookId}.md`;
        if (jobRes.rows.length > 0 && jobRes.rows[0].file_name) filename = getIndexedFilename(jobRes.rows[0].file_name, bookId);

        const filePath = path.join(userBooksDir, filename);
        fs.writeFileSync(filePath, content, 'utf-8');
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', `Archivo escrito en disco: ${filePath}`);

        const repoName = getUserRepo(userIdClean);
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', `Indexing in repo: ${repoName}`);
        await callTool('index_local', { path: userBooksDir, repo: repoName, use_embeddings: true });
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Indexación completada exitosamente.");
    } catch (e) {
        await jobLogger.log(jobId, bookId, 'INDEXING', 'error', `Fallo crítico en indexación: ${e.message}`);
        throw e;
    }
}

async function generateSocraticElements(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    const promptProvs = `Sos un profesor de élite. Basado en este libro, generá 5 preguntas socráticas desafiantes.\n    JSON format: [{"provocation": "...", "difficulty": "hard"}]\n    TEXTO: ${content.slice(0, 15000)}`;
    const textProvs = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(promptProvs);
        return result.response.text();
    }, { tier: 'batch', description: `socraticProvocations:${bookId}` });

    const cleanedText = textProvs.replace(/```json|```/g, '').trim();
    const jsonMatch = cleanedText.match(/\[[\s\S]*\]/);
    const provStr = jsonMatch ? jsonMatch[0] : cleanedText;
    const provs = JSON.parse(provStr);
    for (const p of provs) {
        await db.execute({ sql: "INSERT INTO socratic_provocations (book_id, provocation, difficulty) VALUES (?, ?, ?)", args: [bookId, p.provocation, p.difficulty] });
    }
}

async function getBookContent(userId, bookId) {
    try {
        const res = await db.execute({ sql: "SELECT content FROM book_raw WHERE book_id = ? ORDER BY chunk_index ASC", args: [bookId] });
        if (res.rows.length > 0) return res.rows.map(r => r.content).join('');
    } catch(e) {}

    const jobRes = await db.execute({ sql: "SELECT file_name FROM enrichment_jobs WHERE book_id = ? LIMIT 1", args: [bookId] });
    if (jobRes.rows.length > 0) {
        const filename = jobRes.rows[0].file_name;
        const filePath = path.join(__dirname, '..', 'books', userId, filename);
        if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    }
    throw new Error(`Contenido del libro ${bookId} no encontrado en DB ni en disco.`);
}

async function generatePedagogicalCompendium(userId, bookId, jobId) {
    await jobLogger.log(jobId, bookId, 'ENRICHING_PEDAGOGICAL', 'meta', "Generando Compendio Pedagógico PROFUNDO...");
    const content = await getBookContent(userId, bookId);
    if (!content) throw new Error("No content found for compendium generation.");
    const bookRes = await db.execute({ sql: "SELECT title, author FROM books WHERE id = ?", args: [bookId] });
    const book = bookRes.rows[0] || { title: "Libro Desconocido", author: "Desconocido" };

    const prompt = `Vas a leer este libro/material académico completo. Después vas a escribir algo MUY ESPECÍFICO: no un resumen, sino TU FORMA DE PENSAR sobre este material como si fueras un profesor con 20 años de experiencia enseñándolo.\n\nEsto que escribas va a ser tu "memoria internalizada" del libro. Lo vas a tener en tu cabeza mientras enseñás, sin necesidad de consultar el libro. Por lo tanto debe capturar no el contenido literal sino tu COMPRENSIÓN PROFUNDA.\n\nAsegurate de cubrir:\n1. LA TESIS Y EL ARGUMENTO: Idea central y cómo se construye.\n2. EL HILO INVISIBLE: Conexiones no obvias entre partes distantes.\n3. LOS MOVIMIENTOS PEDAGÓGICOS: La mejor forma de enseñar cada concepto importante (ejemplos, analogías).\n4. LAS TRAMPAS MENTALES: Qué va a entender mal un alumno típico.\n5. LOS PREREQUISITOS OCULTOS: Qué se necesita entender ANTES.\n\nEscribilo en primera persona, informal, como si le estuvieras contando a un colega profesor cómo enseñás este material.\nMáximo 3000 palabras. Priorizá densidad sobre extensión.\n\nMATERIAL COMPLETO:\nTITULO: ${book.title}\nAUTOR: ${book.author}\nCONTENIDO:\n${content.slice(0, 100000)}`;

    const compendio = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `pedagogicalCompendium:${bookId}` });

    await db.execute({ sql: "UPDATE books SET pedagogical_compendium = ? WHERE id = ?", args: [compendio, bookId] });
    await jobLogger.log(jobId, bookId, 'ENRICHING_PEDAGOGICAL', 'meta', "Compendio Pedagógico guardado exitosamente.");
}

async function generateCrossBookSynthesis(userId, jobId) {
    const userIdClean = userId || 'default';
    const booksRes = await db.execute({ sql: "SELECT id, title, author, pedagogical_compendium FROM books WHERE user_id = ? AND pedagogical_compendium IS NOT NULL", args: [userIdClean] });
    if (booksRes.rows.length < 2) return;
    const books = booksRes.rows;
    let contextInput = "";
    const bookIds = books.map(b => b.id).sort().join(',');
    for (const b of books) contextInput += `MATERIAL: "${b.title}" de ${b.author}\nCOMPRENSIÓN: ${b.pedagogical_compendium}\n\n`;

    const prompt = `Estudiaste profundamente estos materiales y los conocés como la palma de tu mano:\n\n${contextInput}\nAhora escribí cómo se relacionan estos materiales entre sí. Esto es para tu uso como profesor.\n\nCubrí:\n1. DÓNDE SE COMPLEMENTAN\n2. DÓNDE DIVERGEN O SE CONTRADICEN\n3. LA NARRATIVA INTEGRADA\n4. MOVIMIENTOS PEDAGÓGICOS CROSS-BOOK\n\nEscribilo en primera persona, informal. Máximo 2000 palabras.`;

    const synthesis = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `crossSynthesis:${userIdClean}` });

    await db.execute({ sql: "INSERT OR REPLACE INTO cross_book_syntheses (id, user_id, book_ids, synthesis_text, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)", args: [crypto.randomUUID(), userIdClean, bookIds, synthesis] });
}

function startPipeline(userId, bookId, jobId) {
    return pipelineQueue.enqueue(bookId, () => runFullPipeline(userId, bookId, jobId));
}

module.exports = { startPipeline, runFullPipeline };
