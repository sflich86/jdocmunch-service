async function main() {
    // Dynamic imports for ESM-only MCP SDK in CJS context
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    console.log(`📚 Indexing path: ${bookPath}`);
    
    const transport = new StdioClientTransport({
        command: "uvx",
        args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
    });

    const client = new Client(
        { name: "jdocmunch-indexer", version: "1.0.0" },
        { capabilities: {} }
    );

    await client.connect(transport);
    console.log("✅ Connected to jdocmunch-mcp");

    const REPO_NAME = "local/books";

    try {
        console.log(`🗑️ Borrando índice previo: ${REPO_NAME}...`);
        await client.callTool({
            name: "delete_index",
            arguments: { repo: REPO_NAME }
        });
        console.log("✅ Índice previo borrado.");
    } catch (e) {
        console.log("ℹ️ No existía índice previo:", e.message);
    }

    const result = await client.callTool({
        name: "index_local",
        arguments: { 
            path: bookPath,
            use_ai_summaries: false,
            use_embeddings: false
        }
    });

    console.log("📖 Index result:");
    console.log(JSON.stringify(result, null, 2));

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
