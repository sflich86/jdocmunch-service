/**
 * @file jobLogger.js
 * @description Centralized logging for jobs with DB persistence and buffering.
 */

const { db } = require('./db');

class JobLogger {
    constructor() {
        this.buffer = [];
        this.flushInterval = 2000; // 2 seconds
        this.maxBufferSize = 50;
        this.timer = null;
    }

    /**
     * Log a message to console and buffer for DB persistence.
     */
    async log(jobId, bookId, step, stream, message) {
        const timestamp = new Date().toISOString();
        const cleanMsg = typeof message === 'string' ? message.trim() : JSON.stringify(message);
        
        // Truncate if too large (Expert Condition 3)
        const truncated = cleanMsg.length > 4000 ? cleanMsg.slice(0, 4000) + "...[truncated]" : cleanMsg;

        // 1. Console Output (Expert Condition 4 & 13)
        const workerId = process.env.HOSTNAME || 'vps-worker';
        const level = stream === 'stderr' || stream === 'error' ? 'error' : 'log';
        console[level](`[uvx][${stream}][worker=${workerId}][job=${jobId}][step=${step}] ${truncated}`);

        // 2. Buffer for DB
        this.buffer.push({
            job_id: jobId,
            book_id: bookId,
            step,
            stream,
            message: truncated,
            created_at: timestamp
        });

        if (this.buffer.length >= this.maxBufferSize) {
            await this.flush();
        } else if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.flushInterval);
        }
    }

    async flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.buffer.length === 0) return;

        const batch = [...this.buffer];
        this.buffer = [];

        try {
            // Bulk insert if possible, else sequential for LibSQL simplicity in this stack
            for (const entry of batch) {
                await db.execute({
                    sql: "INSERT INTO job_logs (job_id, book_id, step, stream, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    args: [entry.job_id, entry.book_id, entry.step, entry.stream, entry.message, entry.created_at]
                });
            }
        } catch (err) {
            console.error("[JobLogger] ❌ Error flushing logs to DB:", err.message);
        }
    }
}

const jobLogger = new JobLogger();
module.exports = { jobLogger };
