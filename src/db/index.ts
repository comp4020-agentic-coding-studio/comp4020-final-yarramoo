import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "mission.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

const root = new URL("../..", import.meta.url).pathname;

/** Run src/db/migrations/NNN_*.sql in numeric order; PRAGMA user_version = last applied NNN. */
function migrate(): void {
  const dir = join(root, "src/db/migrations");
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (const f of files) {
    const n = parseInt(f, 10);
    if (n <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, f), "utf8"));
      db.exec(`PRAGMA user_version = ${n}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

migrate();

/** Run fn inside a transaction (rolls back on throw). */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
