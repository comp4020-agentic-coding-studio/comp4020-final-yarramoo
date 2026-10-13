import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import { currentUser } from "../auth.ts";
import { db } from "../db/index.ts";
import { isAdmin, labelOf } from "../provenance.ts";
import { resolveTarget } from "../reports.ts";
import { csrfField, flash, page } from "../views/layout.ts";

// Admin review of behaviour signals. Everything here answers 404 to non-admins so the page's
// existence is not revealed. Signals are hints for a human to look at, never verdicts.
export const admin = new Hono();

const TYPES = ["question", "answer", "project", "update", "profile"];
const SHOWS = ["unreviewed", "hidden", "all"] as const;

type Row = {
  target_type: string; target_id: number; prose_chars: number | null; pasted_prose_chars: number | null; active_ms: number | null;
  deletions: number | null; paste_events: number | null; score: number | null; hidden: number; reviewed: number; created_at: string;
};
type Info = { url: string; label: string; handle: string };

function describe(r: Row): Info | undefined {
  const id = r.target_id;
  if (r.target_type === "question") {
    const q = db.prepare("SELECT q.title, u.handle FROM questions q JOIN users u ON u.id = q.author_id WHERE q.id = ?").get(id) as { title: string; handle: string } | undefined;
    return q && { url: `/questions/${id}`, label: q.title, handle: q.handle };
  }
  if (r.target_type === "answer") {
    const a = db.prepare("SELECT a.question_id, u.handle FROM answers a JOIN users u ON u.id = a.author_id WHERE a.id = ?").get(id) as { question_id: number; handle: string } | undefined;
    return a && { url: `/questions/${a.question_id}#answer-${id}`, label: "answer", handle: a.handle };
  }
  if (r.target_type === "project") {
    const p = db.prepare("SELECT p.title, u.handle FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?").get(id) as { title: string; handle: string } | undefined;
    return p && { url: `/projects/${id}`, label: p.title, handle: p.handle };
  }
  if (r.target_type === "profile") {
    const u = db.prepare("SELECT handle FROM users WHERE id = ?").get(id) as { handle: string } | undefined;
    return u && { url: `/u/${u.handle}`, label: "profile background", handle: u.handle };
  }
  const up = db.prepare("SELECT up.project_id, u.handle FROM updates up JOIN users u ON u.id = up.author_id WHERE up.id = ?").get(id) as { project_id: number; handle: string } | undefined;
  return up && { url: `/projects/${up.project_id}#update-${id}`, label: "update", handle: up.handle };
}

const gate = (c: Context) => (isAdmin(currentUser(c)) ? null : c.notFound());
const showOf = (v: unknown) => ((SHOWS as readonly string[]).includes(String(v)) ? String(v) : "unreviewed");

admin.get("/admin/signals", (c) => {
  const denied = gate(c);
  if (denied) return denied;
  const show = showOf(c.req.query("show"));
  const where = show === "hidden" ? "WHERE hidden = 1" : show === "all" ? "" : "WHERE reviewed = 0 AND hidden = 0";
  const rows = db.prepare(`SELECT * FROM provenance ${where} ORDER BY score IS NULL, score DESC, created_at DESC LIMIT 200`).all() as Row[];
  const dash = "–";
  const body = rows.map((r) => {
    const info = describe(r);
    if (!info) return html``;
    const prose = r.prose_chars ?? 0;
    const ratio = r.pasted_prose_chars !== null && prose > 0 ? `${Math.round((r.pasted_prose_chars / prose) * 100)}%` : dash;
    const cpm = r.active_ms !== null && prose > 0 ? String(Math.round(prose / (Math.max(r.active_ms, 1000) / 60000))) : dash;
    const act = (name: string, label: string) => html`<form method="post" action="/admin/signals/${r.target_type}/${r.target_id}/${name}" class="inline">${csrfField(c)}<input type="hidden" name="show" value="${show}"><button type="submit" class="link">${label}</button></form>`;
    return html`<tr>
<td>${r.score === null ? dash : r.score.toFixed(2)} <span class="muted">${labelOf(r.score)}</span></td>
<td>${r.target_type}</td><td><a href="${info.url}">${info.label}</a></td><td>@${info.handle}</td>
<td>${prose}</td><td>${ratio}</td><td>${cpm}</td><td>${r.deletions ?? dash}</td><td>${r.active_ms === null ? dash : Math.round(r.active_ms / 1000) + " s"}</td>
<td>${r.created_at}</td>
<td>${r.hidden ? act("unhide", "Unhide") : html`${r.reviewed ? "" : act("review", "Mark reviewed")} ${act("hide", "Hide")}`}</td>
</tr>`;
  });
  return page(c, {
    title: "Signals",
    body: html`<h1>Signals</h1>
<p class="muted">Behaviour hints from how text was entered. A high score is a reason to look, never proof.</p>
<p><a href="/admin/reports">Reports</a></p>
<p>${SHOWS.map((s) => (s === show ? html`<strong>${s}</strong> ` : html`<a href="/admin/signals?show=${s}">${s}</a> `))}</p>
${rows.length ? html`<div style="overflow-x:auto"><table class="signals"><thead><tr><th>Score</th><th>Type</th><th>Item</th><th>Author</th><th>Prose</th><th>Pasted</th><th>cpm</th><th>Deleted</th><th>Active</th><th>Created</th><th></th></tr></thead><tbody>${body}</tbody></table></div>` : html`<p class="muted">Nothing here.</p>`}`,
  });
});

admin.post("/admin/signals/:type/:id/:action", async (c) => {
  const denied = gate(c);
  if (denied) return denied;
  const type = c.req.param("type");
  const idStr = c.req.param("id");
  const action = c.req.param("action");
  if (!TYPES.includes(type) || !/^\d{1,12}$/.test(idStr)) return c.notFound();
  const sql = action === "review" ? "UPDATE provenance SET reviewed = 1"
    : action === "hide" ? "UPDATE provenance SET hidden = 1, reviewed = 1"
    : action === "unhide" ? "UPDATE provenance SET hidden = 0, reviewed = 1" : null;
  if (!sql) return c.notFound();
  const r = db.prepare(`${sql} WHERE target_type = ? AND target_id = ?`).run(type, Number(idStr));
  if (!r.changes) return c.notFound();
  const b = await c.req.parseBody();
  return c.redirect(`/admin/signals?show=${showOf(b.show)}`);
});

// ---------- member reports ----------

type Report = { id: number; reporter_id: number; target_type: string; target_id: number; target_user_id: number; reason: string; details: string | null; status: string; created_at: string; reporter: string };

admin.get("/admin/reports", (c) => {
  const denied = gate(c);
  if (denied) return denied;
  const rows = db.prepare(
    `SELECT r.*, u.handle AS reporter FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.status = 'open' ORDER BY r.created_at, r.id LIMIT 200`,
  ).all() as Report[];
  const items = rows.map((r) => {
    const t = resolveTarget(r.target_type, r.target_id);
    const reported = (db.prepare("SELECT handle FROM users WHERE id = ?").get(r.target_user_id) as { handle: string } | undefined)?.handle ?? "?";
    const act = (name: string, label: string) => html`<form method="post" action="/admin/reports/${r.id}/${name}" class="inline">${csrfField(c)}<button type="submit" class="link">${label}</button></form>`;
    return html`<tr>
<td>${r.created_at}</td>
<td>${t ? html`<a href="${t.url}">${t.label}</a>` : html`<span class="muted">${r.target_type} (gone)</span>`}</td>
<td><a href="/u/${reported}">@${reported}</a></td>
<td>${r.reason}</td><td>${r.details ?? ""}</td><td>@${r.reporter}</td>
<td>${act("resolve", "Resolve")} ${act("hide", "Hide content")}</td>
</tr>`;
  });
  return page(c, {
    title: "Reports",
    body: html`<h1>Reports</h1>
<p class="muted">Open member reports. Private: reporters and reported members never see these. <a href="/admin/signals">Signals</a></p>
${rows.length ? html`<div style="overflow-x:auto"><table class="signals"><thead><tr><th>Received</th><th>Content</th><th>Reported</th><th>Reason</th><th>Details</th><th>Reporter</th><th></th></tr></thead><tbody>${items}</tbody></table></div>` : html`<p class="muted">No open reports.</p>`}`,
  });
});

admin.post("/admin/reports/:id/:action", (c) => {
  const denied = gate(c);
  if (denied) return denied;
  const idStr = c.req.param("id");
  const action = c.req.param("action");
  if (!/^\d{1,12}$/.test(idStr) || (action !== "resolve" && action !== "hide")) return c.notFound();
  const r = db.prepare("SELECT target_type, target_id FROM reports WHERE id = ? AND status = 'open'").get(Number(idStr)) as { target_type: string; target_id: number } | undefined;
  if (!r) return c.notFound();
  if (action === "hide") {
    const h = db.prepare("UPDATE provenance SET hidden = 1, reviewed = 1 WHERE target_type = ? AND target_id = ?").run(r.target_type, r.target_id);
    if (!h.changes) flash(c, "There was no hideable text on that item, so nothing was hidden. The report is still open.", "error");
    else flash(c, "Content hidden and report resolved.");
    if (!h.changes) return c.redirect("/admin/reports");
  } else flash(c, "Report resolved.");
  db.prepare("UPDATE reports SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(idStr));
  return c.redirect("/admin/reports");
});
