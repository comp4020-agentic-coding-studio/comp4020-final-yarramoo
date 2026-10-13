import { Hono } from "hono";
import { html, raw } from "hono/html";
import { marked } from "marked";
import { readFileSync } from "node:fs";
import { currentUser, requireUser } from "../auth.ts";
import { hasBlocked } from "../blocks.ts";
import { db } from "../db/index.ts";
import { notify } from "../notify.ts";
import { isAdmin } from "../provenance.ts";
import { REASONS, REPORT_TYPES, resolveTarget } from "../reports.ts";
import { csrfField, flash, page } from "../views/layout.ts";

export const safety = new Hono();

const file = new URL("../../SAFETY.md", import.meta.url);
const str = (v: unknown) => (typeof v === "string" ? v : "");

// Rendered per request, like /philosophy. The file is author-controlled, not user input.
safety.get("/safety", (c) =>
  page(c, { title: "Staying safe", body: html`<article class="prose">${raw(marked.parse(readFileSync(file, "utf8"), { async: false }))}</article>` }));

// ---------- report ----------

const deny = (c: Parameters<typeof page>[0], msg: string, status: 403 | 404 | 409 = 403) =>
  page(c, { title: "Report", body: html`<h1>${msg}</h1><p><a href="/">Back to browse</a></p>`, status });

function targetOf(type: string, idStr: string) {
  if (!(REPORT_TYPES as readonly string[]).includes(type) || !/^\d{1,12}$/.test(idStr)) return null;
  const id = Number(idStr);
  const t = resolveTarget(type, id);
  return t ? { id, t } : null;
}
const alreadyOpen = (reporter: number, type: string, id: number) =>
  !!db.prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'").get(reporter, type, id);

safety.get("/report", requireUser, (c) => {
  const me = currentUser(c)!;
  const type = c.req.query("type") ?? "";
  const r = targetOf(type, c.req.query("id") ?? "");
  if (!r) return deny(c, "Nothing to report there", 404);
  if (r.t.userId === me.id) return deny(c, "You can't report your own content");
  if (alreadyOpen(me.id, type, r.id)) return deny(c, "You've already reported this. Thank you, an admin will take a look.", 409);
  return page(c, {
    title: "Report",
    body: html`<h1>Report</h1>
<p class="muted">You're reporting ${r.t.label} by @${r.t.handle}. Your report goes privately to the site's admin. @${r.t.handle} isn't told. If someone is in danger, call 000. <a href="/safety">Safety page</a></p>
<form method="post" action="/report" class="stack">
  ${csrfField(c)}
  <input type="hidden" name="type" value="${type}">
  <input type="hidden" name="id" value="${r.id}">
  <label>Reason<select name="reason" required>${REASONS.map((x) => html`<option value="${x}">${x}</option>`)}</select></label>
  <label>Details (optional, private to admins)<textarea name="details" rows="4" maxlength="1000"></textarea></label>
  <button type="submit">Send report</button>
</form>`,
  });
});

safety.post("/report", requireUser, async (c) => {
  const me = currentUser(c)!;
  const b = await c.req.parseBody();
  const type = str(b.type);
  const r = targetOf(type, str(b.id));
  if (!r) return deny(c, "Nothing to report there", 404);
  if (r.t.userId === me.id) return deny(c, "You can't report your own content");
  const reason = str(b.reason);
  if (!(REASONS as readonly string[]).includes(reason)) return deny(c, "Please choose a reason", 403);
  const details = str(b.details).replace(/\r\n?/g, "\n").trim();
  if (details.length > 1000) return deny(c, "Details must be 1000 characters or fewer", 403);
  if (alreadyOpen(me.id, type, r.id)) return deny(c, "You've already reported this. Thank you, an admin will take a look.", 409);
  try {
    db.prepare("INSERT INTO reports (reporter_id, target_type, target_id, target_user_id, reason, details) VALUES (?,?,?,?,?,?)")
      .run(me.id, type, r.id, r.t.userId, reason, details || null);
  } catch {
    return deny(c, "You've already reported this. Thank you, an admin will take a look.", 409);
  }
  const admins = (db.prepare("SELECT id, handle FROM users").all() as { id: number; handle: string }[]).filter((u) => isAdmin(u));
  for (const a of admins) notify(a.id, "report-received", { text: "A new safety report needs a look", href: "/admin/reports" });
  flash(c, "Thank you. Your report has gone to the site's admin.");
  return c.redirect(r.t.url);
});

// ---------- block ----------

function blockRoute(on: boolean) {
  return async (c: Parameters<typeof page>[0]) => {
    const me = currentUser(c)!;
    const h = (c.req.param("handle") ?? "").toLowerCase();
    const u = db.prepare("SELECT id, handle FROM users WHERE handle = ?").get(h) as { id: number; handle: string } | undefined;
    if (!u) return deny(c, "No such member", 404);
    if (u.id === me.id) return deny(c, "You can't block yourself");
    if (on) db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?,?)").run(me.id, u.id);
    else db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(me.id, u.id);
    flash(c, on ? `You blocked @${u.handle}. They aren't told.` : `You unblocked @${u.handle}.`);
    return c.redirect(`/u/${u.handle}`);
  };
}
safety.post("/u/:handle/block", requireUser, blockRoute(true));
safety.post("/u/:handle/unblock", requireUser, blockRoute(false));

/** Block/Unblock + Report controls for another member's profile. */
export function profileSafety(c: Parameters<typeof csrfField>[0], viewerId: number, u: { id: number; handle: string }) {
  const blocked = hasBlocked(viewerId, u.id);
  return html`<p class="safety-actions"><a class="report-link" href="/report?type=profile&amp;id=${u.id}" rel="nofollow">Report</a>
<form method="post" action="/u/${u.handle}/${blocked ? "unblock" : "block"}" class="inline">${csrfField(c)}<button type="submit" class="link report-link">${blocked ? "Unblock" : "Block"}</button></form></p>`;
}
