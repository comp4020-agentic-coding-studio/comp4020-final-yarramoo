import { html } from "hono/html";
import { db } from "./db/index.ts";
import type { Html } from "./views/layout.ts";

// Blocking is silent and one-directional to create, symmetric in effect: if either person has blocked the
// other, they can't send each other join requests and never notify each other. The blocker also sees the
// blocked member's answers and updates folded away. Known limitation: lobbies still form teams without
// regard to blocks.

const int = (n: number) => Math.trunc(Number(n));

/** SQL condition (a boolean expression) true when either user has blocked the other. Arguments are SQL expressions from code, never user input. */
export function blockedEitherSql(a: string, b: string): string {
  if (!/^[a-z_.]+$|^\d+$/.test(a) || !/^[a-z_.]+$|^\d+$/.test(b)) throw new Error("bad column");
  return `EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ${a} AND bl.blocked_id = ${b}) OR (bl.blocker_id = ${b} AND bl.blocked_id = ${a}))`;
}

export function isBlockedEither(a: number, b: number): boolean {
  return !!db.prepare(`SELECT 1 AS x WHERE ${blockedEitherSql(String(int(a)), String(int(b)))}`).get();
}

/** Ids this user has blocked. */
export function blockedIds(userId: number | null | undefined): Set<number> {
  if (!userId) return new Set();
  return new Set((db.prepare("SELECT blocked_id FROM blocks WHERE blocker_id = ?").all(userId) as { blocked_id: number }[]).map((r) => r.blocked_id));
}

export const hasBlocked = (blocker: number, blocked: number) =>
  !!db.prepare("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?").get(blocker, blocked);

/** Wrap content by someone the viewer blocked in a collapsed "Hidden" line. */
export function collapsed(content: Html): Html {
  return html`<details class="blocked-hidden"><summary>Hidden: you blocked this member · Show</summary>${content}</details>`;
}
