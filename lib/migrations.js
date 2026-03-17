/**
 * @file migrations.js
 * @description Gestor de esquema para Turso. 
 */

const MIGRATIONS = [
  {
    name: 'initial_schema',
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
  },
  {
    name: 'job_logs_table',
    sql: `
      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        book_id TEXT,
        step TEXT,
        stream TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  },
  {
    name: 'job_logs_index_1',
    sql: `CREATE INDEX IF NOT EXISTS idx_job_logs_job_created ON job_logs(job_id, created_at)`
  },
  {
    name: 'job_logs_index_2',
    sql: `CREATE INDEX IF NOT EXISTS idx_job_logs_book_created ON job_logs(book_id, created_at)`
  },
  {
    name: 'books_user_id_alter',
    sql: `ALTER TABLE books ADD COLUMN user_id TEXT`
  },
  {
    name: 'books_index_version_alter',
    sql: `ALTER TABLE books ADD COLUMN index_version INTEGER DEFAULT 2`
  }
];

async function runMigrations(db) {
  console.log("[Migration] 🚀 Verificando esquema...");
  for (const migration of MIGRATIONS) {
    try {
      await db.execute(migration.sql);
      // console.log(`[Migration] ✓ ${migration.name} OK`);
    } catch (err) {
      // Ignorar errores de "columna ya existe" o "tabla ya existe"
      if (!err.message.includes("already exists") && !err.message.includes("duplicate column")) {
        console.error(`[Migration] ⚠️ Error en ${migration.name}:`, err.message);
      }
    }
  }
  console.log("[Migration] ✅ Esquema verificado correctamente.");
}

module.exports = { runMigrations };
