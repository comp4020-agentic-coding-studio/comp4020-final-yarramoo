import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import { csrfToken, currentUser, requireUser } from "../auth.ts";
import { announce } from "../activity.ts";
import { publish } from "../bus.ts";
import { db, tx } from "../db/index.ts";
import { csrfField, flash, page, type Html } from "../views/layout.ts";

export const requests = new Hono();

const str = (v: unknown) => (typeof v === "string" ? v : "");
type P = { id: number; owner_id: number; recruiting: number };
type Row = {
  id: number; project_id: number; user_id: number; skill_id: number | null; message: string | null; status: string;
  created_at: string; decided_at: string | null; handle: string; display_name: string | null; skill: string | null; title: string;
};

const ROW_SQL = `SELECT r.*, u.handle, u.display_name, s.name AS skill, p.title
  FROM join_requests r JOIN users u ON u.id = r.user_id JOIN projects p ON p.id = r.project_id
  LEFT JOIN skills s ON s.id = r.skill_id`;
const getRow = (id: number) => db.prepare(`${ROW_SQL} WHERE r.id = ?`).get(id) as Row;
const pendingCount = (pid: number) => (db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE project_id = ? AND status = 'pending'").get(pid) as { n: number }).n;
const loadProject = (s: string) => (/^\d{1,12}$/.test(s) ? (db.prepare("SELECT id, owner_id, recruiting FROM projects WHERE id = ?").get(Number(s)) as P | undefined) ?? null : null);

const deny = (c: Context, msg: string, status: 400 | 403 | 404 | 409 = 400) =>
  page(c, { title: "Not allowed", body: html`<h1>${msg}</h1><p><a href="/">Back to browse</a></p>`, status });

// ---- team list (shared with the project page) ----
export function teamInner(pid: number): Html {
  const team = db.prepare(
    "SELECT u.handle, u.display_name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.role DESC, m.joined_at",
  ).all(pid) as { handle: string; display_name: string | null; role: string }[];
  return html`<ul class="team">${team.map((m) => html`<li><a href="/u/${m.handle}">${m.display_name || m.handle}</a> <span class="muted">${m.role}</span></li>`)}</ul>`;
}
export function teamList(pid: number): Html {
  return html`<div id="team" data-live-topic="project:${pid}" data-live-target="#team">${teamInner(pid)}</div>`;
}

// ---- fragments ----
function inboxRow(r: Row, csrf: string, withButtons: boolean): Html {
  return html`<li class="request" id="request-${r.id}">
<a href="/u/${r.handle}">@${r.handle}</a> ${r.skill ? html`for <strong>${r.skill}</strong>` : html`<span class="muted">general help</span>`}
<span class="muted">· ${r.created_at}${r.status !== "pending" ? html` · ${r.status}` : ""}</span>
<p class="request-message">${r.message ?? ""}</p>
${withButtons ? html`<form method="post" action="/projects/${r.project_id}/requests/${r.id}/accept" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit">Accept</button></form>
<form method="post" action="/projects/${r.project_id}/requests/${r.id}/decline" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" class="secondary">Decline</button></form>` : ""}
</li>`;
}

function myRow(c: Context, r: Row): Html {
  return html`<li class="request" id="myrequest-${r.id}"><a href="/projects/${r.project_id}">${r.title}</a> ${r.skill ? html`(${r.skill})` : ""}
<span class="badge">${r.status}</span> <span class="muted">${r.created_at}</span>
${r.status === "pending" ? html`<form method="post" action="/projects/${r.project_id}/requests/${r.id}/withdraw" class="inline">${csrfField(c)}<button type="submit" class="link">Withdraw</button></form>` : ""}</li>`;
}

// ---- project page section ----
export function joinSection(c: Context, p: P): Html {
  const me = currentUser(c);
  let inner: Html;
  if (!me) inner = html`<p><a href="/login?next=/projects/${p.id}">Log in to ask to join</a></p>`;
  else if (me.id === p.owner_id) {
    const n = pendingCount(p.id);
    inner = html`<p><a href="/projects/${p.id}/requests">Join requests inbox</a> (<span id="pending-count">${n}</span> pending)</p>`;
  } else if (db.prepare("SELECT 1 FROM members WHERE project_id = ? AND user_id = ?").get(p.id, me.id)) inner = html`<p>You're on this team</p>`;
  else {
    const pend = db.prepare(`${ROW_SQL} WHERE r.project_id = ? AND r.user_id = ? AND r.status = 'pending'`).get(p.id, me.id) as Row | undefined;
    if (pend) {
      inner = html`<p>Your request is pending${pend.skill ? html` (for ${pend.skill})` : ""}:</p><blockquote>${pend.message ?? ""}</blockquote>
<form method="post" action="/projects/${p.id}/requests/${pend.id}/withdraw">${csrfField(c)}<button type="submit">Withdraw</button></form>
<p><a href="/me/requests">My requests</a></p>`;
    } else if (!p.recruiting) inner = html`<p class="muted">Not recruiting right now</p>`;
    else {
      const open = db.prepare("SELECT s.id, s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = ? AND ps.filled_by IS NULL ORDER BY s.name").all(p.id) as { id: number; name: string }[];
      inner = html`<form method="post" action="/projects/${p.id}/requests" class="stack">${csrfField(c)}
<label>Skill you'd bring<select name="skill_id"><option value="">General help</option>${open.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>
<label>Message<textarea name="message" rows="3" maxlength="500" required></textarea></label>
<button type="submit">Ask to join</button></form>
<p><a href="/me/requests">My requests</a></p>`;
    }
  }
  return html`<section id="join"><h2>Join this project</h2>${inner}</section>`;
}

// ---- routes ----
requests.post("/projects/:id/requests", requireUser, async (c) => {
  const me = currentUser(c)!;
  const p = loadProject(c.req.param("id"));
  if (!p) return deny(c, "No such project", 404);
  const b = await c.req.parseBody();
  const message = str(b.message).replace(/\r\n/g, "\n").trim();
  if (!message || message.length > 500) return deny(c, "Message is required (500 characters max).");
  if (p.owner_id === me.id) return deny(c, "You own this project", 403);
  if (db.prepare("SELECT 1 FROM members WHERE project_id = ? AND user_id = ?").get(p.id, me.id)) return deny(c, "You're already on this team", 409);
  if (!p.recruiting) return deny(c, "Not recruiting right now", 409);
  let skillId: number | null = null;
  const sraw = str(b.skill_id);
  if (sraw) {
    const s = /^\d{1,12}$/.test(sraw) ? db.prepare("SELECT skill_id FROM project_skills WHERE project_id = ? AND skill_id = ? AND filled_by IS NULL").get(p.id, Number(sraw)) as { skill_id: number } | undefined : undefined;
    if (!s) return deny(c, "That skill isn't open on this project");
    skillId = s.skill_id;
  }
  let rid: number;
  try {
    rid = tx(() => {
      if (db.prepare("SELECT 1 FROM join_requests WHERE project_id = ? AND user_id = ? AND status = 'pending'").get(p.id, me.id)) throw new Error("dup");
      return Number(db.prepare("INSERT INTO join_requests (project_id, user_id, skill_id, message) VALUES (?,?,?,?)").run(p.id, me.id, skillId, message).lastInsertRowid);
    });
  } catch (e) {
    if (e instanceof Error && e.message === "dup") return deny(c, "You already have a pending request", 409);
    throw e;
  }
  publish(`user:${p.owner_id}`, { type: "request", html: String(await inboxRow(getRow(rid), "", true)), data: { id: rid, project_id: p.id } });
  publish(`project:${p.id}`, { type: "request-count", data: { pending: pendingCount(p.id) } });
  flash(c, "Request sent.");
  return c.redirect(`/projects/${p.id}`);
});

requests.get("/projects/:id/requests", requireUser, (c) => {
  const me = currentUser(c)!;
  const p = loadProject(c.req.param("id"));
  if (!p) return deny(c, "No such project", 404);
  if (p.owner_id !== me.id) return deny(c, "Only the owner can see join requests", 403);
  const rows = db.prepare(`${ROW_SQL} WHERE r.project_id = ? ORDER BY r.id DESC`).all(p.id) as Row[];
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending").slice(0, 20);
  const csrf = csrfToken(c);
  return page(c, {
    title: "Join requests",
    body: html`<h1>Join requests</h1><p><a href="/projects/${p.id}">Back to project</a></p>
<h2>Pending</h2>
<div data-live-topic="user:${me.id}" data-live-target="#pending" data-live-mode="prepend" data-user-id="${me.id}">
<ul id="pending" class="requests" data-csrf="${csrf}">${pending.map((r) => inboxRow(r, csrf, true))}</ul></div>
<h2>Recently decided</h2>
<ul class="requests">${decided.map((r) => inboxRow(r, csrf, false))}</ul>
<script src="/public/requests.js" defer></script>`,
  });
});

async function decide(c: Context, accept: boolean) {
  const me = currentUser(c)!;
  const p = loadProject(c.req.param("id") ?? "");
  if (!p) return deny(c, "No such project", 404);
  if (p.owner_id !== me.id) return deny(c, "Only the owner can decide requests", 403);
  const rid = c.req.param("rid") ?? "";
  const r = /^\d{1,12}$/.test(rid) ? (db.prepare("SELECT id, user_id, skill_id, status FROM join_requests WHERE id = ? AND project_id = ?").get(Number(rid), p.id) as { id: number; user_id: number; skill_id: number | null; status: string } | undefined) : undefined;
  if (!r) return deny(c, "No such request", 404);
  const ok = tx(() => {
    const u = db.prepare("UPDATE join_requests SET status = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'").run(accept ? "accepted" : "declined", r.id);
    if (!Number(u.changes)) return false;
    if (accept) {
      db.prepare("INSERT OR IGNORE INTO members (project_id, user_id, role) VALUES (?,?,'member')").run(p.id, r.user_id);
      if (r.skill_id) db.prepare("UPDATE project_skills SET filled_by = ? WHERE project_id = ? AND skill_id = ? AND filled_by IS NULL").run(r.user_id, p.id, r.skill_id);
    }
    return true;
  });
  if (!ok) return deny(c, "That request has already been decided", 409);
  const title = (db.prepare("SELECT title FROM projects WHERE id = ?").get(p.id) as { title: string }).title;
  publish(`user:${r.user_id}`, {
    type: "decision",
    html: String(html`<p class="flash ${accept ? "ok" : "error"}">Your request to join <a href="/projects/${p.id}">${title}</a> was ${accept ? "accepted" : "declined"}.</p>`),
    data: { project_id: p.id, status: accept ? "accepted" : "declined" },
  });
  if (accept) {
    publish(`project:${p.id}`, { type: "team", html: String(await teamInner(p.id)) });
    const h = (db.prepare("SELECT handle FROM users WHERE id = ?").get(r.user_id) as { handle: string }).handle;
    announce("team-grew", { projectId: p.id, handle: h, actorId: me.id });
  }
  publish(`project:${p.id}`, { type: "request-count", data: { pending: pendingCount(p.id) } });
  flash(c, accept ? "Request accepted." : "Request declined.");
  return c.redirect(`/projects/${p.id}/requests`);
}
requests.post("/projects/:id/requests/:rid/accept", requireUser, (c) => decide(c, true));
requests.post("/projects/:id/requests/:rid/decline", requireUser, (c) => decide(c, false));

requests.post("/projects/:id/requests/:rid/withdraw", requireUser, (c) => {
  const me = currentUser(c)!;
  const p = loadProject(c.req.param("id"));
  const rid = c.req.param("rid");
  const r = p && /^\d{1,12}$/.test(rid) ? (db.prepare("SELECT id, user_id FROM join_requests WHERE id = ? AND project_id = ?").get(Number(rid), p.id) as { id: number; user_id: number } | undefined) : undefined;
  if (!p || !r) return deny(c, "No such request", 404);
  if (r.user_id !== me.id) return deny(c, "That isn't your request", 403);
  const u = db.prepare("UPDATE join_requests SET status = 'withdrawn', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'").run(r.id);
  if (!Number(u.changes)) return deny(c, "That request is no longer pending", 409);
  publish(`project:${p.id}`, { type: "request-count", data: { pending: pendingCount(p.id) } });
  flash(c, "Request withdrawn.");
  return c.redirect(`/projects/${p.id}`);
});

requests.get("/me/requests", requireUser, (c) => {
  const me = currentUser(c)!;
  const rows = db.prepare(`${ROW_SQL} WHERE r.user_id = ? ORDER BY r.id DESC`).all(me.id) as Row[];
  return page(c, {
    title: "My requests",
    body: html`<h1>My join requests</h1>
<div data-live-topic="user:${me.id}" data-live-target="#notices" data-live-mode="prepend" data-user-id="${me.id}">
<div id="notices"></div></div>
${rows.length ? html`<ul class="requests">${rows.map((r) => myRow(c, r))}</ul>` : html`<p class="muted">No requests yet.</p>`}`,
  });
});
