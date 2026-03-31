/**
 * @file db.js
 * @description Cliente de base de datos con fallback local resiliente.
 * 
 * Prioridad de conexión:
 * 1. Turso cloud (si DATABASE_TURSO_DATABASE_URL está configurado)
 * 2. SQLite local (file:/root/.local/share/jdocmunch/jdocmunch.db)
 * 
 * Circuit breaker: si Turso falla, cae a local pero reintenta Turso
 * cada TURSO_RETRY_INTERVAL queries para restaurar la conexión cloud.
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
let tursoClient = null;
let localClient = null;
let fallbackQueryCounter = 0;
const TURSO_RETRY_INTERVAL = 50; // Reintentar Turso cada 50 queries en fallback mode

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

async function tryRestoreTursoConnection() {
    if (!tursoUrl || !tursoUrl.startsWith("libsql://")) return false;
    
    try {
        console.log("[DB] Attempting to restore Turso connection...");
        const client = await createTursoClient();
        await client.execute("SELECT 1");
        
        tursoClient = client;
        activeDb = client;
        dbSource = "turso";
        fallbackQueryCounter = 0;
        console.log("[DB] ✅ Turso connection restored");
        return true;
    } catch (err) {
        console.warn("[DB] Turso restore failed: " + err.message);
        return false;
    }
}

async function initDb() {
    if (tursoUrl && tursoUrl.startsWith("libsql://")) {
        try {
            tursoClient = await createTursoClient();
            activeDb = tursoClient;
            dbSource = "turso";
            console.log("[DB] Initialized with Turso cloud: " + tursoUrl.substring(0, 40) + "...");
        } catch (err) {
            console.warn("[DB] Turso init failed (" + err.message + "), starting with local fallback");
            localClient = await createLocalClient();
            activeDb = localClient;
            dbSource = "local-fallback";
        }
    } else {
        localClient = await createLocalClient();
        activeDb = localClient;
        dbSource = "local";
        console.log("[DB] Initialized with local SQLite: " + LOCAL_DB_PATH);
    }
}

// Resilient proxy with circuit breaker for Turso reconnection
const db = new Proxy({}, {
    get(_, prop) {
        if (prop === "source") return dbSource;
        
        // Return a proxy function that ensures DB is initialized
        return async function(...args) {
            if (!activeDb) {
                await initDb();
            }
            
            // Circuit breaker: try to restore Turso periodically
            if (dbSource === "local-fallback") {
                fallbackQueryCounter++;
                if (fallbackQueryCounter >= TURSO_RETRY_INTERVAL) {
                    fallbackQueryCounter = 0;
                    const restored = await tryRestoreTursoConnection();
                    if (restored) {
                        return await activeDb[prop](...args);
                    }
                }
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
                        if (!localClient) {
                            localClient = await createLocalClient();
                        }
                        activeDb = localClient;
                        dbSource = "local-fallback";
                        console.log("[DB] Now using local SQLite: " + LOCAL_DB_PATH);
                        return await localClient.execute(...args);
                    }
                    throw err;
                }
            }
            
            return value.apply(target, args);
        };
    }
});

module.exports = { db };
