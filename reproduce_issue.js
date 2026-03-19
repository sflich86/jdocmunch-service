require("dotenv").config();
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require("path");

async function reproduce() {
    const transport = new StdioClientTransport({
        command: "uvx",
        args: ["--with", "jdocmunch-mcp[gemini]==1.3.0", "jdocmunch-mcp"],
        env: {
            ...process.env,
            GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2-preview'
        }
    });

    const client = new Client(
        { name: "reproduction", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        await client.connect(transport);
        console.log("Connected to MCP");

        // 1. List repos
        const reposRes = await client.callTool({
            name: "list_repos",
            arguments: {}
        });
        console.log("Repos:", reposRes.content[0].text);

        // 2. Search in local/admin (assuming this was the repo created)
        const REPO = "local/admin";
        const query = "miedo";
        
        console.log(`Searching in ${REPO} for "${query}"...`);
        const searchResult = await client.callTool({
            name: "search_sections",
            arguments: { repo: REPO, query: query, max_results: 5 }
        });
        
        console.log("Search Result RAW:", searchResult.content[0].text);
        const searchData = JSON.parse(searchResult.content[0].text);

        if (searchData.results && searchData.results.length > 0) {
            console.log(`Found ${searchData.results.length} results.`);
            const firstResult = searchData.results[0];
            console.log("First result ID:", firstResult.id);

            // 3. Get Section
            const sectionResult = await client.callTool({
                name: "get_section",
                arguments: { repo: REPO, section_id: firstResult.id }
            });
            
            console.log("Section Result RAW:", sectionResult.content[0].text);
            const sectionData = JSON.parse(sectionResult.content[0].text);
            console.log("Keys in sectionData:", Object.keys(sectionData));
            console.log("sectionData.content:", sectionData.content);
            console.log("sectionData.text:", sectionData.text);
        } else {
            console.log("No results found in " + REPO);
        }

    } catch (err) {
        console.error("Error:", err.message);
    } finally {
        process.exit(0);
    }
}

reproduce();
