/**
 * @file db.js
 * @description Cliente de base de datos con fallback local resiliente.
 * 
 * Prioridad de conexión:
 * 1. Turso cloud (si DATABASE_TURSO_DATABASE_URL está configurado)
 * 2. SQLite local (file:/root/.local/share/jdocmunch/jdocmunch.db)
 * 
 * Si Turso cloud falla en la primera query, se hace fallback automático
 * a la DB local y se loggea un warning.
 */

let clientModule = null;

async function getClientModule() {
    if (!clientModule) {
        const mod = await import("@libsql/client");
        clientModule = mod;
    }
    return clientModule;
}

require('dotenv').config();

const LOCAL_DB_PATH = "file:/root/.local/share/jdocmunch/jdocmunch.db";

const tursoUrl = process.env.DATABASE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.DATABASE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || "";

let activeDb = null;
let dbSource = "uninitialized";

async function createTursoClient() {
    const { createClient } = await getClientModule();
    return createClient({
        url: tursoUrl,
        authToken: tursoToken
    });
}

async function createLocalClient() {
    const { createClient } = await getClientModule();
    return createClient({
        url: LOCAL_DB_PATH,
        authToken: ""
    });
}

async function initDb() {
    if (tursoUrl && tursoUrl.startsWith("libsql://")) {
        activeDb = await createTursoClient();
        dbSource = "turso";
        console.log("[DB] Initialized with Turso cloud: " + tursoUrl.substring(0, 40) + "...");
    } else {
        activeDb = await createLocalClient();
        dbSource = "local";
        console.log("[DB] Initialized with local SQLite: " + LOCAL_DB_PATH);
    }
}

// Resilient proxy that falls back to local DB on Turso failures
const db = new Proxy({}, {
    get(_, prop) {
        if (prop === "source") return dbSource;
        
        // Return a proxy function that ensures DB is initialized
        return async function(...args) {
            if (!activeDb) {
                await initDb();
            }
            
            const target = activeDb;
            const value = target[prop];
            
            if (typeof value !== "function") return value;
            
            // Wrap execute() with fallback logic
            if (prop === "execute") {
                try {
                    return await target.execute(...args);
                } catch (err) {
                    const isNetworkError = 
                        err.message.includes("getaddrinfo") ||
                        err.message.includes("ENOTFOUND") ||
                        err.message.includes("EAI_AGAIN") ||
                        err.message.includes("ECONNREFUSED") ||
                        err.message.includes("ETIMEDOUT") ||
                        err.message.includes("fetch failed");
                    
                    if (isNetworkError && dbSource === "turso") {
                        console.warn("[DB] Turso connection failed (" + err.message + "), falling back to local SQLite...");
                        activeDb = await createLocalClient();
                        dbSource = "local-fallback";
                        console.log("[DB] Now using local SQLite: " + LOCAL_DB_PATH);
                        return await activeDb.execute(...args);
                    }
                    throw err;
                }
            }
            
            return value.apply(target, args);
        };
    }
});

module.exports = { db };
