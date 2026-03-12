#!/usr/bin/env node
/**
 * index-books.js - Indexes local .md files via jdocmunch-mcp (JSON-RPC over stdio)
 * Usage: node index-books.js /app/books
 */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const bookPath = process.argv[2] || "/app/books";

async function main() {
    console.log(`📚 Indexing path: ${bookPath}`);
    
    const transport = new StdioClientTransport({
        command: "uvx",
        args: ["--with", "jdocmunch-mcp[gemini]", "jdocmunch-mcp"],
    });

    const client = new Client(
        { name: "jdocmunch-indexer", version: "1.0.0" },
        { capabilities: {} }
    );

    await client.connect(transport);
    console.log("✅ Connected to jdocmunch-mcp");

    // Call index_local to index the books directory
    const result = await client.callTool({
        name: "index_local",
        arguments: { 
            path: bookPath,
            use_ai_summaries: false,
            use_embeddings: true
        }
    });

    console.log("📖 Index result:");
    console.log(JSON.stringify(result, null, 2));

    // Verify by listing repos
    const repos = await client.callTool({
        name: "list_repos",
        arguments: {}
    });
    console.log("\n📂 Indexed repos:");
    console.log(JSON.stringify(repos, null, 2));

    await client.close();
    console.log("\n✅ Done! Index created successfully.");
}

main().catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
});
