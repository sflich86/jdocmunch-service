const { createClient } = require("@libsql/client");
const fs = require('fs');
require('dotenv').config({ path: 'c:/Users/Sebastián/Downloads/club-de-lectura-ai/jdocmunch-service/.env' });

const dbUrl = process.env.DATABASE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL;
const dbToken = process.env.DATABASE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN;

const db = createClient({
    url: dbUrl,
    authToken: dbToken
});

async function debug() {
    try {
        const books = await db.execute("SELECT id, title, index_status FROM books LIMIT 10");
        const jobs = await db.execute("SELECT id, book_id, status FROM enrichment_jobs LIMIT 10");
        
        const output = {
            books: books.rows,
            jobs: jobs.rows
        };
        
        fs.writeFileSync('db_debug_output.json', JSON.stringify(output, null, 2));
        console.log("Output written to db_debug_output.json");
    } catch (e) {
        console.error("DB Error:", e);
    }
}

debug();
