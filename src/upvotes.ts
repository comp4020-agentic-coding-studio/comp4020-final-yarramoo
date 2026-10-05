import { Hono } from "hono";
import { html } from "hono/html";
import { currentUser, requireUser } from "./auth.ts";
import { publish } from "./bus.ts";
import { db } from "./db/index.ts";
import { isHidden } from "./provenance.ts";
import { csrfField, flash, page, type Html } from "./views/layout.ts";

// Upvotes are anonymous: who upvoted is never shown, and a count is never rendered next to a person's name.
// Blocked pairs may still upvote each other's projects, since nobody can tell who did.

export const upvoteCount = (projectId: number): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM upvotes WHERE project_id = ?").get(projectId) as { n: number }).n;

const countFragment = (n: number): Html => html`<span id="upvote-count">${n}</span>`;

/** The upvote control for the project page. Team members and signed-out viewers see a plain count. */
export function upvoteSection(c: Parameters<typeof csrfField>[0], p: { id: number }): Html {
  const me = currentUser(c);
  const n = upvoteCount(p.id);
  const team = me && db.prepare("SELECT 1 FROM members WHERE project_id = ? AND user_id = ?").get(p.id, me.id);
  if (!me || team) return html`<p class="upvote"><span class="upvote-static" title="Community upvotes">▲ Upvotes · ${countFragment(n)}</span></p>`;
  const pressed = !!db.prepare("SELECT 1 FROM upvotes WHERE project_id = ? AND user_id = ?").get(p.id, me.id);
  return html`<form method="post" action="/projects/${p.id}/upvote" class="upvote">${csrfField(c)}<button type="submit" class="upvote-btn" aria-pressed="${pressed ? "true" : "false"}">▲ Upvote · ${countFragment(n)}</button></form>`;
}

export const upvotes = new Hono();

upvotes.post("/projects/:id/upvote", requireUser, (c) => {
  const idStr = c.req.param("id");
  const p = /^\d{1,12}$/.test(idStr) ? (db.prepare("SELECT id FROM projects WHERE id = ?").get(Number(idStr)) as { id: number } | undefined) : undefined;
  if (!p || isHidden("project", p.id)) return page(c, { title: "Not found", body: html`<h1>No such project</h1>`, status: 404 });
  const me = currentUser(c)!;
  if (db.prepare("SELECT 1 FROM members WHERE project_id = ? AND user_id = ?").get(p.id, me.id)) {
    return page(c, { title: "Not allowed", body: html`<h1>You can't upvote your own project</h1><p><a href="/projects/${p.id}">Back to the project</a></p>`, status: 403 });
  }
  const del = db.prepare("DELETE FROM upvotes WHERE project_id = ? AND user_id = ?").run(p.id, me.id);
  if (Number(del.changes) === 0) db.prepare("INSERT OR IGNORE INTO upvotes (project_id, user_id) VALUES (?,?)").run(p.id, me.id);
  publish(`project:${p.id}`, { type: "upvotes", html: String(countFragment(upvoteCount(p.id))), data: { target: "#upvote-count" } });
  flash(c, Number(del.changes) ? "Upvote removed." : "Upvoted.");
  return c.redirect(`/projects/${p.id}`);
});
