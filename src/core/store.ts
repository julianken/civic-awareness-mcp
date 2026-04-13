import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Store {
  db: Database.Database;
  close(): void;
}

const MIGRATIONS = [
  { version: 1, file: "001-init.sql" },
] as const;

function runSqlScript(db: Database.Database, sql: string): void {
  // better-sqlite3 exposes a method that runs multi-statement SQL scripts.
  // We wrap it here so tests can substitute a fake if needed.
  (db as any).exec(sql);
}

export function openStore(path: string): Store {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return { db, close: () => db.close() };
}

function applyMigrations(db: Database.Database): void {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();

  const applied = tableExists
    ? new Set(
        db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version),
      )
    : new Set<number>();

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(resolve(__dirname, "migrations", migration.file), "utf-8");
    runSqlScript(db, sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(migration.version, new Date().toISOString());
  }
}
