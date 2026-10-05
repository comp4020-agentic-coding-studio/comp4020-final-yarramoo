import { html } from "hono/html";
import { publish } from "./bus.ts";
import { isBlockedEither } from "./blocks.ts";
import { db } from "./db/index.ts";

// Personal, persistent notifications (the counterpart of the public, fleeting activity toasts).
// Kinds beyond the first five are reserved for the lobbies slice, which will call notify() itself.
export type NotifyKind =
  | "request-received" | "request-decided" | "answer-received" | "answer-accepted" | "project-update"
  | "team-formed" | "leader-vote" | "leader-elected" // reserved: lobbies
  | "report-received";

export type NotificationRow = { id: number; kind: string; text: string; href: string; created_at: string; read_at: string | null };

/** Truncate a title/handle for use in notification text. */
export const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function unreadCount(userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId) as { n: number }).n;
}

/** One inbox list item. Text is escaped by the template. Used by the page and by live events. */
export function notificationItem(n: NotificationRow) {
  return html`<li class="notification ${n.read_at ? "read" : "unread"}" id="notification-${n.id}"><a href="/inbox/${n.id}/open">${n.text}</a> <span class="muted">${n.created_at}</span></li>`;
}

/**
 * Tell `userId` something happened. Never notifies a user about their own action. Text must be built
 * only from titles and handles, never post bodies. `href` must be a same-origin path. Never throws.
 */
export function notify(userId: number, kind: NotifyKind, o: { text: string; href: string; actorId?: number }): void {
  try {
    if (o.actorId === userId) return;
    if (o.actorId != null && isBlockedEither(userId, o.actorId)) return; // blocks are silent in both directions
    if (!/^\/(?![/\\])[^\s\\]*$/.test(o.href)) return;
    const text = short(o.text, 140);
    const id = Number(db.prepare("INSERT INTO notifications (user_id, kind, text, href, actor_id) VALUES (?,?,?,?,?)").run(userId, kind, text, o.href, o.actorId ?? null).lastInsertRowid);
    const row = db.prepare("SELECT id, kind, text, href, created_at, read_at FROM notifications WHERE id = ?").get(id) as NotificationRow;
    publish(`user:${userId}`, { type: "notification", html: String(notificationItem(row)), data: { unread: unreadCount(userId), kind } });
  } catch { /* notifying must never break the request */ }
}
