/**
 * @file migrations.js
 * @description Gestor de esquema para Turso con blindaje de tipos TEXT.
 */

// lib/migrations.js — v1.0.40-final-repair
// All ID columns explicitly TEXT. Enrichment table dropped and recreated clean.

var migrations = [

  // ── Books ──────────────────────────────────────────────
  "CREATE TABLE IF NOT EXISTS books (" +
    "id TEXT PRIMARY KEY, " +
    "user_id TEXT, " +
    "title TEXT, " +
    "author TEXT, " +
    "filename TEXT, " +
    "source_language TEXT, " +
    "index_status TEXT NOT NULL DEFAULT 'pending', " +
    "index_version INTEGER DEFAULT 2, " +
    "created_at TEXT DEFAULT (datetime('now')), " +
    "updated_at TEXT DEFAULT (datetime('now'))" +
  ")",

  "CREATE INDEX IF NOT EXISTS idx_books_status ON books(index_status)",

  "ALTER TABLE books ADD COLUMN user_id TEXT",
  "ALTER TABLE books ADD COLUMN filename TEXT",
  "ALTER TABLE books ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))",
  "ALTER TABLE books ADD COLUMN pedagogical_compendium TEXT",
  "ALTER TABLE books ADD COLUMN context_core_json TEXT",
  "ALTER TABLE books ADD COLUMN source_language TEXT",
  // ── Book Raw Content ──────────────────────────────────
  "CREATE TABLE IF NOT EXISTS book_raw (" +
    "id TEXT PRIMARY KEY, " +
    "book_id TEXT NOT NULL, " +
    "content TEXT, " +
    "chunk_index INTEGER NOT NULL DEFAULT 0, " +
    "created_at TEXT DEFAULT (datetime('now'))" +
  ")",

  "CREATE INDEX IF NOT EXISTS idx_book_raw_book_id ON book_raw(book_id)",

  "ALTER TABLE book_raw ADD COLUMN id TEXT",
  "ALTER TABLE book_raw ADD COLUMN chunk_index INTEGER DEFAULT 0",

  // ── Enrichment Jobs ───────────────────────────────────
  // IMPORTANTE: no borrar esta tabla en cada arranque.
  // Hacerlo destruye jobs vivos/históricos y deja libros huérfanos en `processing`.
  "CREATE TABLE IF NOT EXISTS enrichment_jobs (" +
    "id TEXT PRIMARY KEY, " +
    "book_id TEXT NOT NULL, " +
    "user_id TEXT NOT NULL, " +
    "file_name TEXT, " +
    "job_type TEXT NOT NULL DEFAULT 'full', " +
    "status TEXT NOT NULL DEFAULT 'PENDING', " +
    "current_step TEXT, " +
    "progress INTEGER NOT NULL DEFAULT 0, " +
    "retry_count INTEGER DEFAULT 0, " +
    "max_retries INTEGER DEFAULT 3, " +
    "error_message TEXT, " +
    "started_at DATETIME, " +
    "completed_at DATETIME, " +
    "created_at TEXT DEFAULT (datetime('now')), " +
    "updated_at TEXT DEFAULT (datetime('now'))" +
  ")",

  "CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_book_id ON enrichment_jobs(book_id)",
  "CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON enrichment_jobs(status)",
  "ALTER TABLE enrichment_jobs ADD COLUMN user_id TEXT",
  "ALTER TABLE enrichment_jobs ADD COLUMN file_name TEXT",
  "ALTER TABLE enrichment_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'full'",
  "ALTER TABLE enrichment_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE enrichment_jobs ADD COLUMN retry_count INTEGER DEFAULT 0",
  "ALTER TABLE enrichment_jobs ADD COLUMN max_retries INTEGER DEFAULT 3",
  "ALTER TABLE enrichment_jobs ADD COLUMN started_at DATETIME",
  "ALTER TABLE enrichment_jobs ADD COLUMN completed_at DATETIME",
  "ALTER TABLE enrichment_jobs ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))",

  // ── Book Structure ────────────────────────────────────
  "CREATE TABLE IF NOT EXISTS book_structure (" +
    "book_id TEXT PRIMARY KEY, " +
    "chapters TEXT, " +
    "detection_method TEXT, " +
    "structure_version TEXT, " +
    "structure_health_json TEXT, " +
    "created_at TEXT DEFAULT (datetime('now'))" +
  ")",
  "ALTER TABLE book_structure ADD COLUMN structure_version TEXT",
  "ALTER TABLE book_structure ADD COLUMN structure_health_json TEXT",

  // ── Book DNA ──────────────────────────────────────────
  "CREATE TABLE IF NOT EXISTS book_dna (" +
    "book_id TEXT PRIMARY KEY, " +
    "title TEXT, " +
    "author TEXT, " +
    "central_thesis TEXT, " +
    "argumentative_arc TEXT, " +
    "key_concepts TEXT, " +
    "tone TEXT, " +
    "created_at TEXT DEFAULT (datetime('now'))" +
  ")",

  // ── Socratic Provocations ─────────────────────────────
  "CREATE TABLE IF NOT EXISTS socratic_provocations (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "book_id TEXT, " +
    "provocation TEXT, " +
    "difficulty TEXT, " +
    "created_at TEXT DEFAULT (datetime('now'))" +
  ")",

  // ── Job Logs ──────────────────────────────────────────
  "CREATE TABLE IF NOT EXISTS job_logs (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "job_id TEXT NOT NULL, " +
    "book_id TEXT, " +
    "step TEXT, " +
    "stream TEXT, " +
    "message TEXT, " +
    "created_at TEXT DEFAULT (datetime('now'))" +
  ")",

  "CREATE INDEX IF NOT EXISTS idx_job_logs_job_created ON job_logs(job_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_job_logs_book_created ON job_logs(book_id, created_at)",

  // ── Cross Book Syntheses ─────────────────────────────
  "CREATE TABLE IF NOT EXISTS cross_book_syntheses (" +
    "user_id TEXT PRIMARY KEY, " +
    "book_ids TEXT, " +
    "synthesis_text TEXT, " +
    "synthesis_json TEXT, " +
    "created_at TEXT DEFAULT (datetime('now')), " +
    "updated_at TEXT DEFAULT (datetime('now'))" +
  ")",
  "ALTER TABLE cross_book_syntheses ADD COLUMN synthesis_json TEXT"

];

async function runMigrations(db) {
  console.log("[MIGRATIONS] Starting schema migrations (" + migrations.length + " statements)...");

  for (var i = 0; i < migrations.length; i++) {
    try {
      await db.execute(migrations[i]);
      console.log("[MIGRATIONS] OK (" + (i + 1) + "/" + migrations.length + ")");
    } catch (err) {
      if (!err.message.includes("already exists") && !err.message.includes("duplicate column")) {
        console.log("[MIGRATIONS] WARN on statement " + (i + 1) + ": " + err.message);
      }
    }
  }

  console.log("[MIGRATIONS] Complete.");

  // Fix constraint bug for huge files chunking
  try {
    var check = await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='book_raw_legacy'");
    if (check.rows.length === 0) {
        console.log("[MIGRATIONS] Migrating book_raw to drop legacy UNIQUE constraint...");
        await db.execute("CREATE TABLE book_raw_v2 (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, content TEXT, chunk_index INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
        await db.execute("INSERT INTO book_raw_v2 (id, book_id, content, chunk_index, created_at) SELECT id, book_id, content, chunk_index, created_at FROM book_raw");
        await db.execute("ALTER TABLE book_raw RENAME TO book_raw_legacy");
        await db.execute("ALTER TABLE book_raw_v2 RENAME TO book_raw");
        await db.execute("CREATE INDEX IF NOT EXISTS idx_book_raw_book_id ON book_raw(book_id)");
        console.log("[MIGRATIONS] Constraint migration complete.");
    }
  } catch(e) {
    console.log("[MIGRATIONS] Constraint migration skipped or failed: " + e.message);
  }
}

module.exports = { runMigrations };
