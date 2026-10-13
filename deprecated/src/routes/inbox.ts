import { Hono } from "hono";
import { html } from "hono/html";
import { currentUser, requireUser } from "../auth.ts";
import { db } from "../db/index.ts";
import { notificationItem, unreadCount, type NotificationRow } from "../notify.ts";
import { csrfField, page } from "../views/layout.ts";

export const inbox = new Hono();
const PER = 50;

inbox.get("/inbox", requireUser, (c) => {
  const me = currentUser(c)!;
  const pg = /^\d{1,6}$/.test(c.req.query("page") ?? "") ? Math.max(1, Number(c.req.query("page"))) : 1;
  const rows = db.prepare("SELECT id, kind, text, href, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
    .all(me.id, PER + 1, (pg - 1) * PER) as NotificationRow[];
  const more = rows.length > PER;
  const shown = rows.slice(0, PER);
  return page(c, {
    title: "Inbox",
    body: html`<h1>Inbox</h1>
<form method="post" action="/inbox/read-all" class="inline">${csrfField(c)}<button type="submit" class="secondary"${unreadCount(me.id) ? "" : " disabled"}>Mark all read</button></form>
<p id="inbox-empty" class="muted"${shown.length ? " hidden" : ""}>Nothing yet. You'll hear about join requests, answers and project updates here.</p>
<ul id="inbox-list" class="notifications" data-live-topic="user:${me.id}" data-live-types="notification" data-live-mode="prepend">${shown.map(notificationItem)}</ul>
<p class="pager">${pg > 1 ? html`<a href="/inbox?page=${pg - 1}">Newer</a>` : ""} ${more ? html`<a href="/inbox?page=${pg + 1}">Older</a>` : ""}</p>`,
  });
});

inbox.get("/inbox/:id/open", requireUser, (c) => {
  const me = currentUser(c)!;
  const id = c.req.param("id");
  const n = /^\d{1,12}$/.test(id) ? db.prepare("SELECT id, href FROM notifications WHERE id = ? AND user_id = ?").get(Number(id), me.id) as { id: number; href: string } | undefined : undefined;
  if (!n) return page(c, { title: "Not found", body: html`<h1>No such notification</h1><p><a href="/inbox">Back to inbox</a></p>`, status: 404 });
  db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND read_at IS NULL").run(n.id);
  return c.redirect(n.href);
});

inbox.post("/inbox/read-all", requireUser, (c) => {
  const me = currentUser(c)!;
  db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL").run(me.id);
  return c.redirect("/inbox");
});
