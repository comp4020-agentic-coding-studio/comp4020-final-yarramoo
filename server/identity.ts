// Identity (plan 8, 9.1): a random 32-byte token per player, kept in the browser; the server stores only
// sha256(token). A token maps to a stable player id, so a returning player controls the same entity.
// Display names are labels: trimmed, capped, control characters stripped, and never trusted as HTML.
import { createHash, randomBytes } from "node:crypto";
import { cleanName, TOKEN_LEN } from "../shared/protocol.ts";
import type { GameDb } from "./db.ts";
import type { EventLog } from "./log.ts";

/** Below the sim's MAX_PLAYERS (1024) so a registered player can always get an entity. */
export const MAX_REGISTERED = 900;
export const MAX_CREATES_PER_MINUTE = 60;
/** A registration that has not joined within this long is evicted. A real player registers and joins in seconds. */
export const EVICT_GRACE_MS = 10 * 60_000;
export const DEFAULT_NAME = "Wanderer";

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

export class Identity {
  private readonly db: GameDb | null;
  private readonly byHash = new Map<string, { id: number; name: string }>(); // memory-only fallback
  private nextMemId = 1;
  private windowStart = 0;
  private inWindow = 0;

  private readonly elog?: EventLog;

  constructor(db: GameDb | null, log?: EventLog) {
    this.db = db;
    this.elog = log;
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
    if (++this.inWindow > MAX_CREATES_PER_MINUTE) return null;
    if (this.count >= MAX_REGISTERED) {
      const n = this.evictUnjoined(Date.now());
      if (n) this.elog?.event("identity.evicted", { evicted: n, reason: "registration cap" }, "warn");
      if (this.count >= MAX_REGISTERED) return null;
    }
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
   * HELLO's token -> a player. A known token gives its player. Anything else is refused: "unknown" for a
   * token nobody holds (the database was reset; the client re-registers) and for a missing (all-zero) one
   * (a client must register via POST /api/players first, which is rate limited; a zero token used to mint a
   * permanent player per HELLO, review-m4a S1).
   */
  resolve(token: Uint8Array, touch = false): { id: number; name: string } | "unknown" {
    if (isZero(token)) return "unknown";
    const h = sha256Hex(token);
    const found = this.db ? this.db.playerByTokenHash(h) : this.byHash.get(h);
    if (!found) return "unknown";
    const name = "displayName" in found ? found.displayName : found.name;
    // Only a game-world player's HELLO counts as joining (D-069: joined means it owns a game entity).
    if (this.db && touch) this.db.touchPlayer(found.id);
    return { id: found.id, name };
  }

  /**
   * Eviction rule (D-069): a registration that never joined is deleted `graceMs` after it was created. It has
   * no entity in the sim, so deleting it cannot hand a stranger someone's inventory. Registrations that joined
   * are kept forever, because their entity persists in the world and its id must stay theirs.
   */
  evictUnjoined(nowMs: number, graceMs = EVICT_GRACE_MS): number {
    return this.db ? this.db.evictUnjoined(nowMs - graceMs) : 0;
  }
}
