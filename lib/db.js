/**
 * @file db.js
 * @description Cliente de base de datos con preferencia por Turso y fallback a SQLite local.
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

let activeDb = null;
let dbSource = "uninitialized";

function cleanText(value) {
    return String(value || "").trim();
}

function resolveTursoConfig(env = process.env) {
    const url = cleanText(env.DATABASE_TURSO_DATABASE_URL || env.TURSO_DATABASE_URL);
    const authToken = cleanText(env.DATABASE_TURSO_AUTH_TOKEN || env.TURSO_AUTH_TOKEN);
    return {
        url,
        authToken,
        enabled: Boolean(url && authToken)
    };
}

async function createTursoClient(config) {
    const { createClient } = await getClientModule();
    return createClient({
        url: config.url,
        authToken: config.authToken
    });
}

async function createLocalClient() {
    const { createClient } = await getClientModule();
    return createClient({
        url: LOCAL_DB_PATH,
        authToken: ""
    });
}

async function probeClient(client) {
    await client.execute("SELECT 1");
    return client;
}

async function connectTursoIfConfigured(env = process.env) {
    const config = resolveTursoConfig(env);
    if (!config.enabled) return null;

    const client = await createTursoClient(config);
    await probeClient(client);
    return client;
}

async function initDb() {
    try {
        const tursoDb = await connectTursoIfConfigured();
        if (tursoDb) {
            activeDb = tursoDb;
            dbSource = "turso";
            console.log("[DB] Initialized with Turso: " + resolveTursoConfig().url);
            return;
        }
    } catch (error) {
        console.error("[DB] Turso init failed, falling back to local SQLite:", error.message);
    }

    activeDb = await createLocalClient();
    dbSource = "local";
    console.log("[DB] Initialized with local SQLite: " + LOCAL_DB_PATH);
}

// Simple proxy that ensures DB is initialized
const db = new Proxy({}, {
    get(_, prop) {
        if (prop === "source") return dbSource;
        
        return async function(...args) {
            if (!activeDb) {
                await initDb();
            }
            
            const target = activeDb;
            const value = target[prop];
            
            if (typeof value !== "function") return value;
            return value.apply(target, args);
        };
    }
});

async function tryRestoreTursoConnection() {
    try {
        const tursoDb = await connectTursoIfConfigured();
        if (!tursoDb) return false;
        activeDb = tursoDb;
        dbSource = "turso";
        console.log("[DB] Turso connection restored: " + resolveTursoConfig().url);
        return true;
    } catch (error) {
        console.error("[DB] Turso restore failed:", error.message);
        return false;
    }
}

module.exports = {
    db,
    tryRestoreTursoConnection,
    resolveTursoConfig,
    probeClient
};
