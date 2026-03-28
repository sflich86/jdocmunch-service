/**
 * @file mcpRunner.js
 * @description Robust tool runner using spawn for high observability.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const { jobLogger } = require('./jobLogger');
const { getDocIndexPath } = require('./searchRuntime');

async function runMcpToolDirectly({ jobId, bookId, step, tool, args }) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timeoutMs = 15 * 60 * 1000;
        const embedProvider =
            process.env.JDOCMUNCH_EMBEDDING_PROVIDER ||
            (process.env.OPENAI_API_KEY || process.env.OPENAI_EMBED_KEY_1 ? "openai" : "gemini");
        const spawnArgs = [
            "--with",
            embedProvider === "openai" ? "jdocmunch-mcp[openai]==1.3.0" : "jdocmunch-mcp[gemini]==1.3.0",
            "jdocmunch-mcp",
            "call",
            tool,
            ...args
        ];
        
        jobLogger.log(jobId, bookId, step, 'meta', `Starting uvx ${tool} with args: ${args.join(' ')}`);

        const child = spawn('uvx', spawnArgs, {
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1',
                DOC_INDEX_PATH: getDocIndexPath(process.env),
                JDOCMUNCH_EMBEDDING_PROVIDER: embedProvider,
                GEMINI_EMBEDDING_MODEL: process.env.GEMINI_EMBEDDING_MODEL || 'models/gemini-embedding-001',
                OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
                LIBSQL_URL: process.env.DATABASE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL,
                LIBSQL_AUTH_TOKEN: process.env.DATABASE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const timer = setTimeout(() => {
            jobLogger.log(jobId, bookId, step, 'error', `[TIMEOUT] Process exceeded ${timeoutMs}ms. Killing.`);
            child.kill('SIGKILL');
        }, timeoutMs);

        const rlOut = readline.createInterface({ input: child.stdout });
        rlOut.on('line', (line) => {
            jobLogger.log(jobId, bookId, step, 'stdout', line);
        });

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
