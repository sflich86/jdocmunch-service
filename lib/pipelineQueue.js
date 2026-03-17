/**
 * @file pipelineQueue.js
 * @description Cola de procesamiento con concurrencia limitada.
 * Asegura que la VPS solo procese un libro pesado (indexación, ADN) a la vez
 * para evitar saturar la CPU y los límites de cuota de Gemini.
 */

class PipelineQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.maxConcurrent = 1; // Solo un libro a la vez según la recomendación
  }

  /**
   * Encola un nuevo libro para procesamiento.
   * 
   * @param {string} bookId - ID del libro
   * @param {Function} pipeline - Función asíncrona que ejecuta el pipeline completo
   * @returns {Promise<void>}
   */
  async enqueue(bookId, pipeline) {
    return new Promise((resolve, reject) => {
      console.log(`[Queue] 📥 Libro "${bookId}" encolado. Posición: ${this.queue.length + 1}. Estado actual: ${this.running ? 'PROCESANDO' : 'IDLE'}`);

      this.queue.push({
        bookId,
        execute: pipeline,
        resolve,
        reject
      });

      this.processNext();
    });
  }

  /**
   * Intenta ejecutar la siguiente tarea de la cola si no hay nada en ejecución.
   */
  async processNext() {
    if (this.running || this.queue.length === 0) return;

    this.running = true;
    const task = this.queue.shift();

    console.log(`[Queue] 🚀 Iniciando pipeline para "${task.bookId}". Pendientes en cola: ${this.queue.length}`);

    try {
      // Ejecutamos el pipeline (que ya debe tener sus propios reintentos internos)
      await task.execute();
      console.log(`[Queue] ✅ Pipeline completado para "${task.bookId}"`);
      task.resolve();
    } catch (error) {
      console.error(`[Queue] ❌ Error en el pipeline de "${task.bookId}":`, error.message);
      task.reject(error);
    } finally {
      this.running = false;
      // Pequeña pausa de seguridad antes del siguiente
      setTimeout(() => this.processNext(), 2000);
    }
  }

  /**
   * Retorna el estado de la cola para diagnóstico.
   */
  getStatus() {
    return {
      isProcessing: this.running,
      queueLength: this.queue.length,
      queuedBooks: this.queue.map(t => t.bookId)
    };
  }
}

// Singleton para la instancia de la aplicación
const pipelineQueue = new PipelineQueue();
module.exports = { pipelineQueue };
