/**
 * @file db.js
 * @description Cliente de base de datos SQLite local.
 * Sin dependencia de servicios externos.
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

async function createLocalClient() {
    const { createClient } = await getClientModule();
    return createClient({
        url: LOCAL_DB_PATH,
        authToken: ""
    });
}

async function initDb() {
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
    return false; // No Turso
}

module.exports = { db, tryRestoreTursoConnection };
