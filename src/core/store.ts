import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Store {
  db: Database.Database;
  close(): void;
}

export function openStore(path: string, ...schemaPaths: string[]): Store {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // synchronous=NORMAL is safe under WAL (durability bounded by checkpoint,
  // not per-commit fsync) and is a meaningful write-throughput win for the
  // refresh job's bulk upserts.
  db.pragma("synchronous = NORMAL");
  // 64 MB page cache (negative = KiB). The default ~2 MB is too small for
  // the entity-resolution hot loops that repeatedly scan the entities and
  // documents tables during a refresh.
  db.pragma("cache_size = -64000");

  // Apply core schema by default (always included when no paths given).
  const paths =
    schemaPaths.length > 0
      ? schemaPaths
      : [resolve(__dirname, "schema.sql")];

  for (const sp of paths) {
    db.exec(readFileSync(sp, "utf-8"));
  }

  return { db, close: () => db.close() };
}
