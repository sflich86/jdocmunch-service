async function diagnostic() {
    // Dynamic imports for ESM-only MCP SDK in CJS context
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const transport = new StdioClientTransport({
        command: "uvx",
        args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
        env: {
            ...process.env,
            GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001'
        }
    });

    const client = new Client(
        { name: "reproduction", version: "1.0.0" },
        { capabilities: {} }
    );

    await client.connect(transport);
    console.log("Connected to MCP");

    const REPO = "local/holographic-lagoon";
    const query = "consecuencias emocionales";

    // 1. Search
    const searchResult = await client.callTool({
        name: "search_sections",
        arguments: { repo: REPO, query: query, max_results: 1 }
    });
    const searchData = JSON.parse(searchResult.content[0].text);
    console.log("Search Result ID:", searchData.results[0]?.id);

    if (searchData.results[0]) {
        // 2. Get Section
        const sectionResult = await client.callTool({
            name: "get_section",
            arguments: { repo: REPO, section_id: searchData.results[0].id }
        });
        console.log("RAW Section Content:", sectionResult.content[0].text);
        const sectionData = JSON.parse(sectionResult.content[0].text);
        console.log("Keys in sectionData:", Object.keys(sectionData));
    }

    process.exit(0);
}

diagnostic().catch(console.error);
