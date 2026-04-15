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
  { version: 2, file: "002-normalize-occurred-at.sql" },
  { version: 3, file: "003-occurred-at-from-actions.sql" },
  { version: 4, file: "004-hydrations-table.sql" },
  { version: 5, file: "005-fetch-log-table.sql" },
  { version: 6, file: "006-drop-hydrations.sql" },
  { version: 7, file: "007-entities-bioguide-index.sql" },
] as const;

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
    // Wrap schema change + version record in one transaction so a crash
    // between them can't leave schema_migrations out of sync with actual schema.
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    })();
  }
}
