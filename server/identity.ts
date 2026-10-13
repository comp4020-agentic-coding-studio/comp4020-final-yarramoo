// Identity (plan 8, 9.1): a random 32-byte token per player, kept in the browser; the server stores only
// sha256(token). A token maps to a stable player id, so a returning player controls the same entity.
// Display names are labels: trimmed, capped, control characters stripped, and never trusted as HTML.
import { createHash, randomBytes } from "node:crypto";
import { cleanName, TOKEN_LEN } from "../shared/protocol.ts";
import type { GameDb } from "./db.ts";

/** Below the sim's MAX_PLAYERS (1024) so a registered player can always get an entity. */
export const MAX_REGISTERED = 900;
export const MAX_CREATES_PER_MINUTE = 60;
export const DEFAULT_NAME = "Wanderer";

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

export class Identity {
  private readonly db: GameDb | null;
  private readonly byHash = new Map<string, { id: number; name: string }>(); // memory-only fallback
  private nextMemId = 1;
  private windowStart = 0;
  private inWindow = 0;

  constructor(db: GameDb | null) {
    this.db = db;
  }

  get count(): number {
    return this.db ? this.db.playerCount() : this.byHash.size;
  }

  /** Register a new player. Null when over the cap or the creation rate (a flood of registrations). */
  register(rawName: unknown, nowMs: number): { token: Uint8Array; id: number; name: string } | null {
    if (nowMs - this.windowStart >= 60_000) {
      this.windowStart = nowMs;
      this.inWindow = 0;
    }
    if (++this.inWindow > MAX_CREATES_PER_MINUTE || this.count >= MAX_REGISTERED) return null;
    const name = cleanName(typeof rawName === "string" ? rawName : "") || DEFAULT_NAME;
    const token = new Uint8Array(randomBytes(TOKEN_LEN));
    const id = this.insert(name, sha256Hex(token));
    return { token, id, name };
  }

  private insert(name: string, hash: string): number {
    if (this.db) return this.db.createPlayer(name, hash);
    const id = this.nextMemId++;
    this.byHash.set(hash, { id, name });
    return id;
  }

  /**
   * HELLO's token -> a player. A known token gives its player. An all-zero (missing) token gets a fresh,
   * unclaimable player with a default name (the client never learns a token for it, so it is for tests and
   * odd clients). A non-zero token nobody holds (the database was reset) is refused (`"unknown"`), so the
   * client re-registers instead of silently becoming a new player on every visit.
   */
  resolve(token: Uint8Array): { id: number; name: string; fresh: boolean } | "unknown" | null {
    if (!isZero(token)) {
      const h = sha256Hex(token);
      const found = this.db ? this.db.playerByTokenHash(h) : this.byHash.get(h);
      if (found) {
        const name = "displayName" in found ? found.displayName : found.name;
        if (this.db) this.db.touchPlayer(found.id);
        return { id: found.id, name, fresh: false };
      }
    }
    if (!isZero(token)) return "unknown";
    if (this.count >= MAX_REGISTERED) return null;
    // A fresh player whose token nobody holds: random hash, so it can never be claimed.
    const name = DEFAULT_NAME;
    const id = this.insert(name, sha256Hex(new Uint8Array(randomBytes(TOKEN_LEN))));
    return { id, name, fresh: true };
  }
}
