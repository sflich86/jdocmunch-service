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
const fs = require('fs');
const path = require('path');

// Configuración de Pasos del Pipeline según la recomendación del experto
const STEPS = [
  {
    name: 'Detectar Estructura',
    status: 'DETECTING_STRUCTURE',
    fn: detectBookStructure,
    maxRetries: 3,
    tier: 'batch'
  },
  {
    name: 'Generar DNA (Metadatos)',
    status: 'ENRICHING_DNA',
    fn: generateBookDNA,
    maxRetries: 3,
    tier: 'batch'
  },
  {
    name: 'Indexar Contenido (RAG)',
    status: 'INDEXING',
    fn: processIndexing, 
    maxRetries: 2,
    tier: 'embedding'
  },
  {
    name: 'Enriquecimiento Socrático',
    status: 'ENRICHING_SOCRATIC',
    fn: generateSocraticElements,
    maxRetries: 2,
    tier: 'batch'
  }
];

/**
 * Ejecuta el pipeline completo para un libro.
 * Soporta recuperación desde el último punto de fallo.
 */
async function runFullPipeline(userId, bookId, jobId) {
    console.log(`[Pipeline] 🧬 Iniciando pipeline para Libro ${bookId} (Job ${jobId})`);
    
    try {
        // 1. Obtener estado actual del job para ver si hay que retomar
        const jobResult = await db.execute({
            sql: "SELECT current_step, status FROM enrichment_jobs WHERE id = ?",
            args: [jobId]
        });
        
        const job = jobResult.rows[0];
        let startIndex = 0;
        
        if (job && job.status === 'FAILED' && job.current_step) {
            startIndex = STEPS.findIndex(s => s.status === job.current_step);
            startIndex = startIndex === -1 ? 0 : startIndex;
            console.log(`[Pipeline] 🔄 Recuperando desde el paso: ${STEPS[startIndex].name}`);
        }

        // 2. Ejecutar pasos secuencialmente
        for (let i = startIndex; i < STEPS.length; i++) {
            const step = STEPS[i];
            
            await jobLogger.log(jobId, bookId, step.status, 'meta', `INICIANDO PASO: ${step.name}`);

            // Actualizar DB con el paso actual
            await db.execute({
                sql: "UPDATE enrichment_jobs SET current_step = ?, status = 'RUNNING', started_at = CURRENT_TIMESTAMP WHERE id = ?",
                args: [step.status, jobId]
            });

            console.log(`[Pipeline] --> Ejecutando: ${step.name}...`);
            
            // Ejecutar la función del paso
            await step.fn(userId, bookId, jobId);
            
            await jobLogger.log(jobId, bookId, step.status, 'meta', `PASO COMPLETADO: ${step.name}`);
            console.log(`[Pipeline] ✓ ${step.name} completado.`);
            
            // Pausa de cortesía
            if (i < STEPS.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        // 3. Finalización exitosa
        await jobLogger.log(jobId, bookId, 'DONE', 'meta', "Pipeline finalizado exitosamente.");
        await db.execute({
            sql: "UPDATE enrichment_jobs SET status = 'COMPLETE', completed_at = CURRENT_TIMESTAMP, current_step = 'DONE' WHERE id = ?",
            args: [jobId]
        });

        await db.execute({
            sql: "UPDATE books SET index_status = 'ready' WHERE id = ?",
            args: [bookId]
        });
        
        console.log(`[Pipeline] ✅ Omnisciencia COMPLETA para ${bookId}`);
        
        // Sincronización fase final
        await notifyVercel(bookId, 'COMPLETE');

    } catch (err) {
        console.error(`[Pipeline] ❌ Error crítico en Job ${jobId}:`, err.message);
        await db.execute({
            sql: "UPDATE enrichment_jobs SET status = 'FAILED', error_message = ? WHERE id = ?",
            args: [err.message, jobId]
        });

        // 🧬 SINCRONIZACIÓN: Marcar el libro como error para que el UI no se quede en 'PENDING'
        await db.execute({
            sql: "UPDATE books SET index_status = 'error' WHERE id = ?",
            args: [bookId]
        });

        // Notificar fallo a Vercel para que el frontend detenga el polling con error
        await notifyVercel(bookId, 'ERROR', { error: err.message });
        
        throw err;
    }
}

// --- FUNCIONES DE LOS PASOS ---

async function detectBookStructure(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    
    // Lógica de detección (simplificada para integración rápida)
    const prompt = `Divide este libro en 5-10 secciones coherentes. Dame el JSON EXACTO con las primeras 10 palabras de cada sección.
    JSON format: [{"chapter_num": 1, "title": "...", "starts_with": "..."}]
    TEXTO: ${content.slice(0, 20000)}`;

    await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'meta', "Llamando a Gemini para detección de estructura...");
    const text = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `detectStructure:${bookId}` });

    // Hardened JSON Cleaning
    const cleaned = text.replace(/```json|```/g, '').replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim();
    try {
        const chapters = JSON.parse(cleaned);
        await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'meta', `Detectados ${chapters.length} capítulos.`);
        await db.execute({
            sql: "INSERT OR REPLACE INTO book_structure (book_id, chapters, detection_method) VALUES (?, ?, ?)",
            args: [bookId, JSON.stringify(chapters), 'llm_v2']
        });
    } catch (e) {
        await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'error', `Fallo parseo JSON: ${e.message}`);
        console.error(`[Pipeline] Falló parseo de estructura para ${bookId}:`, e.message);
        throw new Error(`JSON de estructura inválido: ${e.message}`);
    }
}

async function generateBookDNA(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    const sample = `${content.slice(0, 15000)}\n\n---\n\n${content.slice(-10000)}`;
    const prompt = `Analiza este libro y extrae el ADN intelectual. Busca explícitamente el nombre del autor y el título real.
    JSON format: { "title": "...", "author": "...", "central_thesis": "...", "argumentative_arc": ["paso 1", "paso 2"], "key_concepts": ["c1", "c2"], "tone": "..." }
    TEXTO: ${sample}`;

    const text = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `generateDNA:${bookId}` });

    try {
        const cleaned = text.replace(/```json|```/g, '').replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim();
        const dna = JSON.parse(cleaned);

        // Guardar ADN
        await db.execute({
            sql: "INSERT OR REPLACE INTO book_dna (book_id, title, author, central_thesis, argumentative_arc, key_concepts, tone) VALUES (?, ?, ?, ?, ?, ?, ?)",
            args: [bookId, dna.title, dna.author || '', dna.central_thesis, JSON.stringify(dna.argumentative_arc), JSON.stringify(dna.key_concepts), dna.tone]
        });

        // 🧬 SINCRONIZACIÓN CRÍTICA: Actualizar la tabla principal 'books' e index_status
        await db.execute({
            sql: "UPDATE books SET title = ?, author = ?, index_status = 'processing' WHERE id = ?",
            args: [dna.title, dna.author || '', bookId]
        });
    } catch (e) {
        console.error(`[Pipeline] Falló parseo de DNA para ${bookId}:`, e.message);
        throw new Error(`JSON de DNA inválido: ${e.message}`);
    }
}

async function processIndexing(userId, bookId, jobId) {
    await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Iniciando indexación via MCP Client (Protocolo Estándar)...");
    
    try {
        const userIdClean = userId || 'default';
        const userBooksDir = path.join(__dirname, '..', 'books', userIdClean);

        // Uso del cliente MCP estándar 
        const result = await callTool('index_folder', {
            path: userBooksDir,
            use_ai_summaries: true
        });
        
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Respuesta de indexación: " + JSON.stringify(result));
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Indexación completada exitosamente.");
    } catch (e) {
        await jobLogger.log(jobId, bookId, 'INDEXING', 'error', `Fallo crítico en indexación: ${e.message}`);
        throw e;
    }
}

async function generateSocraticElements(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    
    // Generación de Provocaciones Socráticas
    const promptProvs = `Sos un profesor de élite. Basado en este libro, generá 5 preguntas socráticas desafiantes.
    JSON format: [{"provocation": "...", "difficulty": "hard"}]
    TEXTO: ${content.slice(0, 15000)}`;

    const textProvs = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(promptProvs);
        return result.response.text();
    }, { tier: 'batch', description: `socraticProvocations:${bookId}` });

    const provs = JSON.parse(textProvs.replace(/```json|```/g, '').trim());

    for (const p of provs) {
        await db.execute({
            sql: "INSERT INTO socratic_provocations (book_id, provocation, difficulty) VALUES (?, ?, ?)",
            args: [bookId, p.provocation, p.difficulty]
        });
    }
}

// --- UTILS ---

async function getBookContent(userId, bookId) {
    // Intentar primero desde raw_text en Turso (persistencia Fase 3)
    try {
        const res = await db.execute({
            sql: "SELECT content FROM book_raw WHERE book_id = ? ORDER BY chunk_index ASC",
            args: [bookId]
        });
        if (res.rows.length > 0) {
            return res.rows.map(r => r.content).join('');
        }
    } catch(e) {}

    // Fallback: leer del sistema de archivos local de la VPS
    // Necesitamos encontrar el archivo MD asociado. 
    // Por simplicidad, asumimos que recordamos el filename del job.
    const jobRes = await db.execute({
        sql: "SELECT file_name FROM enrichment_jobs WHERE book_id = ? LIMIT 1",
        args: [bookId]
    });
    
    if (jobRes.rows.length > 0) {
        const filename = jobRes.rows[0].file_name;
        // La ruta base debe coincidir con la de server.js
        const filePath = path.join(__dirname, '..', 'books', userId, filename);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf-8');
        }
    }
    
    throw new Error(`Contenido del libro ${bookId} no encontrado en DB ni en disco.`);
}

/**
 * Punto de entrada para encolar un pipeline.
 */
function startPipeline(userId, bookId, jobId) {
    return pipelineQueue.enqueue(bookId, () => runFullPipeline(userId, bookId, jobId));
}

module.exports = { startPipeline, runFullPipeline };
