/**
 * @file db.js
 * @description Cliente de base de datos Turso centralizado.
 */

const { createClient } = require("@libsql/client");
require('dotenv').config();

const dbUrl = process.env.DATABASE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || "file:/root/.local/share/jdocmunch/jdocmunch.db";
const dbToken = process.env.DATABASE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || "";

const db = createClient({
    url: dbUrl,
    authToken: dbToken
});

module.exports = { db };
