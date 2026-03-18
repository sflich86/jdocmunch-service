/**
 * @file mcpClient.js
 * @description Maneja la conexión con el servidor MCP jdocmunch-mcp.
 */

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { keyManager } = require("./keyManager");

let client = null;
let transport = null;
let isConnected = false;

async function getClient() {
    if (isConnected && client) return client;

    const mcpEnv = { ...process.env };
    const allKeys = keyManager.loadKeys('GEMINI_LIVE_KEY');
    if (allKeys[0]) mcpEnv.GOOGLE_API_KEY = allKeys[0];
    mcpEnv.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2-preview';
    mcpEnv.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
    mcpEnv.JCODEMUNCH_EMBEDDING_MODEL = 'gemini-embedding-2-preview';

    transport = new StdioClientTransport({ 
        command: "uvx", 
        args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
        env: mcpEnv
    });

    client = new Client({ name: "jdocmunch-bridge", version: "1.0.29" }, { capabilities: {} });

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
        // Reset connection if it seems dead
        if (e.message.includes('closed') || e.message.includes('disconnected')) {
            isConnected = false;
        }
        throw e;
    }
}

module.exports = { getClient, callTool };
