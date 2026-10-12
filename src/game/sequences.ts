import { readdirSync, readFileSync } from "node:fs";
import { parseSequence } from "../engine/sequence.ts";
import type { Sequence } from "../engine/types.ts";

const dir = new URL("../../data/sequences/", import.meta.url);

// Validated once at import (so at boot); a bad sequence file stops the server.
const loaded = new Map<string, Sequence>();
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  const seq = parseSequence(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  loaded.set(seq.id, seq);
}

export function getSequence(id: string): Sequence {
  const s = loaded.get(id);
  if (!s) throw new Error(`unknown sequence "${id}"`);
  return s;
}

export const DEFAULT_SEQUENCE = "mvp";
