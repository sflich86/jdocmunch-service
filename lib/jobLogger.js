const { db } = require('./db');
class JobLogger {
    constructor() { this.buffer = []; this.flushInterval = 2000; this.maxBufferSize = 50; this.timer = null; }
    async log(jobId, bookId, step, stream, message) {
        const timestamp = new Date().toISOString();
        const cleanMsg = typeof message === 'string' ? message.trim() : JSON.stringify(message);
        const truncated = cleanMsg.length > 4000 ? cleanMsg.slice(0, 4000) + "...[truncated]" : cleanMsg;
        const workerId = process.env.HOSTNAME || 'vps-worker';
        const level = stream === 'stderr' || stream === 'error' ? 'error' : 'log';
        console[level](`[uvx][${stream}][worker=${workerId}][job=${jobId}][step=${step}] ${truncated}`);
        this.buffer.push({ job_id: jobId, book_id: bookId, step, stream, message: truncated, created_at: timestamp });
        if (this.buffer.length >= this.maxBufferSize) await this.flush();
        else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }
    async flush() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.buffer.length === 0) return;
        const batch = [...this.buffer]; this.buffer = [];
        try { for (const entry of batch) await db.execute({ sql: "INSERT INTO job_logs (job_id, book_id, step, stream, message, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: [entry.job_id, entry.book_id, entry.step, entry.stream, entry.message, entry.created_at] }); }
        catch (err) { console.error("[JobLogger] ❌ Error DB logs:", err.message); }
    }
}
module.exports = { jobLogger: new JobLogger() };
