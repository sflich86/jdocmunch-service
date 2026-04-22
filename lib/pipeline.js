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
const { callTool } = require("./mcpClient");
const { jobLogger } = require("./jobLogger");
const { getIndexedFilename } = require("./searchRuntime");
const { collectBookSectionCandidates, refreshUserSemanticIndex } = require("./semanticSearch");
const contextCoreBuilder = require("./contextCoreBuilder");
const { materializeIndexableDocuments } = require("./indexableDocs");
const { generateBookConceptStructure } = require("./bookConceptRelations");
const {
    applyCrossBookSynthesisToContextCores,
    generateCrossBookGraphSynthesis
} = require("./crossBookGraphSynthesis");
const fs = require('fs');
const path = require('path');

// —— 🧬 Dynamic Import para @google/generative-ai —————————————————
let GoogleGenerativeAI;
async function loadGenerativeAI() {
    if (!GoogleGenerativeAI) {
        try {
            const mod = await import("@google/generative-ai");
            GoogleGenerativeAI = mod.GoogleGenerativeAI;
        } catch (e) {
            console.error("[Pipeline] ❌ Falló la carga de @google/generative-ai:", e.message);
        }
    }
}
async function getGoogleGenAI(apiKey) {
    await loadGenerativeAI();
    if (!GoogleGenerativeAI) throw new Error("GoogleGenerativeAI module not available.");
    return new GoogleGenerativeAI(apiKey);
}

function getUserRepo(userId) {
    const clean = userId || "default";
    return "local/" + clean;
}

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
    name: 'Compendio Pedagógico',
    status: 'ENRICHING_PEDAGOGICAL',
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
        
        // Cambio 2: Reconciliación de Síntesis Cruzada al final de cada éxito
        try {
            console.log(`[Pipeline] 🌐 Iniciando reconciliación de Síntesis Cruzada para usuario ${userId}`);
            await generateCrossBookSynthesis(userId, jobId);
        } catch (syntErr) {
            console.error(`[Pipeline] Error no fatal en síntesis cruzada:`, syntErr.message);
        }

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
    const promptWindow = content.length > 120000
        ? `${content.slice(0, 80000)}\n\n---\n\n${content.slice(-40000)}`
        : content;
    
    const prompt = `Extrae la estructura canónica completa de este libro. No lo resumas ni lo reduzcas.

Reglas:
- Incluí TODOS los capítulos o secciones numeradas principales que aparezcan en el material.
- Conservá la numeración real del libro.
- No inventes capítulos inexistentes.
- Si el material usa partes o secciones sin número, incluí solo las que funcionen como unidades principales del libro.
- El campo "starts_with" debe contener las primeras palabras visibles de esa unidad cuando estén disponibles.
- Respondé SOLO JSON válido.

JSON format: [{"chapter_num": 1, "title": "...", "starts_with": "..."}]
TEXTO: ${promptWindow}`;

    await jobLogger.log(jobId, bookId, 'DETECTING_STRUCTURE', 'meta', "Llamando a Gemini para detección de estructura...");
    const text = await callGemini(async (apiKey) => {
        const genAI = await getGoogleGenAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `detectStructure:${bookId}` });

    // Hardened JSON Cleaning
    const cleaned = text.replace(/```json|```/g, '').replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim();
    try {
        const detectedChapters = JSON.parse(cleaned);
        const structureArtifact = contextCoreBuilder.buildCanonicalStructureArtifact({
            detectedChapters: detectedChapters,
            content: content,
            detectionMethod: 'llm_outline_canonicalized_v1'
        });
        await jobLogger.log(
            jobId,
            bookId,
            'DETECTING_STRUCTURE',
            'meta',
            `Estructura canónica generada con ${structureArtifact.chapters.length} entradas; maxChapter=${structureArtifact.health.maxChapterNumber || 'n/a'}; incomplete=${structureArtifact.health.possiblyIncomplete ? 'yes' : 'no'}.`
        );
        await db.execute({
            sql: "INSERT OR REPLACE INTO book_structure (book_id, chapters, detection_method, structure_version, structure_health_json) VALUES (?, ?, ?, ?, ?)",
            args: [
                bookId,
                JSON.stringify(structureArtifact.chapters),
                structureArtifact.detectionMethod,
                structureArtifact.structureVersion,
                JSON.stringify(structureArtifact.health)
            ]
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
        const genAI = await getGoogleGenAI(apiKey);
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
        const rawContent = await getBookContent(userIdClean, bookId);
        const chapters = await getBookStructureChapters(bookId);
        const jobRes = await db.execute({
            sql: "SELECT file_name FROM enrichment_jobs WHERE book_id = ? LIMIT 1",
            args: [bookId]
        });
        
        let filename = `${bookId}.md`;
        if (jobRes.rows.length > 0 && jobRes.rows[0].file_name) {
            filename = getIndexedFilename(jobRes.rows[0].file_name, bookId);
        }
        
        const docs = materializeIndexableDocuments({
            userDir: userBooksDir,
            bookId: bookId,
            filename: filename,
            content: rawContent,
            chapters: chapters
        });
        await jobLogger.log(
            jobId,
            bookId,
            'INDEXING',
            'meta',
            `Documentos indexables materializados: ${docs.length} (${docs.map(function(doc) { return doc.docPath; }).join(", ")})`
        );

        const repoName = getUserRepo(userIdClean);
        await jobLogger.log(jobId, bookId, 'INDEXING', 'meta', `Indexing in repo: ${repoName}`);

        // Uso del nuevo bridge MCP (v1.0.42)
        await callTool('index_local', {
            path: userBooksDir,
            repo: repoName,
            use_embeddings: true, use_ai_summaries: true
        });

        const semanticResult = await refreshUserSemanticIndex(userIdClean, {
            env: process.env,
            booksDir: path.join(__dirname, '..', 'books'),
            docPaths: Array.from(new Set(docs.map(function(doc) { return doc.docPath; })))
        });
        await jobLogger.log(
            jobId,
            bookId,
            'INDEXING',
            'meta',
            `Embeddings actualizados con ${semanticResult.embedding_model} para ${semanticResult.sections} secciones (${semanticResult.embedded_sections} nuevas, ${semanticResult.reused_sections} reutilizadas, ${semanticResult.skipped_sections} omitidas).`
        );

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
        const genAI = await getGoogleGenAI(apiKey);
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

    const userBooksDir = path.join(__dirname, '..', 'books', userId || 'default');
    if (fs.existsSync(userBooksDir)) {
        const siblingDocs = fs.readdirSync(userBooksDir)
            .filter(function(name) {
                return String(name || '').indexOf(String(bookId || '')) === 0 && /\.md$/i.test(name);
            })
            .sort();
        if (siblingDocs.length > 0) {
            return siblingDocs
                .map(function(name) {
                    return fs.readFileSync(path.join(userBooksDir, name), 'utf-8');
                })
                .join('\n\n');
        }
    }
    
    throw new Error(`Contenido del libro ${bookId} no encontrado en DB ni en disco.`);
}

async function getBookStructureChapters(bookId) {
    const structureRes = await db.execute({
        sql: "SELECT chapters FROM book_structure WHERE book_id = ? LIMIT 1",
        args: [String(bookId)]
    });

    if (!structureRes.rows.length || !structureRes.rows[0].chapters) {
        return [];
    }

    return JSON.parse(String(structureRes.rows[0].chapters || "[]"));
}

function collectChapterSnippets(userId, bookId, chapters) {
    const userBooksDir = path.join(__dirname, '..', 'books', userId || 'default');
    if (!fs.existsSync(userBooksDir)) {
        return [];
    }

    const chapterMap = Array.isArray(chapters) ? chapters : [];
    const files = fs.readdirSync(userBooksDir)
        .filter(function(name) {
            return String(name || '').indexOf(String(bookId || '')) === 0 && /__jdm_ch\d+__.*\.md$/i.test(name);
        })
        .sort();

    return files.map(function(name) {
        const match = name.match(/__jdm_ch(\d{3})__/i);
        const chapterNumber = match ? Number(match[1]) : undefined;
        const chapterMeta = chapterMap.find(function(chapter) {
            return Number(chapter && chapter.chapter_num) === Number(chapterNumber);
        }) || {};
        const raw = fs.readFileSync(path.join(userBooksDir, name), 'utf-8');
        return {
            chapterNumber: chapterNumber,
            chapterTitle: contextCoreBuilder.cleanText(chapterMeta.title) || undefined,
            snippet: raw.slice(0, 1800)
        };
    });
}

function collectSyntheticSectionCandidatesFromChapters(userId, bookId, chapters) {
    const userBooksDir = path.join(__dirname, '..', 'books', userId || 'default');
    if (!fs.existsSync(userBooksDir)) {
        return [];
    }

    const chapterMap = Array.isArray(chapters) ? chapters : [];
    const files = fs.readdirSync(userBooksDir)
        .filter((name) => String(name || '').indexOf(String(bookId || '')) === 0 && /__jdm_ch\d+__.*\.md$/i.test(name))
        .sort();

    const candidates = [];
    for (const name of files) {
        const match = name.match(/__jdm_ch(\d{3})__/i);
        const chapterNumber = match ? Number(match[1]) : undefined;
        const chapterMeta = chapterMap.find((chapter) => Number(chapter && chapter.chapter_num) === Number(chapterNumber)) || {};
        const chapterTitle = contextCoreBuilder.cleanText(chapterMeta.title) || undefined;
        const raw = fs.readFileSync(path.join(userBooksDir, name), 'utf-8');
        const windows = [
            { label: 'lead', start: 0 },
            { label: 'mid', start: Math.max(0, Math.floor(raw.length / 2) - 600) },
            { label: 'tail', start: Math.max(0, raw.length - 1200) },
        ];
        const seen = new Set();
        for (const window of windows) {
            const snippet = raw.slice(window.start, window.start + 1200).replace(/\s+/g, ' ').trim();
            if (!snippet || seen.has(snippet)) continue;
            seen.add(snippet);
            candidates.push({
                chapter_num: chapterNumber,
                chapter_title: chapterTitle,
                section_title: chapterTitle ? `${chapterTitle} (${window.label})` : `Capitulo ${chapterNumber || '?'} (${window.label})`,
                section_summary: snippet.slice(0, 600),
                breadcrumb: [chapterTitle || `Capitulo ${chapterNumber || '?'}`, window.label].join(' > '),
            });
        }
    }

    return candidates;
}

function deriveLocalThesisFromChapterSnippet(chapterSnippet) {
    const raw = String((chapterSnippet && chapterSnippet.snippet) || '').trim();
    if (!raw) return undefined;
    const cleaned = raw
        .replace(/^#.*$/gm, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const sentences = cleaned
        .split(/(?<=[.!?])\s+|\n+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length >= 40);
    return sentences[0] ? sentences[0].slice(0, 280) : undefined;
}

function enrichContextCoreWithChapterSnippets(contextCoreLite, chapterSnippets) {
    if (!contextCoreLite || !Array.isArray(contextCoreLite.books) || contextCoreLite.books.length === 0) {
        return contextCoreLite;
    }

    const next = JSON.parse(JSON.stringify(contextCoreLite));
    const book = next.books[0];
    const snippets = Array.isArray(chapterSnippets) ? chapterSnippets : [];
    const findSnippet = (chapterNumber, chapterTitle) =>
        snippets.find((snippet) =>
            (Number.isFinite(Number(chapterNumber)) &&
             Number.isFinite(Number(snippet && snippet.chapterNumber)) &&
             Number(chapterNumber) === Number(snippet.chapterNumber)) ||
            (contextCoreBuilder.cleanText(chapterTitle) &&
             contextCoreBuilder.cleanText(snippet && snippet.chapterTitle) &&
             contextCoreBuilder.cleanText(chapterTitle).toLowerCase() === contextCoreBuilder.cleanText(snippet.chapterTitle).toLowerCase())
        );

    book.chapterCards = (Array.isArray(book.chapterCards) ? book.chapterCards : []).map((card) => {
        const snippet = findSnippet(card.chapterNumber, card.chapterTitle);
        const thesis = deriveLocalThesisFromChapterSnippet(snippet);
        return thesis
            ? Object.assign({}, card, { localThesis: contextCoreBuilder.cleanText(card.localThesis) || thesis })
            : card;
    });

    book.topicIndex = (Array.isArray(book.topicIndex) ? book.topicIndex : []).map((topic) => {
        const firstRef = Array.isArray(topic.chapterRefs) ? topic.chapterRefs[0] : null;
        const snippet = findSnippet(firstRef && firstRef.chapterNumber, firstRef && firstRef.chapterTitle);
        const thesis = deriveLocalThesisFromChapterSnippet(snippet);
        return thesis
            ? Object.assign({}, topic, { summary: contextCoreBuilder.cleanText(topic.summary) || thesis })
            : topic;
    });

    return next;
}

async function generatePedagogicalCompendium(userId, bookId, jobId) {
    await jobLogger.log(jobId, bookId, 'ENRICHING_PEDAGOGICAL', 'meta', "Generando Compendio Pedagógico PROFUNDO...");

    const content = await getBookContent(userId, bookId);
    if (!content) throw new Error("No content found for compendium generation.");

    function getHighDensitySample(fullText, maxLength) {
        if (!fullText || fullText.length <= maxLength) return fullText;
        var blockSize = 10000;
        var numBlocks = Math.floor(fullText.length / blockSize);
        var samplePerBlock = Math.floor(maxLength / (numBlocks * 2));
        var result = "";
        for (var i = 0; i < numBlocks; i++) {
            var start = i * blockSize;
            result += "
[...]
" + fullText.slice(start, start + samplePerBlock);
            result += "
[...]
" + fullText.slice(start + blockSize - samplePerBlock, start + blockSize);
        }
        return result.slice(0, maxLength);
    }
    const bookRes = await db.execute({
        sql: "SELECT title, author FROM books WHERE id = ?",
        args: [bookId]
    });
    const book = bookRes.rows[0] || { title: "Libro Desconocido", author: "Desconocido" };

    const prompt = `Vas a leer este libro/material académico completo. Después vas a escribir algo MUY ESPECÍFICO: no un resumen, sino TU FORMA DE PENSAR sobre este material como si fueras un profesor con 20 años de experiencia enseñándolo.

Esto que escribas va a ser tu "memoria internalizada" del libro. Lo vas a tener en tu cabeza mientras enseñás, sin necesidad de consultar el libro. Por lo tanto debe capturar no el contenido literal sino tu COMPRENSIÓN PROFUNDA.

Asegurate de cubrir:
1. LA TESIS Y EL ARGUMENTO: Idea central y cómo se construye.
2. EL HILO INVISIBLE: Conexiones no obvias entre partes distantes.
3. LOS MOVIMIENTOS PEDAGÓGICOS: La mejor forma de enseñar cada concepto importante (ejemplos, analogías).
4. LAS TRAMPAS MENTALES: Qué va a entender mal un alumno típico.
5. LOS PREREQUISITOS OCULTOS: Qué se necesita entender ANTES.

Escribilo en primera persona, informal, como si le estuvieras contando a un colega profesor cómo enseñás este material.
Máximo 3000 palabras. Priorizá densidad sobre extensión.

MATERIAL COMPLETO:
TITULO: ${book.title}
AUTOR: ${book.author}
CONTENIDO: 
${getHighDensitySample(content, 95000)} // Limite de 100k chars para el prompt
`;

    const compendio = await callGemini(async (apiKey) => {
        const genAI = await getGoogleGenAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `pedagogicalCompendium:${bookId}` });

    const structureRes = await db.execute({
        sql: "SELECT chapters, structure_health_json FROM book_structure WHERE book_id = ?",
        args: [bookId]
    });
    const dnaRes = await db.execute({
        sql: "SELECT central_thesis, argumentative_arc, key_concepts FROM book_dna WHERE book_id = ?",
        args: [bookId]
    });
    const chapters = contextCoreBuilder.safeJsonParse(structureRes.rows[0] && structureRes.rows[0].chapters, []);
    const structureHealth = contextCoreBuilder.safeJsonParse(
        structureRes.rows[0] && structureRes.rows[0].structure_health_json,
        null
    );
    const dna = dnaRes.rows[0] || {};
    const sectionCandidates = await collectBookSectionCandidates(userId, bookId, {
        env: process.env,
        booksDir: path.join(__dirname, '..', 'books'),
        maxSections: Math.max(Array.isArray(chapters) ? chapters.length * 2 : 0, 36)
    });
    const syntheticSectionCandidates = collectSyntheticSectionCandidatesFromChapters(userId, bookId, chapters);
    const mergedSectionCandidates = sectionCandidates.concat(syntheticSectionCandidates);
    const chapterSnippets = collectChapterSnippets(userId, bookId, chapters);
    const conceptStructure = await generateBookConceptStructure({
        bookId: bookId,
        title: book.title,
        author: book.author,
        chapters: chapters,
        sectionCandidates: mergedSectionCandidates,
        chapterSnippets: chapterSnippets,
        centralThesis: dna.central_thesis,
        argumentativeArc: contextCoreBuilder.safeJsonParse(dna.argumentative_arc, []),
        keyConcepts: contextCoreBuilder.safeJsonParse(dna.key_concepts, []),
        pedagogicalCompendium: compendio
    });
    conceptStructure.chapterCards = (Array.isArray(conceptStructure.chapterCards) ? conceptStructure.chapterCards : []).map((card) => {
        const chapterSnippet = chapterSnippets.find((snippet) =>
            (Number.isFinite(Number(card && card.chapterNumber)) &&
             Number.isFinite(Number(snippet && snippet.chapterNumber)) &&
             Number(card.chapterNumber) === Number(snippet.chapterNumber)) ||
            (contextCoreBuilder.cleanText(card && card.chapterTitle) &&
             contextCoreBuilder.cleanText(snippet && snippet.chapterTitle) &&
             contextCoreBuilder.cleanText(card.chapterTitle).toLowerCase() === contextCoreBuilder.cleanText(snippet.chapterTitle).toLowerCase())
        );
        if (!chapterSnippet) return card;
        return Object.assign({}, card, {
            localThesis: contextCoreBuilder.cleanText(card.localThesis) || deriveLocalThesisFromChapterSnippet(chapterSnippet) || card.localThesis
        });
    });
    const contextCoreLite = contextCoreBuilder.buildContextCoreLite(bookId, {
        title: book.title,
        author: book.author,
        chapters: chapters,
        centralThesis: dna.central_thesis,
        argumentativeArc: contextCoreBuilder.safeJsonParse(dna.argumentative_arc, []),
        keyConcepts: contextCoreBuilder.safeJsonParse(dna.key_concepts, []),
        pedagogicalCompendium: compendio,
        structureHealth: structureHealth,
        conceptNodes: conceptStructure.conceptNodes,
        relationEdges: conceptStructure.relationEdges,
        pedagogicalRisks: conceptStructure.pedagogicalRisks,
        chapterCards: conceptStructure.chapterCards,
        sectionCards: conceptStructure.sectionCards,
        topicIndex: conceptStructure.topicIndex,
        differenceCards: conceptStructure.differenceCards,
        sectionCandidates: mergedSectionCandidates,
        mentalModels: conceptStructure.mentalModels,
        fundamentalDisagreements: conceptStructure.fundamentalDisagreements,
        depthProbes: conceptStructure.depthProbes
    });

    const enrichedContextCoreLite = enrichContextCoreWithChapterSnippets(contextCoreLite, chapterSnippets);

    await db.execute({
        sql: "UPDATE books SET pedagogical_compendium = ?, context_core_json = ? WHERE id = ?",
        args: [compendio, JSON.stringify(enrichedContextCoreLite), bookId]
    });

    await jobLogger.log(jobId, bookId, 'ENRICHING_PEDAGOGICAL', 'meta', "Compendio Pedagógico guardado exitosamente.");
}

async function generateCrossBookSynthesis(userId, jobId) {
    const userIdClean = userId || 'default';
    
    const booksRes = await db.execute({
        sql: "SELECT id, title, author, pedagogical_compendium, context_core_json FROM books WHERE user_id = ? AND pedagogical_compendium IS NOT NULL",
        args: [userIdClean]
    });

    if (booksRes.rows.length < 2) {
        console.log("[CrossSynthesis] Menos de 2 libros con compendio. Saltando.");
        return;
    }

    const books = booksRes.rows;
    let contextInput = "";
    const bookIds = books.map(b => b.id).sort().join(',');

    for (const b of books) {
        contextInput += `MATERIAL: "${b.title}" de ${b.author}\nCOMPRENSIÓN: ${b.pedagogical_compendium}\n\n`;
    }

    const prompt = `Estudiaste profundamente estos materiales y los conocés como la palma de tu mano:\n\n${contextInput}\nAhora escribí cómo se relacionan estos materiales entre sí. Esto es para tu uso como profesor.

Cubrí:
1. DÓNDE SE COMPLEMENTAN: Insights nuevos al combinar perspectivas.
2. DÓNDE DIVERGEN O SE CONTRADICEN: Cómo reconciliarías estas diferencias.
3. LA NARRATIVA INTEGRADA: Cómo los entrelazarías en un curso.
4. MOVIMIENTOS PEDAGÓGICOS CROSS-BOOK: Usar ejemplo de un libro para explicar concepto del otro.

Escribilo en primera persona, informal. Máximo 2000 palabras.`;

    const synthesis = await callGemini(async (apiKey) => {
        const genAI = await getGoogleGenAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }, { tier: 'batch', description: `crossSynthesis:${userIdClean}` });

    const booksWithContext = books.map(function(book) {
        return {
            id: String(book.id),
            title: String(book.title || book.id),
            author: String(book.author || ""),
            contextCore: contextCoreBuilder.safeJsonParse(book.context_core_json, null)
        };
    });
    const structuredBridges = await generateCrossBookGraphSynthesis({
        books: booksWithContext,
        synthesisText: synthesis
    });
    const updatedContextCores = applyCrossBookSynthesisToContextCores(
        booksWithContext
            .map(function(book) { return book.contextCore; })
            .filter(Boolean),
        structuredBridges
    );
    const updatedContextCoreByBookId = {};
    for (const core of updatedContextCores) {
        const coreBookId = core && core.books && core.books[0] && core.books[0].bookId;
        if (coreBookId) {
            updatedContextCoreByBookId[String(coreBookId)] = core;
        }
    }

    await db.execute({
        sql: "INSERT OR REPLACE INTO cross_book_syntheses (user_id, book_ids, synthesis_text, synthesis_json, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
        args: [userIdClean, bookIds, synthesis, JSON.stringify(structuredBridges)]
    });

    for (const book of books) {
        const nextContextCore = updatedContextCoreByBookId[String(book.id)];
        if (!nextContextCore) continue;
        await db.execute({
            sql: "UPDATE books SET context_core_json = ? WHERE id = ?",
            args: [JSON.stringify(nextContextCore), String(book.id)]
        });
    }
}

/**
 * Punto de entrada para encolar un pipeline.
 */
function startPipeline(userId, bookId, jobId) {
    return pipelineQueue.enqueue(bookId, () => runFullPipeline(userId, bookId, jobId));
}

async function rebuildPedagogicalArtifacts(userId, bookId, jobId) {
    return generatePedagogicalCompendium(userId, bookId, jobId || ("manual-rebuild-" + Date.now()));
}

module.exports = { startPipeline, runFullPipeline, rebuildPedagogicalArtifacts };
