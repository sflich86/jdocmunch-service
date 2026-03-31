const { keyManager } = require("./keyManager");
const { getDocIndexPath } = require("./searchRuntime");

let client = null;
let transport = null;
let isConnected = false;

// Dynamic imports for ESM-only MCP SDK
let MCPClient, StdioClientTransport;

async function getClient() {
    if (isConnected && client) return client;

    // Load ESM-only SDK components dynamically in CJS environment
    if (!MCPClient || !StdioClientTransport) {
        try {
            const sdkIndex = await import("@modelcontextprotocol/sdk/client/index.js");
            const sdkStdio = await import("@modelcontextprotocol/sdk/client/stdio.js");
            MCPClient = sdkIndex.Client;
            StdioClientTransport = sdkStdio.StdioClientTransport;
        } catch (e) {
            console.error("❌ Error importing MCP SDK (check if @modelcontextprotocol/sdk is installed):", e.message);
            throw e;
        }
    }

    const mcpEnv = { ...process.env };
    const embedProvider =
        mcpEnv.JDOCMUNCH_EMBEDDING_PROVIDER ||
        (mcpEnv.OPENAI_API_KEY || mcpEnv.OPENAI_EMBED_KEY_1 ? "openai" : "gemini");
    
    // Support multiple keys from KeyManager
    const allKeys = keyManager.loadKeys('GEMINI_LIVE_KEY');
    if (allKeys[0]) mcpEnv.GOOGLE_API_KEY = allKeys[0];
    
    mcpEnv.DOC_INDEX_PATH = getDocIndexPath(mcpEnv);
    mcpEnv.JDOCMUNCH_EMBEDDING_PROVIDER = embedProvider;
    mcpEnv.GEMINI_EMBEDDING_MODEL = mcpEnv.GEMINI_EMBEDDING_MODEL || "models/gemini-embedding-001";
    mcpEnv.OPENAI_EMBEDDING_MODEL = mcpEnv.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

    transport = new StdioClientTransport({ 
        command: "uvx", 
        args: ["--with", embedProvider === "openai" ? "jdocmunch-mcp[openai]==1.3.0" : "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
        env: {
            ...mcpEnv,
            LIBSQL_URL: process.env.DATABASE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL,
            LIBSQL_AUTH_TOKEN: process.env.DATABASE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN
        }
    });

    client = new MCPClient({ name: "jdocmunch-bridge", version: "1.0.29" }, { capabilities: {} });

    try {
        await client.connect(transport);
        isConnected = true;
        console.log("✅ MCP Client Conectado");
        return client;
    } catch (e) {
        console.error("❌ Error conectando MCP Client:", e.message);
        throw e;
    }
}

async function callTool(name, args) {
    const c = await getClient();
    try {
        return await c.callTool({ name, arguments: args });
    } catch (e) {
        console.error(`❌ Error llamando a herramienta MCP ${name}:`, e.message);
        if (e.message.includes('closed') || e.message.includes('disconnected')) {
            isConnected = false;
        }
        throw e;
    }
}

module.exports = { getClient, callTool };
