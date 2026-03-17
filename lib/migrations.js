/**
 * Definición del esquema de base de datos para Turso (LibSQL).
 * Fase 3: Resilience & Traceability
 */

const MIGRATIONS = [
  {
    name: 'books',
    sql: `
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        user_id TEXT,
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
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        error_message TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'book_raw',
    sql: `
      CREATE TABLE IF NOT EXISTS book_raw (
        book_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'book_dna',
    sql: `
      CREATE TABLE IF NOT EXISTS book_dna (
        book_id TEXT PRIMARY KEY,
        dna_json TEXT NOT NULL,
        tokens_estimated INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'book_structure',
    sql: `
      CREATE TABLE IF NOT EXISTS book_structure (
        book_id TEXT PRIMARY KEY,
        structure_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  }
];

async function runMigrations(db) {
  console.log("[Migration] 🚀 Verificando esquema de base de datos...");
  for (const migration of MIGRATIONS) {
    try {
      await db.execute(migration.sql);
    } catch (err) {
      // Ignorar errores de columna existente si ya se agregaron manualmente
      if (err.message.includes("already exists")) continue;
      console.error(`[Migration] ❌ Error en ${migration.name}:`, err.message);
    }
  }
  
  // Retro-compatibilidad: Intentar agregar columnas si ya existen las tablas
  const fixes = [
    "ALTER TABLE books ADD COLUMN user_id TEXT",
    "ALTER TABLE enrichment_jobs ADD COLUMN retry_count INTEGER DEFAULT 0",
    "ALTER TABLE enrichment_jobs ADD COLUMN max_retries INTEGER DEFAULT 3"
  ];

  for (const fix of fixes) {
    try {
      await db.execute(fix);
    } catch (e) {
      // Silencioso si ya existen
    }
  }

  console.log("[Migration] ✅ Esquema verificado correctamente.");
}

module.exports = { runMigrations };
