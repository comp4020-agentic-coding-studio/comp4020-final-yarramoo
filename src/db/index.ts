import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { regionOf } from "../regions.ts";

const dataDir = process.env.DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "app.db"));
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

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f);
  return out;
}

function loadPostcodes(): void {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM postcodes").get() as { n: number }).n;
  if (n > 0) { fillRegions(); return; }
  const file = join(root, "data/postcodes.csv");
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/).slice(1).filter(Boolean);
  const ins = db.prepare("INSERT OR IGNORE INTO postcodes (postcode, locality, state, lat, lon) VALUES (?,?,?,?,?)");
  db.exec("BEGIN");
  for (const l of lines) {
    const [pc, loc, st, lat, lon] = splitCsv(l);
    ins.run(pc, loc, st, Number(lat), Number(lon));
  }
  db.exec("COMMIT");
  fillRegions();
}

/** Set postcodes.region wherever it is NULL (fresh load, or a table loaded before migration 005). */
function fillRegions(): void {
  const rows = db.prepare("SELECT postcode, state, lat, lon FROM postcodes WHERE region IS NULL").all() as { postcode: string; state: string; lat: number; lon: number }[];
  if (!rows.length) return;
  const upd = db.prepare("UPDATE postcodes SET region = ? WHERE postcode = ?");
  db.exec("BEGIN");
  for (const r of rows) upd.run(regionOf(r), r.postcode);
  db.exec("COMMIT");
}

migrate();
loadPostcodes();

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

/** Upsert comma-separated skill names; returns skill ids. Names are lowercased and trimmed. */
export function skillIds(csv: string): number[] {
  const names = [...new Set(csv.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && s.length <= 40))].slice(0, 30);
  const ins = db.prepare("INSERT OR IGNORE INTO skills (name) VALUES (?)");
  const sel = db.prepare("SELECT id FROM skills WHERE name = ?");
  return names.map((n) => {
    ins.run(n);
    return (sel.get(n) as { id: number }).id;
  });
}
