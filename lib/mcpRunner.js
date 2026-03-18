/**
 * @file mcpRunner.js
 * @description Robust tool runner using spawn for high observability.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const { jobLogger } = require('./jobLogger');

/**
 * Runs a tool via uvx with full observability.
 */
async function runMcpToolDirectly({ jobId, bookId, step, tool, args }) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timeoutMs = 15 * 60 * 1000; // 15 minutes (Expert Condition 6)
        
        // Prepare final args for uvx
        // Example tool command: uvx --with jdocmunch-mcp jdocmunch-mcp call index_local ...
        const spawnArgs = ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp", "call", tool, ...args];
        
        jobLogger.log(jobId, bookId, step, 'meta', `Starting uvx ${tool} with args: ${args.join(' ')}`);

        const child = spawn('uvx', spawnArgs, {
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1', // Expert Condition 2
                GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2-preview',
                EMBEDDING_MODEL: 'gemini-embedding-2-preview',
                JCODEMUNCH_EMBEDDING_MODEL: 'gemini-embedding-2-preview',
                // Propagación de credenciales para Turso
                LIBSQL_URL: process.env.DATABASE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL,
                LIBSQL_AUTH_TOKEN: process.env.DATABASE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const timer = setTimeout(() => {
            jobLogger.log(jobId, bookId, step, 'error', `[TIMEOUT] Process exceeded ${timeoutMs}ms. Killing.`);
            child.kill('SIGKILL');
        }, timeoutMs);

        // Standard Output (Expert Condition 9)
        const rlOut = readline.createInterface({ input: child.stdout });
        rlOut.on('line', (line) => {
            jobLogger.log(jobId, bookId, step, 'stdout', line);
        });

        // Standard Error
        const rlErr = readline.createInterface({ input: child.stderr });
        rlErr.on('line', (line) => {
            jobLogger.log(jobId, bookId, step, 'stderr', line);
        });

        child.on('error', async (err) => {
            await jobLogger.log(jobId, bookId, step, 'error', `Spawn error: ${err.stack || err.message}`);
            clearTimeout(timer);
            reject(err);
        });

        child.on('close', async (code, signal) => {
            clearTimeout(timer);
            const durationMs = Date.now() - startedAt;
            const meta = `closed code=${code} signal=${signal} durationMs=${durationMs}`;
            await jobLogger.log(jobId, bookId, step, 'meta', meta);

            if (code === 0) {
                resolve({ code, signal, durationMs });
            } else {
                reject(new Error(`uvx exited with code=${code} signal=${signal}`));
            }
        });
    });
}

module.exports = { runMcpToolDirectly };
