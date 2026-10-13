import { html } from "hono/html";
import { db } from "./db/index.ts";

// Clearly labelled sample content. Accounts named example_* are only creatable by the seed script
// (via a secret header), are badged everywhere, and are left out of /provenance.json and live toasts.
export const isExampleHandle = (h: string | null | undefined): boolean => !!h && h.startsWith("example_");

export const isExampleUser = (id: number | null | undefined): boolean => {
  if (id == null) return false;
  const r = db.prepare("SELECT handle FROM users WHERE id = ?").get(id) as { handle: string } | undefined;
  return isExampleHandle(r?.handle);
};

/** True when the request is allowed to create example_* accounts. */
export function seedKeyOk(header: string | undefined): boolean {
  const key = process.env.EXAMPLE_SEED_KEY ?? "";
  return key.length >= 16 && header === key;
}

export const exampleBadge = (handle: string | null | undefined) =>
  isExampleHandle(handle) ? html` <span class="badge example-badge">Example post</span>` : "";

/** SQL: user ids of example accounts. */
export const EXAMPLE_USER_IDS = "(SELECT id FROM users WHERE handle LIKE 'example\\_%' ESCAPE '\\')";
