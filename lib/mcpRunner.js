const { spawn } = require('child_process');
const readline = require('readline');
const { jobLogger } = require('./jobLogger');
async function runMcpToolDirectly({ jobId, bookId, step, tool, args }) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timeoutMs = 15 * 60 * 1000;
        const spawnArgs = ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp", "call", tool, ...args];
        jobLogger.log(jobId, bookId, step, 'meta', `Starting uvx ${tool}`);
        const child = spawn('uvx', spawnArgs, { env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { jobLogger.log(jobId, bookId, step, 'error', `[TIMEOUT]`); child.kill('SIGKILL'); }, timeoutMs);
        readline.createInterface({ input: child.stdout }).on('line', (l) => jobLogger.log(jobId, bookId, step, 'stdout', l));
        readline.createInterface({ input: child.stderr }).on('line', (l) => jobLogger.log(jobId, bookId, step, 'stderr', l));
        child.on('error', (e) => { clearTimeout(timer); jobLogger.log(jobId, bookId, step, 'error', e.message); reject(e); });
        child.on('close', (c, s) => { clearTimeout(timer); const d = Date.now() - startedAt; jobLogger.log(jobId, bookId, step, 'meta', `exit=${c} signal=${s} dur=${d}ms`); if (c === 0) resolve({ c, s, d }); else reject(new Error(`exit ${c}`)); });
    });
}
module.exports = { runMcpToolDirectly };
