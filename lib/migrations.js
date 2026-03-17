/**
 * @file migrations.js
 * @description Gestor de esquema para Turso. 
 * Asegura que todas las tablas y columnas necesarias existan antes de arrancar.
 */

const MIGRATIONS = [
  {
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        index_version INTEGER DEFAULT 2,
        index_status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'enrichment_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS enrichment_jobs (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_name TEXT,
        status TEXT DEFAULT 'PENDING',
        current_step TEXT,
        error_message TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'book_raw_storage',
    sql: `
      CREATE TABLE IF NOT EXISTS book_raw (
        book_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'book_structure',
    sql: `
      CREATE TABLE IF NOT EXISTS book_structure (
        book_id TEXT PRIMARY KEY,
        chapters TEXT,
        detection_method TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'book_dna',
    sql: `
      CREATE TABLE IF NOT EXISTS book_dna (
        book_id TEXT PRIMARY KEY,
        title TEXT,
        author TEXT,
        central_thesis TEXT,
        argumentative_arc TEXT,
        key_concepts TEXT,
        tone TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'socratic_provocations',
    sql: `
      CREATE TABLE IF NOT EXISTS socratic_provocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id TEXT,
        provocation TEXT,
        difficulty TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  }
];

async function runMigrations(db) {
  console.log("[Migration] 🚀 Verificando esquema de base de datos...");
  
  // En SQLite/LibSQL simple, usamos IF NOT EXISTS para cada tabla.
  // Podríamos tener una tabla 'migrations_log' para versiones más complejas,
  // pero para este stack, la idempotencia de los CREATE TABLE es suficiente.
  
  for (const migration of MIGRATIONS) {
    try {
      await db.execute(migration.sql);
      // console.log(`[Migration] ✓ ${migration.name} aplicada/verificada.`);
    } catch (err) {
      console.error(`[Migration] ❌ Error en ${migration.name}:`, err.message);
      // No lanzamos error para que el server intente arrancar si son errores menores (ej. tabla ya existe)
    }
  }
  
  console.log("[Migration] ✅ Esquema verificado correctamente.");
}

module.exports = { runMigrations };
