const { notifyVercel } = require('./webhook');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { callTool } = require("./mcpClient");
const { jobLogger } = require("./jobLogger");
const { runMcpToolDirectly } = require("./mcpRunner");
const { db } = require('./db');
const { pipelineQueue } = require('./pipelineQueue');
const fs = require('fs');
const path = require('path');

const STEPS = [
  { name: 'Detectar Estructura', status: 'DETECTING_STRUCTURE', fn: detectBookStructure, maxRetries: 3, tier: 'batch' },
  { name: 'Generar DNA (Metadatos)', status: 'ENRICHING_DNA', fn: generateBookDNA, maxRetries: 3, tier: 'batch' },
  { name: 'Indexar Contenido (RAG)', status: 'INDEXING', fn: processIndexing, maxRetries: 2, tier: 'embedding' },
  { name: 'Enriquecimiento Socrático', status: 'ENRICHING_SOCRATIC', fn: generateSocraticElements, maxRetries: 2, tier: 'batch' }
];

async function runFullPipeline(userId, bookId, jobId) {
    console.log(`[Pipeline] 🧬 Iniciando para libro ${bookId}`);
    try {
        const jobResult = await db.execute({ sql: "SELECT current_step, status FROM enrichment_jobs WHERE id = ?", args: [jobId] });
        const job = jobResult.rows[0];
        let startIndex = 0;
        if (job && job.status === 'FAILED' && job.current_step) {
            startIndex = STEPS.findIndex(s => s.status === job.current_step);
            startIndex = startIndex === -1 ? 0 : startIndex;
        }

        for (let i = startIndex; i < STEPS.length; i++) {
            const step = STEPS[i];
            await jobLogger.log(jobId, bookId, step.status, 'meta', `INICIANDO PASO: ${step.name}`);
            await db.execute({ sql: "UPDATE enrichment_jobs SET current_step = ?, status = 'RUNNING', started_at = CURRENT_TIMESTAMP WHERE id = ?", args: [step.status, jobId] });
            await step.fn(userId, bookId, jobId);
            await jobLogger.log(jobId, bookId, step.status, 'meta', `PASO COMPLETADO: ${step.name}`);
            if (i < STEPS.length - 1) await new Promise(resolve => setTimeout(resolve, 3000));
        }

        await jobLogger.log(jobId, bookId, 'DONE', 'meta', "Pipeline finalizado exitosamente.");
        await db.execute({ sql: "UPDATE enrichment_jobs SET status = 'COMPLETE', completed_at = CURRENT_TIMESTAMP, current_step = 'DONE' WHERE id = ?", args: [jobId] });
        await db.execute({ sql: "UPDATE books SET index_status = 'ready' WHERE id = ?", args: [bookId] });
        await notifyVercel(bookId, 'COMPLETE');
    } catch (err) {
        console.error(`[Pipeline] ❌ Fallo fatal Job ${jobId}:`, err.message);
        await jobLogger.log(jobId, bookId, 'ERROR', 'error', `Fallo crítico: ${err.message}`);
        await db.execute({ sql: "UPDATE enrichment_jobs SET status = 'FAILED', error_message = ? WHERE id = ?", args: [err.message, jobId] });
        await db.execute({ sql: "UPDATE books SET index_status = 'error' WHERE id = ?", args: [bookId] });
        await notifyVercel(bookId, 'ERROR', { error: err.message });
        throw err;
    }
}

async function detectBookStructure(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    const prompt = `Divide en 5-10 secciones coherentes. JSON: [{"chapter_num": 1, "title": "...", "starts_with": "..."}]\nTExt: ${content.slice(0, 20000)}`;
    await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'meta', "Llamando a Gemini...");
    const text = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        return (await genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" }).generateContent(prompt)).response.text();
    }, { tier: 'batch', description: `structure:${bookId}` });
    const cleaned = text.replace(/```json|```/g, '').replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim();
    const chapters = JSON.parse(cleaned);
    await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'meta', `Detectados ${chapters.length} cap.`);
    await db.execute({ sql: "INSERT OR REPLACE INTO book_structure (book_id, chapters, detection_method) VALUES (?, ?, ?)", args: [bookId, JSON.stringify(chapters), 'llm_v2'] });
}

async function generateBookDNA(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    const sample = `${content.slice(0, 15000)}\n${content.slice(-10000)}`;
    const prompt = `Extrae ADN intelectual. JSON: { "title": "...", "author": "...", ... }\nText: ${sample}`;
    const text = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        return (await genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" }).generateContent(prompt)).response.text();
    }, { tier: 'batch', description: `dna:${bookId}` });
    const dna = JSON.parse(text.replace(/```json|```/g, '').replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim());
    await db.execute({ sql: "INSERT OR REPLACE INTO book_dna (book_id, title, author, central_thesis, argumentative_arc, key_concepts, tone) VALUES (?, ?, ?, ?, ?, ?, ?)", args: [bookId, dna.title, dna.author || '', dna.central_thesis, JSON.stringify(dna.argumentative_arc), JSON.stringify(dna.key_concepts), dna.tone] });
    await db.execute({ sql: "UPDATE books SET title = ?, author = ?, index_status = 'processing' WHERE id = ?", args: [dna.title, dna.author || '', bookId] });
}

async function processIndexing(userId, bookId, jobId) {
    await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Iniciando indexación NATIVA (Direct Spawn)...");
    try {
        const userIdClean = userId || 'default';
        const userBooksDir = path.join(__dirname, '..', 'books', userIdClean);
        await runMcpToolDirectly({ jobId, bookId, step: 'INDEXING', tool: 'index_local', args: ['--path', userBooksDir, '--use-embeddings', 'true'] });
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Indexación completada.");
    } catch (e) {
        await jobLogger.log(jobId, bookId, 'INDEXING', 'error', `Fallo: ${e.message}`);
        throw e;
    }
}

async function generateSocraticElements(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    const prompt = `5 preguntas socráticas. JSON: [{"provocation": "...", "difficulty": "hard"}]\nText: ${content.slice(0, 15000)}`;
    const text = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        return (await genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" }).generateContent(prompt)).response.text();
    }, { tier: 'batch', description: `socratic:${bookId}` });
    const provs = JSON.parse(text.replace(/```json|```/g, '').trim());
    for (const p of provs) await db.execute({ sql: "INSERT INTO socratic_provocations (book_id, provocation, difficulty) VALUES (?, ?, ?)", args: [bookId, p.provocation, p.difficulty] });
}

async function getBookContent(userId, bookId) {
    const res = await db.execute({ sql: "SELECT content FROM book_raw WHERE book_id = ?", args: [bookId] });
    if (res.rows.length > 0) return res.rows[0].content;
    const jobRes = await db.execute({ sql: "SELECT file_name FROM enrichment_jobs WHERE book_id = ? LIMIT 1", args: [bookId] });
    if (jobRes.rows.length > 0) {
        const filePath = path.join(__dirname, '..', 'books', userId, jobRes.rows[0].file_name);
        if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    }
    throw new Error(`Contenido no encontrado para ${bookId}`);
}

function startPipeline(userId, bookId, jobId) { return pipelineQueue.enqueue(bookId, () => runFullPipeline(userId, bookId, jobId)); }
module.exports = { startPipeline, runFullPipeline };
