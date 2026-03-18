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
  },
  {
    name: 'Generar Compendio Pedagógico',
    status: 'GENERATING_COMPENDIUM',
    fn: generatePedagogicalCompendium,
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
    await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', "Iniciando indexación NATIVA (Direct Spawn)...");
    
    try {
        const userIdClean = userId || 'default';
        const userBooksDir = path.join(__dirname, '..', 'books', userIdClean);

        // Ensure the directory exists
        if (!fs.existsSync(userBooksDir)) {
            fs.mkdirSync(userBooksDir, { recursive: true });
        }

        // Get the markdown content from the DB and write it to the file system
        const content = await getBookContent(userIdClean, bookId);
        const jobRes = await db.execute({
            sql: "SELECT file_name FROM enrichment_jobs WHERE book_id = ? LIMIT 1",
            args: [bookId]
        });
        
        let filename = `${bookId}.md`;
        if (jobRes.rows.length > 0 && jobRes.rows[0].file_name) {
            filename = jobRes.rows[0].file_name;
            // Ensure jdocmunch-mcp recognizes it as a document
            if (!filename.toLowerCase().endsWith('.md') && !filename.toLowerCase().endsWith('.txt')) {
                filename = filename + '.md';
            }
        }
        
        const filePath = path.join(userBooksDir, filename);
        fs.writeFileSync(filePath, content, 'utf-8');
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', `Archivo escrito en disco: ${filePath}`);

        // Uso del nuevo observable runner (Direct Spawn v1.0.32)
        await runMcpToolDirectly({
            jobId,
            bookId,
            step: 'INDEXING',
            tool: 'index_local',
            args: [
                '--path', userBooksDir,
                '--use-embeddings', 'true'
            ]
        });

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

    const cleanedText = textProvs.replace(/```json|```/g, '').trim();
    const jsonMatch = cleanedText.match(/\[[\s\S]*\]/);
    const provStr = jsonMatch ? jsonMatch[0] : cleanedText;

    let provs;
    try {
        provs = JSON.parse(provStr);
    } catch (e) {
        throw new Error(`Socratic JSON Parse Failed en: ${provStr.slice(0, 100)}...`);
    }

    for (const p of provs) {
        await db.execute({
            sql: "INSERT INTO socratic_provocations (book_id, provocation, difficulty) VALUES (?, ?, ?)",
            args: [bookId, p.provocation, p.difficulty]
        });
    }
}

async function generatePedagogicalCompendium(userId, bookId, jobId) {
    const content = await getBookContent(userId, bookId);
    
    // We can use up to 100k-500k chars for Context Window of Flash-lite
    // Let's take up to ~100k or the whole book if possible
    const fullText = content.length > 500000 ? content.slice(0, 500000) : content;

    const prompt = `Vas a leer este libro/material académico completo. Después vas a escribir algo MUY ESPECÍFICO: no un resumen, sino TU FORMA DE PENSAR sobre este material como si fueras un profesor con 20 años de experiencia enseñándolo.

Esto que escribas va a ser tu "memoria internalizada" del libro. Lo vas a tener en tu cabeza mientras enseñás, sin necesidad de consultar el libro. Por lo tanto debe capturar no el contenido literal sino tu COMPRENSIÓN PROFUNDA.

Incluí lo que naturalmente surja del material. No fuerces categorías que no apliquen. Pero asegurate de cubrir:

1. LA TESIS Y EL ARGUMENTO
¿Cuál es la idea central? ¿Cómo la construye el autor? ¿Qué visión del mundo propone? ¿Dónde es más convincente y dónde más débil?

2. EL HILO INVISIBLE
¿Cómo se conectan ideas que están en partes diferentes del material y que un alumno nunca conectaría solo? ¿Qué patrón subyacente recorre todo el libro? ¿Qué entiende alguien que ve estas conexiones que no entiende alguien que lee linealmente?

3. LOS MOVIMIENTOS PEDAGÓGICOS
Para cada concepto importante: ¿cuál es la MEJOR forma de enseñarlo? No la definición — eso lo puede buscar cualquiera. Sino: "cuando un alumno no entiende esto, lo mejor es llevarlo primero a [concepto/ejemplo Y] porque [razón pedagógica]". ¿Qué ejemplo del libro es el más poderoso para cada idea? ¿En qué orden enseñarías los temas y por qué?

4. LAS TRAMPAS MENTALES
¿Qué va a entender MAL un alumno típico? ¿Cómo lo reconocés en su forma de preguntar? ¿Cuáles son las confusiones más comunes? ¿Qué parece simple pero tiene trampas? ¿Qué parece complejo pero en el fondo es una idea simple mal explicada?

5. LOS PREREQUISITOS OCULTOS
¿Qué necesita entender alguien ANTES de poder entender las ideas más complejas del material? ¿Qué da por sentado el autor que un alumno podría no saber? ¿Dónde hay saltos lógicos que necesitan ser rellenados?

Escribilo en primera persona, informal, como si le estuvieras contando a un colega profesor cómo enseñás este material y qué trucos usás. "Mirá, este libro básicamente plantea que...", "Lo que yo hago cuando un alumno no entiende X es...", "La conexión que nadie ve es..."

Máximo 3000 palabras. Priorizá densidad sobre extensión. Cada oración debe agregar algo que no se podría deducir de un simple resumen.

MATERIAL COMPLETO:
${fullText}`;

    await jobLogger.log(jobId, bookId, 'GENERATING_COMPENDIUM', 'meta', "Iniciando generación de Compendio Pedagógico...");
    const compendiumText = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `generateCompendium:${bookId}` });

    await db.execute({
        sql: "UPDATE books SET pedagogical_compendium = ? WHERE id = ?",
        args: [compendiumText, bookId]
    });
    await jobLogger.log(jobId, bookId, 'GENERATING_COMPENDIUM', 'meta', "Compendio pedagógico generado con éxito.");

    // Disparar síntesis cruzada si corresponde
    await generateCrossBookSynthesis(userId, jobId);
}

async function generateCrossBookSynthesis(userId, currentJobId) {
    if (!userId || userId === 'default') return;

    // Get all compendiums for this user
    const res = await db.execute({
        sql: "SELECT id, title, author, pedagogical_compendium FROM books WHERE user_id = ? AND pedagogical_compendium IS NOT NULL",
        args: [userId]
    });

    if (res.rows.length < 2) {
        return; // No synthesis needed for < 2 books
    }

    await jobLogger.log(currentJobId, 'none', 'GENERATING_COMPENDIUM', 'meta', `Generando Síntesis Cruzada para ${res.rows.length} libros...`);

    let materialsPrompt = "";
    const bookIds = [];
    for (let i = 0; i < res.rows.length; i++) {
        const r = res.rows[i];
        bookIds.push(r.id);
        materialsPrompt += `MATERIAL ${i + 1}: "${r.title || 'Libro'}" de ${r.author || 'Autor desconocido'}\nTu comprensión:\n${r.pedagogical_compendium}\n\n`;
    }

    const prompt = `Estudiaste profundamente estos materiales y los conocés como la palma de tu mano:

${materialsPrompt}

Ahora escribí cómo se relacionan estos materiales entre sí. Esto es para tu uso como profesor — es tu comprensión de cómo estos materiales dialogan.

Incluí lo que naturalmente surja, pero asegurate de cubrir:

1. DÓNDE SE COMPLEMENTAN
¿Qué explica uno que el otro asume? ¿Dónde la lectura de ambos genera una comprensión más profunda que la de cada uno por separado? ¿Qué ejemplos de un material iluminan conceptos del otro?

2. DÓNDE DIVERGEN O SE CONTRADICEN
¿En qué no están de acuerdo los autores? ¿Es una contradicción real o son perspectivas compatibles? ¿Cómo reconciliarías estas diferencias para un alumno?

3. LA NARRATIVA INTEGRADA
Si tuvieras que dar un curso usando TODOS estos materiales, ¿cómo los entrelazarías? ¿Qué orden de temas propondrías tomando de cada uno? ¿Qué insights NUEVOS surgen al combinar las perspectivas?

4. MOVIMIENTOS PEDAGÓGICOS CROSS-BOOK
"Cuando explico [concepto del libro 1], me sirve traer [ejemplo del libro 2] porque..." o "El alumno que leyó [libro 1] va a tener esta confusión cuando lea [libro 2] porque..."

Escribilo en primera persona, informal. Máximo 1500 palabras.`;

    const crossText = await callGemini(async (apiKey) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `generateCrossSynthesis:${userId}` });

    await db.execute({
        sql: "INSERT OR REPLACE INTO cross_book_syntheses (user_id, book_ids, synthesis_text, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        args: [userId, JSON.stringify(bookIds), crossText]
    });

    await jobLogger.log(currentJobId, 'none', 'GENERATING_COMPENDIUM', 'meta', "Síntesis cruzada generada y guardada exitosamente.");
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
